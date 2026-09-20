/**
 * `queue_quota_recovery_note` is the host side of the quota recovery flow: the
 * container writes this system action when a turn ends on a provider quota
 * rejection (402/403 budget or key limit — see
 * container/agent-runner/src/quota-recovery-note.ts for why these get a note
 * and not the timed retry a 429 gets). The handler here turns it into a
 * trigger=0 inbound.db row: accumulated context that never wakes anything on
 * its own but rides along with the next wake that happens for another reason,
 * so the first successful tick after the operator raised the limit reads it.
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
import './quota-recovery-note.js';

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

describe('queue_quota_recovery_note', () => {
  beforeEach(() => {
    mockGetMessagingGroup.mockReset();
  });

  it('is registered', () => {
    expect(getDeliveryAction('queue_quota_recovery_note')).toBeDefined();
  });

  it("writes a non-waking context row matching the session's own chat routing", async () => {
    mockGetMessagingGroup.mockReturnValue({
      id: 'mg-1',
      channel_type: 'matrix',
      platform_id: 'matrix:@user:example.org',
      instance: 'matrix',
    } as MessagingGroup);

    const inDb = makeInboundDb();
    const handler = getDeliveryAction('queue_quota_recovery_note')!;

    await handler(
      {
        action: 'queue_quota_recovery_note',
        text: 'The previous scheduled run(s) were rejected with a quota error.',
      },
      fakeSession(),
      inDb,
    );

    const rows = readRows(inDb);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.kind).toBe('chat');
    expect(row.channel_type).toBe('matrix');
    expect(row.platform_id).toBe('matrix:@user:example.org');
    expect(row.thread_id).toBe('thread-9');
    // The entire point: this row must never wake anything on its own. It is
    // context for the next wake that happens for another reason — the next
    // sweep tick, or the user's next message once the limit is raised.
    expect(row.trigger).toBe(0);
    expect(row.status).toBe('pending');
    expect(row.process_after).toBeNull();

    const content = JSON.parse(row.content as string);
    expect(content.text).toContain('quota');
    expect(content.sender).toBe('system');
  });

  it('falls back to null routing when the session has no messaging group (e.g. a task session)', async () => {
    const inDb = makeInboundDb();
    const handler = getDeliveryAction('queue_quota_recovery_note')!;

    await handler(
      { action: 'queue_quota_recovery_note', text: 'note' },
      fakeSession({ messaging_group_id: null }),
      inDb,
    );

    const rows = readRows(inDb);
    expect(rows).toHaveLength(1);
    expect(rows[0].channel_type).toBeNull();
    expect(rows[0].platform_id).toBeNull();
    expect(mockGetMessagingGroup).not.toHaveBeenCalled();
  });

  it('keeps exactly one note during an outage: a still-pending note dedupes the next rejected tick', async () => {
    // A budget outage lasts hours and the sweep ticks every 15 minutes; each
    // rejected tick writes the action again. The note from the first one is
    // still pending (no successful wake has consumed it), so the rest are
    // dropped instead of stacking up one row per tick.
    const inDb = makeInboundDb();
    const handler = getDeliveryAction('queue_quota_recovery_note')!;
    const payload = { action: 'queue_quota_recovery_note', text: 'note' };

    await handler(payload, fakeSession(), inDb);
    await handler(payload, fakeSession(), inDb);
    await handler(payload, fakeSession(), inDb);

    expect(readRows(inDb)).toHaveLength(1);
  });

  it('queues a fresh note after a previous one was consumed by a wake', async () => {
    // A consumed note is history, not a duplicate guard: a second outage —
    // or a second affected series in the same session — queues again.
    const inDb = makeInboundDb();
    const handler = getDeliveryAction('queue_quota_recovery_note')!;

    await handler({ action: 'queue_quota_recovery_note', text: 'first' }, fakeSession(), inDb);
    inDb.prepare("UPDATE messages_in SET status = 'completed' WHERE id LIKE 'quota-recovery-note-%'").run();
    await handler({ action: 'queue_quota_recovery_note', text: 'second' }, fakeSession(), inDb);

    expect(readRows(inDb)).toHaveLength(2);
  });

  it('falls back to default wording when the container sent none', async () => {
    const inDb = makeInboundDb();
    const handler = getDeliveryAction('queue_quota_recovery_note')!;

    await handler({ action: 'queue_quota_recovery_note' }, fakeSession({ messaging_group_id: null }), inDb);

    const content = JSON.parse(readRows(inDb)[0].content as string);
    expect(content.text.toLowerCase()).toContain('quota');
  });
});
