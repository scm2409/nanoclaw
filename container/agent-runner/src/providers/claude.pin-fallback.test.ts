/**
 * A provider pin can go stale under a running container: the endpoint list is
 * resolved host-side at spawn and frozen into the container's env, but the
 * gateway's roster moves. Observed live — `z-ai/glm-5.3-flash` was pinned to a
 * provider that stopped serving the model mid-session, and every later request
 * came back:
 *
 *   404 not_found_error — "No allowed providers are available for the selected
 *   model. Providers serving z-ai/glm-5.3-flash: gmicloud, novita, ..."
 *
 * which the CLI renders as "There's an issue with the selected model (...)".
 * The turn died there: a four-hour piece of work reported nothing, and every
 * later message would have failed the same way until an operator restarted the
 * container by hand.
 *
 * The pin is a cost optimisation. Losing the turn to it is the wrong trade, so
 * one retry drops the pin and lets the gateway route anywhere. Unpinned routing
 * is dearer for that turn and may land on a cold cache — both are cheaper than
 * a dead turn.
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
/** SDK messages to emit, one array per attempt. */
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

const PIN = { only: ['relace'], allow_fallbacks: true };
const GATEWAY_ENV = { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' };

const MODEL_404 = "There's an issue with the selected model (z-ai/glm-5.3-flash). It may not exist or you may not have access to it.";

const init = (sessionId: string) => ({ type: 'system', subtype: 'init', session_id: sessionId });
const errorResult = (text: string) => ({ type: 'result', subtype: 'error_during_execution', is_error: true, result: text });
const successResult = (text: string) => ({ type: 'result', subtype: 'success', result: text });

let tmp: string;
let prevHome: string | undefined;

function run(options: { providerPin?: typeof PIN } = { providerPin: PIN }) {
  const provider = new ClaudeProvider({ env: { ...GATEWAY_ENV }, agentGroupId: 'ag-test', ...options });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  return provider.query({ prompt: 'hi', cwd: tmp });
}

async function collect(query: { events: AsyncIterable<unknown> }) {
  const events: Array<{ type: string; text?: string | null; isError?: boolean }> = [];
  for await (const e of query.events) events.push(e as { type: string; text?: string | null; isError?: boolean });
  return events;
}

beforeEach(() => {
  calls.length = 0;
  attempts.length = 0;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pin-fallback-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('provider-pin fallback', () => {
  it('retries the turn unpinned when the pin no longer routes anywhere', async () => {
    attempts.push([init('sess-1'), errorResult(MODEL_404)]);
    attempts.push([init('sess-1'), successResult('<message to="user">done</message>')]);

    const events = await collect(run());

    expect(calls).toHaveLength(2);
    expect(calls[0]!.env.CLAUDE_CODE_EXTRA_BODY).toBe(JSON.stringify({ provider: PIN }));
    // The retry must not merely pin somewhere else — it carries no pin at all.
    expect(calls[1]!.env.CLAUDE_CODE_EXTRA_BODY).toBeUndefined();
    // Resumed, so the retry keeps the turn's history instead of starting blank.
    expect(calls[1]!.resume).toBe('sess-1');

    // The failed attempt's error never reaches the poll loop: it would be
    // delivered to the user as a failed turn while the retry was still running.
    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0]!.text).toBe('<message to="user">done</message>');
    expect(results[0]!.isError).toBe(false);
  });

  it('surfaces the error when the unpinned retry fails too', async () => {
    // A genuinely wrong model name renders the same message, and no amount of
    // routing fixes that. One retry, then the truth.
    attempts.push([init('sess-1'), errorResult(MODEL_404)]);
    attempts.push([init('sess-1'), errorResult(MODEL_404)]);

    const events = await collect(run());

    expect(calls).toHaveLength(2);
    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0]!.isError).toBe(true);
    expect(results[0]!.text).toBe(MODEL_404);
  });

  it('leaves unrelated error results alone', async () => {
    attempts.push([init('sess-1'), errorResult('Credit balance is too low')]);

    const events = await collect(run());

    expect(calls).toHaveLength(1);
    const results = events.filter((e) => e.type === 'result');
    expect(results[0]!.isError).toBe(true);
    expect(results[0]!.text).toBe('Credit balance is too low');
  });

  it('does not retry when there was no pin to drop', async () => {
    attempts.push([init('sess-1'), errorResult(MODEL_404)]);

    const events = await collect(run({ providerPin: undefined }));

    expect(calls).toHaveLength(1);
    expect(events.filter((e) => e.type === 'result')[0]!.isError).toBe(true);
  });

  it("never strips an operator's own routing choice", async () => {
    // providerPinEnv stands aside when the operator set the extra body
    // themselves; a failed turn is not a licence to overrule them either.
    const operatorBody = '{"provider":{"only":["mine"]}}';
    attempts.push([init('sess-1'), errorResult(MODEL_404)]);

    const provider = new ClaudeProvider({
      env: { ...GATEWAY_ENV, CLAUDE_CODE_EXTRA_BODY: operatorBody },
      agentGroupId: 'ag-test',
      providerPin: PIN,
    });
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const events = await collect(provider.query({ prompt: 'hi', cwd: tmp }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.env.CLAUDE_CODE_EXTRA_BODY).toBe(operatorBody);
    expect(events.filter((e) => e.type === 'result')[0]!.isError).toBe(true);
  });
});
