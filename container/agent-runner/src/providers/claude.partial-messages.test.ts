/**
 * Streaming deltas must reach the poll loop, because the heartbeat is what
 * tells the host whether the agent is working — and the typing indicator the
 * user sees is driven by that heartbeat.
 *
 * `touchHeartbeat()` runs once per SDK message. Without partial messages the
 * SDK emits nothing at all between sending a request and the finished block,
 * so a long model call looks exactly like an idle container. Measured on
 * 2026-09-10: during one 62-second answer the heartbeat file was not touched
 * once, and the typing indicator went dark after the module's 15-second grace
 * window while the agent was in fact thinking the whole time.
 *
 * The stream is the same either way — this only asks for it in finer pieces,
 * so it costs no extra tokens and no extra request.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const seen: any[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: (args: any) => {
    seen.push(args.options);
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
      yield { type: 'result', subtype: 'success', result: '<message to="user">ok</message>' };
    })();
  },
}));

const { ClaudeProvider } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  seen.length = 0;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-partial-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('streaming visibility', () => {
  it('asks the SDK for partial messages', async () => {
    const provider = new ClaudeProvider({});
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp });
    for await (const _ of q.events) {
      // drain
    }
    expect(seen).toHaveLength(1);
    expect(seen[0].includePartialMessages).toBe(true);
  });

  it('translates a partial assistant message to activity only', async () => {
    // A stream event must never be mistaken for the turn's answer: it carries
    // a fragment, and treating it as a result would deliver half a sentence.
    const provider = new ClaudeProvider({});
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);

    mock.module('@anthropic-ai/claude-agent-sdk', () => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: (args: any) => {
        seen.push(args.options);
        return (async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
          yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'half a sen' } } };
          yield { type: 'result', subtype: 'success', result: '<message to="user">done</message>' };
        })();
      },
    }));
    const fresh = await import('./claude.js');
    const p2 = new fresh.ClaudeProvider({});
    p2.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const events: { type: string; text?: string | null }[] = [];
    for await (const e of p2.query({ prompt: 'hi', cwd: tmp }).events) {
      events.push(e as { type: string; text?: string | null });
    }
    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0]!.text).toBe('<message to="user">done</message>');
    // The delta showed up as activity — which is what touches the heartbeat.
    expect(events.filter((e) => e.type === 'activity').length).toBeGreaterThanOrEqual(3);
  });
});
