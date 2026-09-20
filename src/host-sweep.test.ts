/**
 * Unit tests for the stuck-container decision logic introduced by
 * ACTION-ITEMS item 9. Lives on the pure helper `decideStuckAction` so we
 * don't have to mock the filesystem or the container runner.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { deleteOrphanProcessingClaims, getProcessingClaims } from './db/session-db.js';
import {
  ABSOLUTE_CEILING_MS,
  BACKGROUND_CEILING_MS,
  CLAIM_STUCK_MS,
  _processErrorRetryAcksForTesting,
  _resetStuckProcessingRowsForTesting,
  decideStuckAction,
  parseSqliteUtc,
  nextLastActive,
  shouldCloseTaskSession,
} from './host-sweep.js';
import type { Session } from './types.js';

const BASE = Date.parse('2026-04-20T12:00:00.000Z');

function claim(id: string, offsetMs: number) {
  return { message_id: id, status_changed: new Date(BASE - offsetMs).toISOString() };
}

describe('decideStuckAction', () => {
  it('returns ok when heartbeat is fresh and no claims', () => {
    expect(
      decideStuckAction({
        now: BASE,
        heartbeatMtimeMs: BASE - 5_000,
        containerState: null,
        claims: [],
      }),
    ).toEqual({ action: 'ok' });
  });

  it('returns kill-ceiling when heartbeat older than 30 min', () => {
    const heartbeatMtimeMs = BASE - ABSOLUTE_CEILING_MS - 1_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs,
      containerState: null,
      claims: [],
    });
    expect(res.action).toBe('kill-ceiling');
    if (res.action !== 'kill-ceiling') return;
    expect(res.ceilingMs).toBe(ABSOLUTE_CEILING_MS);
    expect(res.heartbeatAgeMs).toBeGreaterThan(ABSOLUTE_CEILING_MS);
  });

  it('skips the ceiling check when no heartbeat file exists (fresh container not yet ticked)', () => {
    // A freshly-spawned container hasn't produced any SDK events yet, so no
    // heartbeat. Prior behavior treated this as infinitely stale and killed
    // every container within seconds of spawn. With no claims either, we
    // should conclude everything is fine.
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerState: null,
      claims: [],
    });
    expect(res.action).toBe('ok');
  });

  it('kills on claim-stuck when heartbeat is absent AND a claim has aged past tolerance', () => {
    // Hanging fresh container: spawned, picked up a message (claim recorded
    // in processing_ack), but never wrote a heartbeat. Falls through the
    // skipped ceiling check into claim-stuck — which correctly fires.
    const claimedAgeMs = CLAIM_STUCK_MS + 5_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('kill-claim');
  });

  it('extends the ceiling when Bash has a declared timeout longer than 30 min', () => {
    const twoHrMs = 2 * 60 * 60 * 1000;
    const res = decideStuckAction({
      now: BASE,
      // 45 min — over the default ceiling, but under the Bash timeout
      heartbeatMtimeMs: BASE - 45 * 60 * 1000,
      containerState: {
        current_tool: 'Bash',
        tool_declared_timeout_ms: twoHrMs,
        tool_started_at: new Date(BASE - 45 * 60 * 1000).toISOString(),
      },
      claims: [],
    });
    expect(res.action).toBe('ok');
  });

  it('returns kill-claim when a claim is past 60s and heartbeat has not moved', () => {
    const claimedAgeMs = CLAIM_STUCK_MS + 10_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - claimedAgeMs - 5_000, // older than the claim
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('kill-claim');
    if (res.action !== 'kill-claim') return;
    expect(res.messageId).toBe('msg-1');
    expect(res.toleranceMs).toBe(CLAIM_STUCK_MS);
  });

  it('does not kill when heartbeat has been touched since the claim', () => {
    const claimedAgeMs = CLAIM_STUCK_MS + 10_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 2_000, // fresh, updated after the claim
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('ok');
  });

  it('does not kill when claim age is below tolerance', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - CLAIM_STUCK_MS - 10_000, // old, but claim is recent
      containerState: null,
      claims: [claim('msg-1', 5_000)],
    });
    expect(res.action).toBe('ok');
  });

  it('widens per-claim tolerance for a running Bash with long timeout', () => {
    const tenMinMs = 10 * 60 * 1000;
    const res = decideStuckAction({
      now: BASE,
      // 5 min since claim, over the 60s default but under the declared Bash timeout
      heartbeatMtimeMs: BASE - 5 * 60 * 1000 - 5_000,
      containerState: {
        current_tool: 'Bash',
        tool_declared_timeout_ms: tenMinMs,
        tool_started_at: new Date(BASE - 5 * 60 * 1000).toISOString(),
      },
      claims: [claim('msg-1', 5 * 60 * 1000)],
    });
    expect(res.action).toBe('ok');
  });

  // ───────────────────────────────────────────────────────────────────────
  // Background work (2026-09-13): delegated work that produces no stream
  // events for a while — a background subagent, a backgrounded Bash command —
  // leaves the heartbeat untouched, and the 30-min ceiling used to kill the
  // container out from under it. The container reports how many background
  // tasks it still has outstanding; the host widens the ceiling for them, but
  // only up to BACKGROUND_CEILING_MS and only while the report is fresh.
  // ───────────────────────────────────────────────────────────────────────

  it('extends the ceiling while the container reports outstanding background tasks', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - ABSOLUTE_CEILING_MS - 60_000,
      containerState: {
        current_tool: null,
        tool_declared_timeout_ms: null,
        tool_started_at: null,
        background_tasks: 1,
        updated_at: new Date(BASE - 30_000).toISOString(),
      },
      claims: [],
    });
    expect(res.action).toBe('ok');
  });

  it('kills once background work passes the background ceiling', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - BACKGROUND_CEILING_MS - 60_000,
      containerState: {
        current_tool: null,
        tool_declared_timeout_ms: null,
        tool_started_at: null,
        background_tasks: 2,
        updated_at: new Date(BASE - 30_000).toISOString(),
      },
      claims: [],
    });
    expect(res.action).toBe('kill-ceiling');
    if (res.action !== 'kill-ceiling') return;
    expect(res.ceilingMs).toBe(BACKGROUND_CEILING_MS);
  });

  it('ignores a stale background-task report', () => {
    // The count is only trustworthy while the container keeps re-stamping it.
    // A report last written an hour ago says nothing about now.
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - ABSOLUTE_CEILING_MS - 60_000,
      containerState: {
        current_tool: null,
        tool_declared_timeout_ms: null,
        tool_started_at: null,
        background_tasks: 1,
        updated_at: new Date(BASE - 60 * 60 * 1000).toISOString(),
      },
      claims: [],
    });
    expect(res.action).toBe('kill-ceiling');
    if (res.action !== 'kill-ceiling') return;
    expect(res.ceilingMs).toBe(ABSOLUTE_CEILING_MS);
  });

  it('does not extend the ceiling when no background task is outstanding', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - ABSOLUTE_CEILING_MS - 60_000,
      containerState: {
        current_tool: null,
        tool_declared_timeout_ms: null,
        tool_started_at: null,
        background_tasks: 0,
        updated_at: new Date(BASE - 30_000).toISOString(),
      },
      claims: [],
    });
    expect(res.action).toBe('kill-ceiling');
  });

  // ───────────────────────────────────────────────────────────────────────
  // Immortal container (2026-09-13): a container that never ran a turn never
  // writes a heartbeat, so the ceiling check skipped it forever. Found live:
  // one container up 2 days, 207k idle poll iterations, holding ~0.5 GB.
  // Spawn time is the baseline when no heartbeat exists.
  // ───────────────────────────────────────────────────────────────────────

  it('kills a container that never wrote a heartbeat and is past the ceiling since spawn', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerStartedAtMs: BASE - ABSOLUTE_CEILING_MS - 60_000,
      containerState: null,
      claims: [],
    });
    expect(res.action).toBe('kill-ceiling');
    if (res.action !== 'kill-ceiling') return;
    expect(res.heartbeatAgeMs).toBeGreaterThan(ABSOLUTE_CEILING_MS);
  });

  it('leaves a freshly spawned container without a heartbeat alone', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerStartedAtMs: BASE - 10_000,
      containerState: null,
      claims: [],
    });
    expect(res.action).toBe('ok');
  });

  it('still skips the ceiling when neither heartbeat nor spawn time is known', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerState: null,
      claims: [],
    });
    expect(res.action).toBe('ok');
  });

  it('ignores claims with unparseable timestamps', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 5_000,
      containerState: null,
      claims: [{ message_id: 'x', status_changed: 'not-a-date' }],
    });
    expect(res.action).toBe('ok');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Orphan claim cleanup (regression test for the SIGKILL → claim-stuck loop)
//
// Repro of the production bug seen 2026-04-30: container A claimed message M
// (writes processing_ack row with status='processing'). Host kills A by
// absolute-ceiling. Old behavior: messages_in.M was reset to pending but
// processing_ack.M survived. On the next sweep tick, wakeContainer spawned B,
// the same-tick SLA check saw M's stale claim age (hours), and SIGKILL'd B
// before agent-runner could run clearStaleProcessingAcks(). Loop. The fix
// deletes processing_ack 'processing' rows when the host kills/cleans the
// container, breaking the loop atomically.
// ─────────────────────────────────────────────────────────────────────────────

function makeSessionDbs(): { inDb: Database.Database; outDb: Database.Database } {
  const inDb = new Database(':memory:');
  inDb.exec(`
    CREATE TABLE messages_in (
      id            TEXT PRIMARY KEY,
      seq           INTEGER UNIQUE,
      kind          TEXT NOT NULL,
      timestamp     TEXT NOT NULL,
      status        TEXT DEFAULT 'pending',
      process_after TEXT,
      recurrence    TEXT,
      series_id     TEXT,
      tries         INTEGER DEFAULT 0,
      trigger       INTEGER NOT NULL DEFAULT 1,
      platform_id   TEXT,
      channel_type  TEXT,
      thread_id     TEXT,
      content       TEXT NOT NULL
    );
  `);
  const outDb = new Database(':memory:');
  outDb.exec(`
    CREATE TABLE processing_ack (
      message_id     TEXT PRIMARY KEY,
      status         TEXT NOT NULL,
      status_changed TEXT NOT NULL
    );
  `);
  return { inDb, outDb };
}

function fakeSession(): Session {
  return {
    id: 'sess-test',
    agent_group_id: 'ag-test',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

describe('deleteOrphanProcessingClaims', () => {
  it('removes only processing rows, leaves completed/failed alone', () => {
    const { outDb } = makeSessionDbs();
    const ts = new Date().toISOString();
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-proc', 'processing', ?)").run(ts);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-done', 'completed', ?)").run(ts);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-fail', 'failed', ?)").run(ts);

    const removed = deleteOrphanProcessingClaims(outDb);

    expect(removed).toBe(1);
    const remaining = outDb.prepare('SELECT message_id, status FROM processing_ack ORDER BY message_id').all();
    expect(remaining).toEqual([
      { message_id: 'm-done', status: 'completed' },
      { message_id: 'm-fail', status: 'failed' },
    ]);
  });

  it('returns 0 when nothing to clear', () => {
    const { outDb } = makeSessionDbs();
    expect(deleteOrphanProcessingClaims(outDb)).toBe(0);
  });
});

describe('resetStuckProcessingRows — orphan claim cleanup', () => {
  it('deletes orphan processing_ack rows so next sweep tick does not see them', () => {
    const { inDb, outDb } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago

    // messages_in.status stays 'pending' during processing — only the
    // container's processing_ack moves to 'processing'. See
    // src/db/schema.ts header comment on processing_ack.
    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES ('m-1', 1, 'chat', ?, 'pending', '{}')",
      )
      .run(claimedAt);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-1', 'processing', ?)").run(claimedAt);

    // Sanity: the orphan claim is what would trip claim-stuck.
    expect(getProcessingClaims(outDb)).toHaveLength(1);

    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'absolute-ceiling');

    // Regression assertion: orphan claim is gone — next sweep tick will see
    // an empty claims list and not kill the freshly respawned container.
    expect(getProcessingClaims(outDb)).toEqual([]);

    // And the message itself was rescheduled with backoff (existing behavior).
    const row = inDb.prepare('SELECT status, tries, process_after FROM messages_in WHERE id = ?').get('m-1') as {
      status: string;
      tries: number;
      process_after: string | null;
    };
    expect(row.status).toBe('pending');
    expect(row.tries).toBe(1);
    expect(row.process_after).not.toBeNull();
  });

  it('still clears orphan claims even when the inbound message has already been retried (skip path)', () => {
    // Edge case: the inbound row was already rescheduled (process_after in
    // future), so the per-message retry loop skips it. The orphan in
    // processing_ack must still be removed — otherwise the bug remains.
    const { inDb, outDb } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();

    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, tries, content) VALUES ('m-2', 2, 'chat', ?, 'pending', ?, 1, '{}')",
      )
      .run(claimedAt, future);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-2', 'processing', ?)").run(claimedAt);

    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'claim-stuck');

    expect(getProcessingClaims(outDb)).toEqual([]);
    const row = inDb.prepare('SELECT tries FROM messages_in WHERE id = ?').get('m-2') as { tries: number };
    expect(row.tries).toBe(1); // not bumped, the skip path held
  });
});

describe('parseSqliteUtc', () => {
  // Regression: SQLite TIMESTAMP strings have no zone marker, but Date.parse
  // treats those as local time. On non-UTC hosts this made every claim look
  // (TZ offset) hours stale and tripped kill-claim on freshly-claimed messages.
  // The helper appends "Z" only when no marker is present, so parsing is
  // always anchored to UTC regardless of host timezone.

  const utcMs = Date.parse('2026-04-20T12:00:00.000Z');

  it('treats a SQLite-style timestamp (no zone) as UTC', () => {
    expect(parseSqliteUtc('2026-04-20 12:00:00')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T12:00:00')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T12:00:00.000')).toBe(utcMs);
  });

  it('preserves an explicit Z marker', () => {
    expect(parseSqliteUtc('2026-04-20T12:00:00.000Z')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T12:00:00z')).toBe(utcMs);
  });

  it('preserves an explicit numeric offset', () => {
    // 14:00+02:00 == 12:00 UTC
    expect(parseSqliteUtc('2026-04-20T14:00:00+02:00')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T14:00:00+0200')).toBe(utcMs);
    // 07:00-05:00 == 12:00 UTC
    expect(parseSqliteUtc('2026-04-20T07:00:00-05:00')).toBe(utcMs);
  });

  it('returns NaN for unparseable input', () => {
    expect(Number.isNaN(parseSqliteUtc('not a date'))).toBe(true);
  });

  it('does not drift across host timezones for SQLite-style input', () => {
    // The helper itself is timezone-independent because it forces UTC parsing.
    // (Verifying the regex branch — without the helper, `Date.parse` of the
    // bare string returns different values depending on the host TZ.)
    const bare = '2026-04-20T12:00:00';
    expect(parseSqliteUtc(bare)).toBe(Date.parse(bare + 'Z'));
  });
});

describe('shouldCloseTaskSession', () => {
  it('closes a spent per-task session (no live tasks, no container)', () => {
    expect(shouldCloseTaskSession('system:tasks:task-1', false, 0)).toBe(true);
  });

  it('keeps it while a task is still live (recurring re-armed, or pending/paused)', () => {
    expect(shouldCloseTaskSession('system:tasks:task-1', false, 1)).toBe(false);
  });

  it('keeps it while its container is running (mid-fire)', () => {
    expect(shouldCloseTaskSession('system:tasks:task-1', true, 0)).toBe(false);
  });

  it('never touches non-task sessions', () => {
    expect(shouldCloseTaskSession('telegram:12345', false, 0)).toBe(false);
    expect(shouldCloseTaskSession(null, false, 0)).toBe(false);
  });
});

describe('nextLastActive — heartbeat liveness', () => {
  const HB = Date.parse('2026-09-18T13:00:00.000Z');

  it('returns the heartbeat stamp when it is newer than the recorded value', () => {
    expect(nextLastActive('2026-09-18T09:20:20.249Z', HB)).toBe('2026-09-18T13:00:00.000Z');
  });

  it('returns null when the recorded value is already at or past the heartbeat', () => {
    expect(nextLastActive('2026-09-18T13:00:00.000Z', HB)).toBeNull();
    expect(nextLastActive('2026-09-18T13:05:00.000Z', HB)).toBeNull();
  });

  it('returns the heartbeat stamp when nothing was ever recorded', () => {
    expect(nextLastActive(null, HB)).toBe('2026-09-18T13:00:00.000Z');
  });

  it('returns null when there is no heartbeat file', () => {
    expect(nextLastActive('2026-09-18T09:20:20.249Z', 0)).toBeNull();
    expect(nextLastActive(null, 0)).toBeNull();
  });

  it('returns the heartbeat stamp when the recorded value is unparseable', () => {
    expect(nextLastActive('not-a-date', HB)).toBe('2026-09-18T13:00:00.000Z');
  });
});

describe('processErrorRetryAcks — a rejected chat turn is not a finished one', () => {
  it('reschedules an error-retry claim with a minutes-scale backoff and clears the claim', () => {
    const { inDb, outDb } = makeSessionDbs();
    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, tries, content) VALUES ('m-1', 1, 'chat', ?, 'pending', 0, '{}')",
      )
      .run(new Date().toISOString());
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-1', 'error-retry', ?)").run(new Date().toISOString());

    _processErrorRetryAcksForTesting(inDb, outDb, fakeSession());

    const row = inDb.prepare('SELECT status, tries, process_after FROM messages_in WHERE id = ?').get('m-1') as {
      status: string;
      tries: number;
      process_after: string | null;
    };
    expect(row.status).toBe('pending');
    expect(row.tries).toBe(1);
    expect(row.process_after).not.toBeNull();
    // Minute-scale, not the seconds-scale crash backoff: the usual reason a
    // turn failed on the provider is a limit that clears in minutes or hours,
    // and a 10-80s ladder would burn all five attempts against a 403 night.
    const backoffMs = Date.parse(row.process_after!) - Date.now();
    expect(backoffMs).toBeGreaterThan(60_000);
    expect(getProcessingClaims(outDb)).toEqual([]);
    // error-retry claims are gone; nothing else was touched.
    const acks = outDb.prepare('SELECT status FROM processing_ack').all();
    expect(acks).toHaveLength(0);
  });

  it('grows the backoff with each successive failure', () => {
    const { inDb, outDb } = makeSessionDbs();
    const insert = inDb.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, tries, content) VALUES (?, ?, 'chat', ?, 'pending', ?, '{}')",
    );
    insert.run('m-1', 1, new Date().toISOString(), 0);
    insert.run('m-2', 2, new Date().toISOString(), 2);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-1', 'error-retry', ?)").run(new Date().toISOString());
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-2', 'error-retry', ?)").run(new Date().toISOString());

    _processErrorRetryAcksForTesting(inDb, outDb, fakeSession());

    const first = inDb.prepare('SELECT process_after FROM messages_in WHERE id = ?').get('m-1') as {
      process_after: string;
    };
    const third = inDb.prepare('SELECT process_after FROM messages_in WHERE id = ?').get('m-2') as {
      process_after: string;
    };
    expect(Date.parse(third.process_after)).toBeGreaterThan(Date.parse(first.process_after));
  });

  it('marks the message failed once the retry cap is spent', () => {
    const { inDb, outDb } = makeSessionDbs();
    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, tries, content) VALUES ('m-1', 1, 'chat', ?, 'pending', 5, '{}')",
      )
      .run(new Date().toISOString());
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-1', 'error-retry', ?)").run(new Date().toISOString());

    _processErrorRetryAcksForTesting(inDb, outDb, fakeSession());

    const row = inDb.prepare('SELECT status FROM messages_in WHERE id = ?').get('m-1') as { status: string };
    expect(row.status).toBe('failed');
    expect(outDb.prepare('SELECT message_id FROM processing_ack').all()).toEqual([]);
  });

  it('leaves completed, failed and processing claims alone', () => {
    const { inDb, outDb } = makeSessionDbs();
    const ts = new Date().toISOString();
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-done', 'completed', ?)").run(ts);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-fail', 'failed', ?)").run(ts);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-proc', 'processing', ?)").run(ts);

    _processErrorRetryAcksForTesting(inDb, outDb, fakeSession());

    const statuses = outDb.prepare('SELECT message_id, status FROM processing_ack ORDER BY message_id').all();
    expect(statuses).toEqual([
      { message_id: 'm-done', status: 'completed' },
      { message_id: 'm-fail', status: 'failed' },
      { message_id: 'm-proc', status: 'processing' },
    ]);
  });
});
