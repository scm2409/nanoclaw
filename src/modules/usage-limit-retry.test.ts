/**
 * `schedule_usage_limit_retry` is the host side of the auto-resume flow: the
 * container writes this system action when a turn ends on a transient
 * Anthropic usage-limit rejection with a known reset time (see
 * container/agent-runner/src/poll-loop.ts's maybeScheduleUsageLimitRetry).
 * The handler here turns that into a delayed inbound.db row that rides the
 * same due-message wake host-sweep already uses for scheduled tasks — no
 * kill/respawn, just a future `process_after`.
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getDeliveryAction } from '../delivery.js';
import type { MessagingGroup, Session } from '../types.js';

const mockGetMessagingGroup = vi.fn<(id: string) => MessagingGroup | undefined>();
vi.mock('../db/messaging-groups.js', () => ({
  getMessagingGroup: (id: string) => mockGetMessagingGroup(id),
}));

// The module barrel registers the action at import time.
import './usage-limit-retry.js';

function makeInboundDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages_in (
      id                TEXT PRIMARY KEY,
      seq               INTEGER UNIQUE,
      kind              TEXT NOT NULL,
      timestamp         TEXT NOT NULL,
      status            TEXT DEFAULT 'pending',
      process_after     TEXT,
      recurrence        TEXT,
      series_id         TEXT,
      tries             INTEGER DEFAULT 0,
      trigger           INTEGER NOT NULL DEFAULT 1,
      platform_id       TEXT,
      channel_type      TEXT,
      thread_id         TEXT,
      content           TEXT NOT NULL,
      source_session_id TEXT,
      on_wake           INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: 'thread-9',
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function readRows(db: Database.Database) {
  return db.prepare('SELECT * FROM messages_in').all() as Array<Record<string, unknown>>;
}

describe('schedule_usage_limit_retry', () => {
  beforeEach(() => {
    mockGetMessagingGroup.mockReset();
  });

  it('is registered', () => {
    expect(getDeliveryAction('schedule_usage_limit_retry')).toBeDefined();
  });

  it("writes a buffered, due-later row matching the session's own chat routing", async () => {
    mockGetMessagingGroup.mockReturnValue({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'chan-1',
      instance: 'discord',
    } as MessagingGroup);

    const inDb = makeInboundDb();
    const handler = getDeliveryAction('schedule_usage_limit_retry')!;

    await handler(
      { action: 'schedule_usage_limit_retry', resetsAt: '2026-08-20T12:00:00.000Z', retryCount: 0 },
      fakeSession(),
      inDb,
    );

    const rows = readRows(inDb);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.channel_type).toBe('discord');
    expect(row.platform_id).toBe('chan-1');
    expect(row.thread_id).toBe('thread-9');
    expect(row.trigger).toBe(1);
    expect(row.status).toBe('pending');

    // Buffered past the raw resetsAt so the retry doesn't land right on the
    // edge before Anthropic's own counter has actually rolled over.
    expect(Date.parse(row.process_after as string)).toBeGreaterThan(Date.parse('2026-08-20T12:00:00.000Z'));

    const content = JSON.parse(row.content as string);
    expect(content.retryCount).toBe(1); // incremented for the next round's cap check
    expect(content.text.toLowerCase()).toContain('continue');
  });

  it('falls back to null routing when the session has no messaging group (e.g. a task session)', async () => {
    const inDb = makeInboundDb();
    const handler = getDeliveryAction('schedule_usage_limit_retry')!;

    await handler(
      { action: 'schedule_usage_limit_retry', resetsAt: '2026-08-20T12:00:00.000Z', retryCount: 1 },
      fakeSession({ messaging_group_id: null }),
      inDb,
    );

    const rows = readRows(inDb);
    expect(rows).toHaveLength(1);
    expect(rows[0].channel_type).toBeNull();
    expect(rows[0].platform_id).toBeNull();
    expect(mockGetMessagingGroup).not.toHaveBeenCalled();
  });

  it('wakes exactly when told when the container computed the delay itself', async () => {
    // A gateway 429 reports no reset counter, so the container picks the delay
    // (see planRateLimitRetry). Adding the Anthropic-shaped buffer on top would
    // silently stretch every one of those waits by three minutes.
    const inDb = makeInboundDb();
    const handler = getDeliveryAction('schedule_usage_limit_retry')!;

    await handler(
      {
        action: 'schedule_usage_limit_retry',
        resetsAt: '2026-08-20T12:00:00.000Z',
        retryCount: 0,
        applyBuffer: false,
      },
      fakeSession({ messaging_group_id: null }),
      inDb,
    );

    expect(readRows(inDb)[0].process_after).toBe('2026-08-20T12:00:00.000Z');
  });

  it("carries the container's own wording when it sent one", async () => {
    // "Continue where you left off" is wrong for a scheduled run that never
    // ran at all — nothing was left off.
    const inDb = makeInboundDb();
    const handler = getDeliveryAction('schedule_usage_limit_retry')!;

    await handler(
      {
        action: 'schedule_usage_limit_retry',
        resetsAt: '2026-08-20T12:00:00.000Z',
        retryCount: 0,
        text: 'The scheduled run never executed — carry it out now.',
      },
      fakeSession({ messaging_group_id: null }),
      inDb,
    );

    const content = JSON.parse(readRows(inDb)[0].content as string);
    expect(content.text).toBe('The scheduled run never executed — carry it out now.');
  });

  it('drops the retry when the series fires again before it would', async () => {
    // Otherwise a 15-minute sweep whose backoff has grown to 30 minutes keeps
    // stacking retries on top of ticks that already ran: the schedule is the
    // retry, and a second wake for the same work is pure cost.
    const inDb = makeInboundDb();
    const handler = getDeliveryAction('schedule_usage_limit_retry')!;

    await handler(
      {
        action: 'schedule_usage_limit_retry',
        resetsAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        retryCount: 2,
        applyBuffer: false,
        recurrence: '*/15 * * * *',
      },
      fakeSession({ messaging_group_id: null }),
      inDb,
    );

    expect(readRows(inDb)).toHaveLength(0);
  });

  it('keeps the retry when the next occurrence is further out than the backoff', async () => {
    // A daily task rejected at 03:00 must not wait until tomorrow.
    const inDb = makeInboundDb();
    const handler = getDeliveryAction('schedule_usage_limit_retry')!;

    await handler(
      {
        action: 'schedule_usage_limit_retry',
        resetsAt: new Date(Date.now() + 2 * 60_000).toISOString(),
        retryCount: 0,
        applyBuffer: false,
        recurrence: '0 3 * * *',
      },
      fakeSession({ messaging_group_id: null }),
      inDb,
    );

    expect(readRows(inDb)).toHaveLength(1);
  });

  it('ignores a payload with an unparseable resetsAt instead of scheduling garbage', async () => {
    const inDb = makeInboundDb();
    const handler = getDeliveryAction('schedule_usage_limit_retry')!;

    await handler({ action: 'schedule_usage_limit_retry', resetsAt: 'not-a-date', retryCount: 0 }, fakeSession(), inDb);

    expect(readRows(inDb)).toHaveLength(0);
  });
});
