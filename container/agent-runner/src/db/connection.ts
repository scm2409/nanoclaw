/**
 * Two-DB connection layer.
 *
 * The session uses two SQLite files to eliminate write contention across
 * the host-container mount boundary:
 *
 *   inbound.db  — host writes new messages here; container opens READ-ONLY
 *   outbound.db — container writes responses + acks here; host opens read-only
 *
 * Each file has exactly one writer, so no cross-process lock contention.
 *
 * ⚠ Cross-mount visibility: inbound.db MUST be journal_mode=DELETE (set by
 * the host when the file is created). WAL's `-shm` is memory-mapped and
 * VirtioFS does not propagate mmap coherency from host to guest, so a
 * WAL-mode inbound.db would leave this reader frozen on an early snapshot
 * and it would silently never see new host messages. See
 * src/session-manager.ts for the full set of cross-mount invariants and
 * scripts/sanity-live-poll.ts for the empirical validation.
 */
import { Database } from 'bun:sqlite';
import fs from 'fs';

const DEFAULT_INBOUND_PATH = '/workspace/inbound.db';
const DEFAULT_OUTBOUND_PATH = '/workspace/outbound.db';
const DEFAULT_HEARTBEAT_PATH = '/workspace/.heartbeat';

let _inbound: Database | null = null;
let _outbound: Database | null = null;
let _heartbeatPath: string = DEFAULT_HEARTBEAT_PATH;
let _testMode = false;
// Mirrors container_state.background_tasks so the periodic re-stamp knows
// whether there is anything to vouch for.
let _backgroundTasks = 0;

/**
 * Avoid all cached db reads; open inbound.db read-only with mmap and page cache disabled.
 *
 * Use this (not getInboundDb) for readers that need to see host-written rows
 * promptly — e.g. messages_in polling. Caller must .close() the returned
 * connection (try/finally).
 *
 * Needed for mounts where host writes don't reliably invalidate
 * SQLite's caches: virtiofs (Colima, Lima, Podman Machine, Apple
 * Container), NFS.
 *
 * Cost is microseconds per query, so safe for universal use.
 */
