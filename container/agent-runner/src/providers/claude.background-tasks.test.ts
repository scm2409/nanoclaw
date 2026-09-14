import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Background work — a background subagent, a backgrounded Bash command —
// produces no stream events between its launch and its completion. The
// heartbeat is touched per event, so it goes stale while the container is doing
// exactly what it was asked to do, and the host's 30-min ceiling killed it:
// six containers on 2026-09-12/13, each taking its delegated work along.
//
// The provider therefore reports how many background tasks are outstanding, and
// surfaces task_progress as activity so a reporting task keeps the heartbeat
// alive on its own.

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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bgtasks-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function collect(): Promise<{ type: string; outstanding?: number }[]> {
  const provider = new ClaudeProvider({});
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = provider.query({ prompt: 'hi', cwd: tmp });
  const events: { type: string; outstanding?: number }[] = [];
  for await (const e of q.events) events.push(e as { type: string; outstanding?: number });
  return events;
}

describe('background-task reporting', () => {
  it('reports the outstanding count as tasks start and settle', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'system', subtype: 'task_started', task_id: 't1', subagent_type: 'software-engineer' },
      { type: 'system', subtype: 'task_started', task_id: 't2', task_type: 'shell' },
      { type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'done' },
      { type: 'system', subtype: 'task_notification', task_id: 't2', status: 'completed', summary: 'done' },
      { type: 'result', subtype: 'success', result: null },
    );

    const counts = (await collect()).filter((e) => e.type === 'background-tasks').map((e) => e.outstanding);
    expect(counts).toEqual([1, 2, 1, 0]);
  });

  it('counts a shell task the same as a subagent', async () => {
    // A backgrounded Bash command carries no subagent_type, but it is exactly
    // as fatal to kill the container out from under it.
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'system', subtype: 'task_started', task_id: 't1', task_type: 'shell' },
      { type: 'result', subtype: 'success', result: null },
    );

    const events = await collect();
    expect(events.some((e) => e.type === 'subagent')).toBe(false);
    expect(events.filter((e) => e.type === 'background-tasks').map((e) => e.outstanding)).toEqual([1]);
  });

  it('surfaces task_progress as activity', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'system', subtype: 'task_started', task_id: 't1', subagent_type: 'coder' },
      {
        type: 'system',
        subtype: 'task_progress',
        task_id: 't1',
        description: 'still working',
        usage: { total_tokens: 10, tool_uses: 1, duration_ms: 100 },
      },
      { type: 'result', subtype: 'success', result: null },
    );

    const events = await collect();
    expect(events.some((e) => e.type === 'activity')).toBe(true);
  });
});
