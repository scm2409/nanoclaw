/**
 * A provider that drops the stream mid-answer must not cost the turn.
 *
 * Measured on 2026-09-10: the gateway ended seven streamed responses with
 * `{"type":"error","error":{"type":"api_error","message":"Network connection
 * lost.","error_type":"provider_unavailable"}}` after up to 917 seconds of
 * streaming — the upstream provider hung up, not this host. The CLI surfaces it
 * as an error result, the poll loop sees the same text twice and reaches for
 * its anti-spam guard (`query.abort()`), and the abort takes the whole CLI
 * process down with it. In that one container 6 subagents were started, 5 of
 * them in the background, and only 2 ever reported: three were killed mid-work
 * with no notice to anyone.
 *
 * So the turn is resumed once instead. The session id is the same, so the
 * transcript — including everything the dropped attempt had already done —
 * carries over; only the connection is new. One retry, because a provider that
 * drops twice in a row is down rather than unlucky, and the poll loop's guard
 * should then get its turn.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

interface SdkCall {
  env: Record<string, string | undefined>;
  resume?: string;
}

const calls: SdkCall[] = [];
const attempts: unknown[][] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: (args: any) => {
    const index = calls.length;
    calls.push({ env: args.options.env, resume: args.options.resume });
    const messages = attempts[index] ?? [];
    return (async function* () {
      for (const m of messages) yield m;
    })();
  },
}));

const { ClaudeProvider } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

const PIN = { only: ['z-ai'], allow_fallbacks: true };
const GATEWAY_ENV = { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' };

/** What the CLI renders when the gateway reports provider_unavailable. */
const DROPPED = 'API Error: Network connection lost.';
const MODEL_404 = "There's an issue with the selected model (z-ai/glm-5.3-flash). It may not exist or you may not have access to it.";

const init = (sessionId: string) => ({ type: 'system', subtype: 'init', session_id: sessionId });
const errorResult = (text: string) => ({ type: 'result', subtype: 'error_during_execution', is_error: true, result: text });
const successResult = (text: string) => ({ type: 'result', subtype: 'success', result: text });

let tmp: string;
let prevHome: string | undefined;

async function collect(query: { events: AsyncIterable<unknown> }) {
  const events: Array<{ type: string; text?: string | null; isError?: boolean }> = [];
  for await (const e of query.events) events.push(e as { type: string; text?: string | null; isError?: boolean });
  return events;
}

function run() {
  const provider = new ClaudeProvider({ env: { ...GATEWAY_ENV }, agentGroupId: 'ag-test', providerPin: PIN });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  return provider.query({ prompt: 'hi', cwd: tmp });
}

beforeEach(() => {
  calls.length = 0;
  attempts.length = 0;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-stream-drop-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a dropped stream resumes instead of ending the turn', () => {
  it('retries once on the same session and keeps the pin', async () => {
    attempts.push([init('sess-1'), errorResult(DROPPED)]);
    attempts.push([init('sess-1'), successResult('<message to="user">done</message>')]);

    const events = await collect(run());

    expect(calls).toHaveLength(2);
    expect(calls[1]!.resume).toBe('sess-1');
    // Nothing is wrong with the routing here — the pin stays as it was.
    expect(calls[1]!.env.CLAUDE_CODE_EXTRA_BODY).toBe(JSON.stringify({ provider: PIN }));

    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0]!.text).toBe('<message to="user">done</message>');
    expect(results[0]!.isError).toBe(false);
  });

  it('gives up after the second drop and reports it', async () => {
    attempts.push([init('sess-1'), errorResult(DROPPED)]);
    attempts.push([init('sess-1'), errorResult(DROPPED)]);

    const events = await collect(run());

    expect(calls).toHaveLength(2);
    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0]!.isError).toBe(true);
    expect(results[0]!.text).toBe(DROPPED);
  });

  it('has its own budget, independent of the unpinned retry', async () => {
    // A stale pin and a flaky provider are different faults; surviving one
    // must not spend the other's single attempt.
    attempts.push([init('sess-1'), errorResult(MODEL_404)]);
    attempts.push([init('sess-1'), errorResult(DROPPED)]);
    attempts.push([init('sess-1'), successResult('<message to="user">done</message>')]);

    const events = await collect(run());

    expect(calls).toHaveLength(3);
    expect(calls[1]!.env.CLAUDE_CODE_EXTRA_BODY).toBeUndefined(); // pin dropped
    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0]!.text).toBe('<message to="user">done</message>');
  });

  it('leaves unrelated errors to the poll loop', async () => {
    attempts.push([init('sess-1'), errorResult('Credit balance is too low')]);

    const events = await collect(run());

    expect(calls).toHaveLength(1);
    expect(events.filter((e) => e.type === 'result')[0]!.isError).toBe(true);
  });
});
