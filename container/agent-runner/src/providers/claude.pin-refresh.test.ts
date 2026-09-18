/**
 * A long-lived container must not keep sending the provider roster it was born
 * with.
 *
 * The pin is a cost optimisation resolved host-side and handed to the runner in
 * container.json, which the host rewrites daily as the gateway's roster moves.
 * Freezing it at construction turns a routine roster change into a container
 * that fails every turn: measured 2026-09-18, a two-day-old container held
 * `only: ["openai","wafer"]` while the current roster said
 * `["inference-net","openai","relace"]`, and 101 of its 155 requests came back
 * 429 `server_overloaded` from wafer's shared pool. A sibling container spawned
 * minutes later, with the same model and key, saw none.
 *
 * So the pin is consulted per turn, not per container. The retry that drops a
 * pin entirely (claude.pin-fallback.test.ts) stays the last resort for a pin
 * that routes nowhere at all; this is the cheaper path that keeps a pin.
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
/** SDK messages per attempt; an attempt with no entry simply succeeds. */
const attempts: unknown[][] = [];

const init = (id: string) => ({ type: 'system', subtype: 'init', session_id: id });
const successResult = (text: string) => ({ type: 'result', subtype: 'success', result: text });
const errorResult = (text: string) => ({
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  result: text,
});

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: (args: any) => {
    const index = calls.length;
    calls.push({ env: args.options.env, resume: args.options.resume });
    const messages = attempts[index] ?? [init('sess-1'), successResult('ok')];
    return (async function* () {
      for (const m of messages) yield m;
    })();
  },
}));

const { ClaudeProvider } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

type Pin = { only: string[]; allow_fallbacks: boolean };

const PIN_A: Pin = { only: ['openai', 'wafer'], allow_fallbacks: true };
const PIN_B: Pin = { only: ['inference-net', 'relace'], allow_fallbacks: true };
const GATEWAY_ENV = { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' };

let tmp: string;
let prevHome: string | undefined;

const RATE_LIMIT_429 = 'API Error: Request rejected (429) · Provider returned error';

async function drain(query: { events: AsyncIterable<unknown> }): Promise<void> {
  for await (const _ of query.events) {
    /* consume */
  }
}

async function collect(query: {
  events: AsyncIterable<unknown>;
}): Promise<Array<{ type: string; text?: string | null; isError?: boolean }>> {
  const events: Array<{ type: string; text?: string | null; isError?: boolean }> = [];
  for await (const e of query.events) events.push(e as { type: string; text?: string | null; isError?: boolean });
  return events;
}

function pinOf(call: SdkCall): unknown {
  const raw = call.env.CLAUDE_CODE_EXTRA_BODY;
  return raw === undefined ? undefined : (JSON.parse(raw) as { provider: Pin }).provider;
}

beforeEach(() => {
  calls.length = 0;
  attempts.length = 0;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pin-refresh-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('provider-pin refresh', () => {
  it('picks up a roster change between turns', async () => {
    let current: Pin | undefined = PIN_A;
    const provider = new ClaudeProvider({
      env: { ...GATEWAY_ENV },
      agentGroupId: 'ag-test',
      providerPin: PIN_A,
      refreshProviderPin: () => current,
    });
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);

    await drain(provider.query({ prompt: 'first', cwd: tmp }));
    expect(pinOf(calls[0]!)).toEqual(PIN_A);

    current = PIN_B;
    await drain(provider.query({ prompt: 'second', cwd: tmp }));
    expect(pinOf(calls[1]!)).toEqual(PIN_B);
  });

  it('drops the pin when the host withdrew it', async () => {
    // The host omits the pin whenever it cannot cover every model the container
    // runs — a half-built list is the one shape that 404s, so "no pin" is a
    // deliberate instruction, not a missing value.
    let current: Pin | undefined = PIN_A;
    const provider = new ClaudeProvider({
      env: { ...GATEWAY_ENV },
      agentGroupId: 'ag-test',
      providerPin: PIN_A,
      refreshProviderPin: () => current,
    });
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);

    await drain(provider.query({ prompt: 'first', cwd: tmp }));
    current = undefined;
    await drain(provider.query({ prompt: 'second', cwd: tmp }));

    expect(pinOf(calls[1]!)).toBeUndefined();
  });

  it('restarts a turn that died on an upstream 429 once the roster moved on', async () => {
    // The failure this exists for: the roster changes mid-life, the container
    // keeps one SDK query open for days, and every turn inside it dies 429 on
    // a provider the roster dropped. Re-reading at the start of a turn is not
    // enough — a long-lived container may never start another one.
    attempts.push([init('sess-1'), errorResult(RATE_LIMIT_429)]);
    let seen = 0;
    const provider = new ClaudeProvider({
      env: { ...GATEWAY_ENV },
      agentGroupId: 'ag-test',
      providerPin: PIN_A,
      refreshProviderPin: () => (seen++ === 0 ? PIN_A : PIN_B),
    });
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);

    const events = await collect(provider.query({ prompt: 'work', cwd: tmp }));

    expect(calls.length).toBe(2);
    expect(pinOf(calls[0]!)).toEqual(PIN_A);
    expect(pinOf(calls[1]!)).toEqual(PIN_B);
    // Same session — the turn continues, it does not start over.
    expect(calls[1]!.resume).toBe('sess-1');
    // The swallowed failure must not reach the poll loop as a dead turn.
    expect(events.some((e) => e.isError)).toBe(false);
    expect(events.at(-1)?.text).toBe('ok');
  });

  it('lets a 429 stand when the roster has not changed', async () => {
    // Nothing to route to differently, so a retry would only burn a second
    // call on the same overloaded provider. The existing rate-limit handling
    // (host-side wake retry) owns that case.
    attempts.push([init('sess-1'), errorResult(RATE_LIMIT_429)]);
    const provider = new ClaudeProvider({
      env: { ...GATEWAY_ENV },
      agentGroupId: 'ag-test',
      providerPin: PIN_A,
      refreshProviderPin: () => PIN_A,
    });
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);

    const events = await collect(provider.query({ prompt: 'work', cwd: tmp }));

    expect(calls.length).toBe(1);
    expect(events.some((e) => e.isError)).toBe(true);
  });

  it('keeps the spawn-time pin when no refresh source is wired', async () => {
    const provider = new ClaudeProvider({
      env: { ...GATEWAY_ENV },
      agentGroupId: 'ag-test',
      providerPin: PIN_A,
    });
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);

    await drain(provider.query({ prompt: 'only', cwd: tmp }));
    expect(pinOf(calls[0]!)).toEqual(PIN_A);
  });
});
