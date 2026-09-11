/**
 * Typing-refresh instance forwarding tests.
 *
 * Three tick sites can fire setTyping — the immediate tick on a new
 * refresher, the 4s interval tick, and the immediate re-trigger when
 * startTypingRefresh is called for an already-refreshing session. All three
 * must forward the adapter instance, or a named instance's typing indicator
 * fires through the wrong bot.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-typing' };
});

import { setTypingAdapter, startTypingRefresh, stopTypingRefresh } from './index.js';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const DATA_DIR = '/tmp/nanoclaw-test-typing';

/**
 * Lay down a session directory the way the host does: a heartbeat file with a
 * chosen age, and an outbound.db carrying the container's tool-in-flight row.
 */
function seedSession(
  agentGroupId: string,
  sessionId: string,
  opts: { heartbeatAgeMs: number; tool?: { name: string; startedAgoMs: number; declaredTimeoutMs?: number | null } },
) {
  const dir = path.join(DATA_DIR, 'v2-sessions', agentGroupId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const hb = path.join(dir, '.heartbeat');
  fs.writeFileSync(hb, '');
  const t = Date.now() - opts.heartbeatAgeMs;
  fs.utimesSync(hb, t / 1000, t / 1000);

  const db = new Database(path.join(dir, 'outbound.db'));
  db.exec(`CREATE TABLE IF NOT EXISTS container_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    current_tool TEXT,
    tool_declared_timeout_ms INTEGER,
    tool_started_at TEXT,
    updated_at TEXT NOT NULL
  )`);
  db.prepare('DELETE FROM container_state').run();
  if (opts.tool) {
    db.prepare(
      'INSERT INTO container_state (id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at) VALUES (1, ?, ?, ?, ?)',
    ).run(
      opts.tool.name,
      opts.tool.declaredTimeoutMs ?? null,
      new Date(Date.now() - opts.tool.startedAgoMs).toISOString(),
      new Date().toISOString(),
    );
  }
  db.close();
}

type Call = { channelType: string; platformId: string; threadId: string | null; instance?: string };

function captureAdapter() {
  const calls: Call[] = [];
  setTypingAdapter({
    async setTyping(channelType, platformId, threadId, instance) {
      calls.push({ channelType, platformId, threadId, instance });
    },
  });
  return calls;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  stopTypingRefresh('sess-1');
  vi.useRealTimers();
});

describe('startTypingRefresh — instance forwarding', () => {
  it('immediate tick passes the instance to the adapter', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      channelType: 'slack',
      platformId: 'slack:C1',
      threadId: null,
      instance: 'slack-tester',
    });
  });

  it('interval ticks inside the grace window pass the stored entry instance', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // Two 4s ticks — well inside the 15s grace window, so they fire
    // unconditionally (no heartbeat file needed) from the stored entry.
    await vi.advanceTimersByTimeAsync(8_500);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      expect(c.instance).toBe('slack-tester');
      expect(c.threadId).toBe('T1');
    }
  });

  it('re-trigger on an active session passes (and stores) the new instance', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // Second call for the same session: immediate tick with the new value.
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-worker');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].instance).toBe('slack-worker');

    // And the stored entry was updated — subsequent interval ticks carry it.
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(4_500);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[calls.length - 1].instance).toBe('slack-worker');
  });

  it('re-trigger with a changed address updates the whole entry — interval ticks stay self-consistent', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // Same session re-triggered from a different platform and chat
    // (agent-shared sessions span messaging groups). The stored entry must
    // not tear: keeping the old address with the new instance would hand a
    // telegram platformId to the slack-tester adapter on the next tick.
    startTypingRefresh('sess-1', 'ag-1', 'telegram', 'tg:99', null, 'telegram');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      channelType: 'telegram',
      platformId: 'tg:99',
      threadId: null,
      instance: 'telegram',
    });

    // Interval ticks fire from the stored entry — all four fields must
    // have moved together.
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(4_500);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const c of calls) {
      expect(c).toEqual({
        channelType: 'telegram',
        platformId: 'tg:99',
        threadId: null,
        instance: 'telegram',
      });
    }
  });
});

/**
 * A tool call is work the user should see. The heartbeat only ticks on SDK
 * events, so a container sitting in one long Bash call looks idle to the
 * heartbeat alone — that is the second half of the dark-typing-indicator
 * problem (the first half being model calls, fixed by partial messages in the
 * container). The tool-in-flight row already exists for the host sweep; this
 * reads it for the indicator too.
 */
describe('startTypingRefresh — a tool in flight counts as working', () => {
  /** Get past the 15s grace window, where ticks fire unconditionally. */
  async function pastGrace() {
    await vi.advanceTimersByTimeAsync(16_000);
  }

  it('keeps typing while a tool runs, even with a stale heartbeat', async () => {
    seedSession('ag-t', 'sess-tool', {
      heartbeatAgeMs: 120_000,
      tool: { name: 'Bash', startedAgoMs: 60_000, declaredTimeoutMs: 600_000 },
    });
    const calls = captureAdapter();
    startTypingRefresh('sess-tool', 'ag-t', 'matrix', 'matrix:!r', null);
    await pastGrace();
    calls.length = 0;

    await vi.advanceTimersByTimeAsync(12_000);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    stopTypingRefresh('sess-tool');
  });

  it('stops when neither heartbeat nor tool says anything is happening', async () => {
    seedSession('ag-t', 'sess-idle', { heartbeatAgeMs: 120_000 });
    const calls = captureAdapter();
    startTypingRefresh('sess-idle', 'ag-t', 'matrix', 'matrix:!r', null);
    await pastGrace();
    calls.length = 0;

    await vi.advanceTimersByTimeAsync(12_000);
    expect(calls).toHaveLength(0);
    stopTypingRefresh('sess-idle');
  });

  it('ignores a tool row left behind by a dead container', async () => {
    // Nothing clears this row when a container is killed mid-tool, so an
    // unbounded read would show "typing" forever. The declared timeout is the
    // bound the agent itself named.
    seedSession('ag-t', 'sess-stale', {
      heartbeatAgeMs: 120_000,
      tool: { name: 'Bash', startedAgoMs: 3_600_000, declaredTimeoutMs: 60_000 },
    });
    const calls = captureAdapter();
    startTypingRefresh('sess-stale', 'ag-t', 'matrix', 'matrix:!r', null);
    await pastGrace();
    calls.length = 0;

    await vi.advanceTimersByTimeAsync(12_000);
    expect(calls).toHaveLength(0);
    stopTypingRefresh('sess-stale');
  });
});
