import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// A `task_started` SDK message with `subagent_type` set means the Task tool
// just invoked a subagent (e.g. the websearch subagent added to research
// groups). The provider must surface this as a `subagent` ProviderEvent,
// resolving the model via Query.supportedAgents() — never silently drop it
// as generic activity, which is what happened before this was added.

const sdkMessages: unknown[] = [];
let supportedAgentsResult: { name: string; description: string; model?: string }[] = [];
let supportedAgentsCalls = 0;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    const gen = (async function* () {
      for (const m of sdkMessages) yield m;
    })();
    (gen as unknown as { supportedAgents: () => Promise<unknown> }).supportedAgents = async () => {
      supportedAgentsCalls++;
      return supportedAgentsResult;
    };
    return gen;
  },
}));

const { ClaudeProvider } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-subagent-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
  supportedAgentsCalls = 0;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('task_started subagent translation', () => {
  it('yields a subagent event with the resolved model for a Task-tool subagent', async () => {
    sdkMessages.length = 0;
    supportedAgentsResult = [{ name: 'websearch', description: 'web research', model: 'haiku' }];
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'system', subtype: 'task_started', task_id: 't1', subagent_type: 'websearch', description: 'look up X' },
      { type: 'result', subtype: 'success', result: '<message to="user">done</message>' },
    );

    const provider = new ClaudeProvider({});
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp });

    const events: { type: string; subagentType?: string; model?: string }[] = [];
    for await (const e of q.events) events.push(e as { type: string; subagentType?: string; model?: string });

    const subagentEvents = events.filter((e) => e.type === 'subagent');
    expect(subagentEvents).toHaveLength(1);
    expect(subagentEvents[0]!.subagentType).toBe('websearch');
    expect(subagentEvents[0]!.model).toBe('haiku');
    // supportedAgents() is called at most once per query, cached across
    // multiple task_started events.
    expect(supportedAgentsCalls).toBe(1);
  });

  it('ignores task_started messages with no subagent_type (shell/workflow tasks)', async () => {
    sdkMessages.length = 0;
    supportedAgentsResult = [];
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'system', subtype: 'task_started', task_id: 't1', task_type: 'shell' },
      { type: 'result', subtype: 'success', result: null },
    );

    const provider = new ClaudeProvider({});
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp });

    const events: { type: string }[] = [];
    for await (const e of q.events) events.push(e as { type: string });

    expect(events.some((e) => e.type === 'subagent')).toBe(false);
    expect(supportedAgentsCalls).toBe(0);
  });

  it('falls back to the main model when the subagent has no explicit model', async () => {
    sdkMessages.length = 0;
    supportedAgentsResult = [{ name: 'general-purpose', description: 'general' }];
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'system', subtype: 'task_started', task_id: 't1', subagent_type: 'general-purpose' },
      { type: 'result', subtype: 'success', result: null },
    );

    const provider = new ClaudeProvider({ model: 'sonnet' });
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp });

    const events: { type: string; model?: string }[] = [];
    for await (const e of q.events) events.push(e as { type: string; model?: string });

    const subagentEvents = events.filter((e) => e.type === 'subagent');
    expect(subagentEvents).toHaveLength(1);
    expect(subagentEvents[0]!.model).toBe('sonnet');
  });
});

describe('result text fallback', () => {
  it('uses the last assistant text when a successful result has no result text', async () => {
    sdkMessages.length = 0;
    supportedAgentsResult = [];
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: '<message to="user">verified</message>' }],
        },
      },
      { type: 'result', subtype: 'success', result: null },
    );

    const provider = new ClaudeProvider({});
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp });

    const events: { type: string; text?: string | null }[] = [];
    for await (const e of q.events) events.push(e as { type: string; text?: string | null });

    expect(events.find((e) => e.type === 'result')).toEqual({
      type: 'result',
      text: '<message to="user">verified</message>',
      isError: false,
      modelUsage: undefined,
    });
  });

  it('keeps a genuinely textless successful result empty', async () => {
    sdkMessages.length = 0;
    supportedAgentsResult = [];
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'result', subtype: 'success', result: null },
    );

    const provider = new ClaudeProvider({});
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp });

    const events: { type: string; text?: string | null }[] = [];
    for await (const e of q.events) events.push(e as { type: string; text?: string | null });

    expect(events.find((e) => e.type === 'result')).toEqual({
      type: 'result',
      text: null,
      isError: false,
      modelUsage: undefined,
    });
  });
});

describe('result modelUsage translation', () => {
  it('passes the SDK result message\'s modelUsage through unchanged on the result event', async () => {
    sdkMessages.length = 0;
    supportedAgentsResult = [];
    const modelUsage = {
      sonnet: { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.08 },
    };
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'result', subtype: 'success', result: '<message to="user">done</message>', modelUsage },
    );

    const provider = new ClaudeProvider({});
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp });

    const events: { type: string; modelUsage?: unknown }[] = [];
    for await (const e of q.events) events.push(e as { type: string; modelUsage?: unknown });

    const resultEvent = events.find((e) => e.type === 'result');
    expect(resultEvent).toBeDefined();
    expect(resultEvent!.modelUsage).toEqual(modelUsage);
  });
});