export function openInboundDb(): Database {
  // In test mode return a thin wrapper over the in-memory singleton.
  // Callers do try/finally { db.close() } — the wrapper no-ops close()
  // so the singleton survives for the rest of the test.
  if (_testMode && _inbound) {
    const db = _inbound;
    return {
      prepare: (sql: string) => db.prepare(sql),
      exec: (sql: string) => db.exec(sql),
      close: () => {},
    } as unknown as Database;
  }
  const db = new Database(DEFAULT_INBOUND_PATH, { readonly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA mmap_size = 0');
  return db;
}

/**
 * Inbound DB — long-lived singleton, OK for tables the host writes once
 * at spawn and never again (destinations, session_routing). For
 * messages_in polling — where the host writes continuously and a stale
 * view causes the pollHandle hang — use `openInboundDb()` instead.
 */
export function getInboundDb(): Database {
  if (!_inbound) {
    _inbound = new Database(DEFAULT_INBOUND_PATH, { readonly: true });
    _inbound.exec('PRAGMA busy_timeout = 5000');
    _inbound.exec('PRAGMA mmap_size = 0');
  }
  return _inbound;
}

/** Outbound DB — container owns this file (sole writer). */
export function getOutboundDb(): Database {
  if (!_outbound) {
    _outbound = new Database(DEFAULT_OUTBOUND_PATH);
    _outbound.exec('PRAGMA journal_mode = DELETE');
    _outbound.exec('PRAGMA busy_timeout = 5000');
    _outbound.exec('PRAGMA foreign_keys = ON');
    // Lightweight forward-compat: session_state was added after the initial
    // v2 schema, so older session DBs don't have it. Create it on demand
    // instead of requiring a formal migration pass. Also handle the case
    // where an earlier revision of this table existed without updated_at —
    // ALTER TABLE to add any missing columns.
    _outbound.exec(`
      CREATE TABLE IF NOT EXISTS session_state (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const cols = new Set(
      (_outbound.prepare("PRAGMA table_info('session_state')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('updated_at')) {
      _outbound.exec(`ALTER TABLE session_state ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`);
    }
    // container_state: tracks the current tool in flight (if any) so the host
    // sweep can widen its stuck tolerance when Bash is running with a user-
    // declared long timeout. Forward-compat for older outbound.db files.
    _outbound.exec(`
      CREATE TABLE IF NOT EXISTS container_state (
        id                       INTEGER PRIMARY KEY CHECK (id = 1),
        current_tool             TEXT,
        tool_declared_timeout_ms INTEGER,
        tool_started_at          TEXT,
        background_tasks         INTEGER NOT NULL DEFAULT 0,
        subagent_handles         INTEGER NOT NULL DEFAULT 0,
        updated_at               TEXT NOT NULL
      );
    `);
    const stateCols = new Set(
      (_outbound.prepare("PRAGMA table_info('container_state')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!stateCols.has('background_tasks')) {
      _outbound.exec(`ALTER TABLE container_state ADD COLUMN background_tasks INTEGER NOT NULL DEFAULT 0`);
    }
    if (!stateCols.has('subagent_handles')) {
      _outbound.exec(`ALTER TABLE container_state ADD COLUMN subagent_handles INTEGER NOT NULL DEFAULT 0`);
    }
  }
  return _outbound;
}

/**
 * Record that a tool is starting. `declaredTimeoutMs` is the tool's own
 * timeout hint when one is available (Bash exposes it in the tool_use input);
 * omit for tools with no declared timeout.
 */
export function setContainerToolInFlight(tool: string, declaredTimeoutMs: number | null): void {
  const now = new Date().toISOString();
  getOutboundDb()
    .prepare(
      `INSERT INTO container_state (id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         current_tool = excluded.current_tool,
         tool_declared_timeout_ms = excluded.tool_declared_timeout_ms,
         tool_started_at = excluded.tool_started_at,
         updated_at = excluded.updated_at`,
    )
    .run(tool, declaredTimeoutMs, now, now);
}

/** Clear the in-flight tool — called on PostToolUse / PostToolUseFailure. */
export function clearContainerToolInFlight(): void {
  const now = new Date().toISOString();
  getOutboundDb()
    .prepare(
      `INSERT INTO container_state (id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
       VALUES (1, NULL, NULL, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET
         current_tool = NULL,
         tool_declared_timeout_ms = NULL,
         tool_started_at = NULL,
         updated_at = excluded.updated_at`,
    )
    .run(now);
}

/**
 * Record how many background tasks (background subagents, backgrounded Bash
 * commands) the agent still has in flight.
 *
 * This is the container's half of the deal that keeps it alive through work it
 * delegated: such tasks emit no stream events between launch and completion, so
 * the heartbeat goes stale while everything is fine, and the host's idle ceiling
 * killed the container out from under them. The host widens that ceiling — up to
 * a cap — while this count is above zero and recently stamped.
 */
export function setBackgroundTasks(count: number): void {
  _backgroundTasks = count;
  const now = new Date().toISOString();
  getOutboundDb()
    .prepare(
      `INSERT INTO container_state (id, background_tasks, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         background_tasks = excluded.background_tasks,
         updated_at = excluded.updated_at`,
    )
    .run(count, now);
}

/**
 * Re-stamp the outstanding count so it stays trustworthy while the container
 * waits. A count nobody refreshes tells the host nothing about now, which is
 * why the host ignores a stale one — and why a container with nothing
 * outstanding must not stamp anything here.
 */
export function refreshBackgroundTasks(): void {
  if (_backgroundTasks <= 0) return;
  setBackgroundTasks(_backgroundTasks);
}

/**
 * Record that this container started a subagent.
 *
 * A subagent lives in the CLI process inside the container, and it stays
 * resumable long after it has stopped — until the container goes, taking every
 * handle with it. The host cannot see subagents at all, so it cannot tell a
 * reclaim that lost nothing from one that quietly killed a delegation the agent
 * still meant to resume. On 2026-09-15 it told KaiL nothing had been lost while
 * the r79 engineer's handle died with the container; two hours later KaiL
 * reported that engineer as dead for no reason.
 *
 * Counted, never decremented: a stopped agent is exactly as lost as a running
 * one, and that is the point of the number.
 */
export function noteSubagentHandle(): void {
  const now = new Date().toISOString();
  getOutboundDb()
    .prepare(
      `INSERT INTO container_state (id, subagent_handles, updated_at)
       VALUES (1, 1, ?)
       ON CONFLICT(id) DO UPDATE SET
         subagent_handles = subagent_handles + 1,
         updated_at = excluded.updated_at`,
    )
    .run(now);
}

/**
 * Clear the counters that describe *this* container run. `outbound.db` belongs
 * to the session and outlives every container in it, so without this a fresh
 * container inherits a dead one's numbers — and the next reclaim note reports
 * handles that were already gone.
 */
export function resetContainerRunState(): void {
  _backgroundTasks = 0;
  const now = new Date().toISOString();
  getOutboundDb()
    .prepare(
      `INSERT INTO container_state (id, background_tasks, subagent_handles, updated_at)
       VALUES (1, 0, 0, ?)
       ON CONFLICT(id) DO UPDATE SET
         background_tasks = 0,
         subagent_handles = 0,
         updated_at = excluded.updated_at`,
    )
    .run(now);
}

/**
 * Touch the heartbeat file — replaces the old touchProcessing() DB writes.
 * The host checks this file's mtime for stale container detection.
 * A file touch is cheaper and avoids cross-boundary DB write contention.
 */
export function touchHeartbeat(): void {
  const p = _heartbeatPath;
  const now = new Date();
  try {
    fs.utimesSync(p, now, now);
  } catch {
    try {
      fs.writeFileSync(p, '');
    } catch {
      // Silently ignore — parent dir may not exist (e.g., in-memory test DBs)
    }
  }
}

/**
 * Clear stale processing_ack entries on container startup.
 * If the previous container crashed, 'processing' entries are leftover.
 * Clearing them lets the new container re-process those messages.
 */
export function clearStaleProcessingAcks(): void {
  getOutboundDb().prepare("DELETE FROM processing_ack WHERE status = 'processing'").run();
}

/** For tests — creates in-memory DBs with the session schemas. */
export function initTestSessionDb(): { inbound: Database; outbound: Database } {
  _testMode = true;
  _backgroundTasks = 0;
  _inbound = new Database(':memory:');
  _inbound.exec('PRAGMA foreign_keys = ON');
  _inbound.exec(`
    CREATE TABLE messages_in (
      id             TEXT PRIMARY KEY,
      seq            INTEGER UNIQUE,
      kind           TEXT NOT NULL,
      timestamp      TEXT NOT NULL,
      status         TEXT DEFAULT 'pending',
      process_after  TEXT,
      recurrence     TEXT,
      series_id      TEXT,
      tries          INTEGER DEFAULT 0,
      trigger        INTEGER NOT NULL DEFAULT 1,
      platform_id    TEXT,
      channel_type   TEXT,
      thread_id      TEXT,
      content        TEXT NOT NULL,
      on_wake        INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE delivered (
      message_out_id      TEXT PRIMARY KEY,
      platform_message_id TEXT,
      status              TEXT NOT NULL DEFAULT 'delivered',
      delivered_at        TEXT NOT NULL
    );
    CREATE TABLE destinations (
      name            TEXT PRIMARY KEY,
      display_name    TEXT,
      type            TEXT NOT NULL,
      channel_type    TEXT,
      platform_id     TEXT,
      agent_group_id  TEXT
    );
  `);

  _outbound = new Database(':memory:');
  _outbound.exec('PRAGMA foreign_keys = ON');
  _outbound.exec(`
    CREATE TABLE messages_out (
      id             TEXT PRIMARY KEY,
      seq            INTEGER UNIQUE,
      in_reply_to    TEXT,
      timestamp      TEXT NOT NULL,
      deliver_after  TEXT,
      recurrence     TEXT,
      kind           TEXT NOT NULL,
      platform_id    TEXT,
      channel_type   TEXT,
      thread_id      TEXT,
      content        TEXT NOT NULL
    );
    CREATE TABLE processing_ack (
      message_id     TEXT PRIMARY KEY,
      status         TEXT NOT NULL,
      status_changed TEXT NOT NULL
    );
    CREATE TABLE session_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE container_state (
      id                       INTEGER PRIMARY KEY CHECK (id = 1),
      current_tool             TEXT,
      tool_declared_timeout_ms INTEGER,
      tool_started_at          TEXT,
      background_tasks         INTEGER NOT NULL DEFAULT 0,
      subagent_handles         INTEGER NOT NULL DEFAULT 0,
      updated_at               TEXT NOT NULL
    );
  `);

  return { inbound: _inbound, outbound: _outbound };
}

export function closeSessionDb(): void {
  _backgroundTasks = 0;
  _inbound?.close();
  _inbound = null;
  _testMode = false;
  _outbound?.close();
  _outbound = null;
}
