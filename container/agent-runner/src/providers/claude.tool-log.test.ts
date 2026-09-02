import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Tool calls and their results must reach the container log as their own
// ProviderEvents.
//
// Why: the container log recorded only `Progress:` and the final `Result:` —
// i.e. only what the agent chose to say. Twice in one session an agent
// reported shell output that did not match what the command actually
// produced (a file's contents reconstructed from context, and EXIT=1 for a
// command that exited 0). With only the agent's own account in the log there
// was no way to tell "ran it and misreported" from "never ran it", which is
// the difference between a reporting bug and a much worse one.

const sdkMessages: unknown[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    const gen = (async function* () {
      for (const m of sdkMessages) yield m;
    })();
    (gen as unknown as { supportedAgents: () => Promise<unknown> }).supportedAgents = async () => [];
    return gen;
  },
}));

const { ClaudeProvider } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tool-log-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

type AnyEvent = {
  type: string;
  name?: string;
  summary?: string;
  isError?: boolean;
  preview?: string;
};

async function eventsFor(messages: unknown[]): Promise<AnyEvent[]> {
  sdkMessages.length = 0;
  sdkMessages.push(...messages);
  const provider = new ClaudeProvider({});
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = provider.query({ prompt: 'hi', cwd: tmp });
  const out: AnyEvent[] = [];
  for await (const e of q.events) out.push(e as AnyEvent);
  return out;
}

const INIT = { type: 'system', subtype: 'init', session_id: 'sess-1' };
const DONE = { type: 'result', subtype: 'success', result: '<message to="user">done</message>' };

function bashCall(command: string, id = 'tu-1') {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
  };
}

function toolResult(content: unknown, isError = false, id = 'tu-1') {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
  };
}

describe('tool call logging', () => {
  it('yields a tool event carrying the exact Bash command', async () => {
    const cmd = 'bash /workspace/agent/scripts/deck-sweep-gate.sh; echo EXIT=$?';
    const events = await eventsFor([INIT, bashCall(cmd), DONE]);

    const tools = events.filter((e) => e.type === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('Bash');
    expect(tools[0]!.summary).toBe(cmd);
  });

  it('yields a tool_result event carrying what the command actually printed', async () => {
    const events = await eventsFor([INIT, bashCall('echo hi'), toolResult('{"wakeAgent":false}\nEXIT=0'), DONE]);

    const results = events.filter((e) => e.type === 'tool_result');
    expect(results).toHaveLength(1);
    expect(results[0]!.isError).toBe(false);
    expect(results[0]!.preview).toContain('EXIT=0');
  });

  it('marks a failed tool result as an error', async () => {
    const events = await eventsFor([INIT, bashCall('false'), toolResult('command failed', true), DONE]);
    const results = events.filter((e) => e.type === 'tool_result');
    expect(results[0]!.isError).toBe(true);
  });

  it('handles the SDK content-block array form of a tool result', async () => {
    const events = await eventsFor([
      INIT,
      bashCall('echo hi'),
      toolResult([{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }]),
      DONE,
    ]);
    const preview = events.find((e) => e.type === 'tool_result')!.preview!;
    expect(preview).toContain('line one');
    expect(preview).toContain('line two');
  });

  it('summarises a non-Bash tool without dumping its whole input', async () => {
    const events = await eventsFor([
      INIT,
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tu-2', name: 'Read', input: { file_path: '/workspace/agent/notes.md' } }],
        },
      },
      DONE,
    ]);
    const tool = events.find((e) => e.type === 'tool')!;
    expect(tool.name).toBe('Read');
    expect(tool.summary).toContain('/workspace/agent/notes.md');
  });

  it('bounds a huge tool result instead of writing it whole', async () => {
    const events = await eventsFor([INIT, bashCall('cat big'), toolResult('x'.repeat(50_000)), DONE]);
    const preview = events.find((e) => e.type === 'tool_result')!.preview!;
    expect(preview.length).toBeLessThan(5_000);
    expect(preview).toContain('truncated');
  });

  it('still yields assistant text as the turn result, unaffected', async () => {
    const events = await eventsFor([INIT, bashCall('echo hi'), toolResult('hi'), DONE]);
    const result = events.find((e) => e.type === 'result') as { text?: string } | undefined;
    expect(result?.text).toContain('done');
  });

  it('emits nothing extra for a turn with no tool use', async () => {
    const events = await eventsFor([INIT, DONE]);
    expect(events.some((e) => e.type === 'tool' || e.type === 'tool_result')).toBe(false);
  });
});
