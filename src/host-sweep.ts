/**
 * Host sweep — periodic maintenance of all session DBs.
 *
 * Two-DB architecture:
 *   - Reads processing_ack + container_state from outbound.db
 *   - Writes to inbound.db (host-owned) for status updates + recurrence
 *   - Uses heartbeat file mtime for liveness (never polls DB for it)
 *   - Never writes to outbound.db — preserves single-writer-per-file invariant
 *
 * Stuck / idle detection (replaces the old IDLE_TIMEOUT setTimeout + 10-min
 * heartbeat threshold):
 *
 *   If the container isn't running and there are 'processing' rows left over
 *   (e.g. it crashed mid-turn) → reset them to pending with backoff +
 *   tries++. Existing retry machinery does the rest.
 *
 *   If the container IS running:
 *     1. Absolute ceiling: heartbeat age > max(30 min, current_bash_timeout,
 *        4 h while background work is outstanding) → kill. Covers the "alive
 *        but silent for 30 min" case. Extended while Bash is declared as
 *        running longer, honouring the user's own timeout directive, and while
 *        the container reports background tasks in flight, which produce no
 *        stream events and hence no heartbeat. With no heartbeat file at all
 *        the container's spawn time is the baseline. Kill then resets
 *        processing rows.
 *
 *     2. Message-scoped stuck: for each 'processing' row, tolerance =
 *        max(60s, current_bash_timeout_ms_if_Bash_running). If
 *        (claim_age > tolerance) AND (heartbeat_mtime <= status_changed)
 *        → kill + reset this message + tries++. Semantics: "container
 *        claimed a message and went quiet past tolerance since the claim."
 */
import type Database from 'better-sqlite3';
import fs from 'fs';

import { ensureEgressNetwork } from './egress-lockdown.js';
import { getActiveSessions, isTaskThread, updateSession } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import {
  countDueMessages,
  deleteOrphanProcessingClaims,
  getContainerState,
  getMessageForRetry,
  getProcessingClaims,
  markMessageFailed,
  retryWithBackoff,
  syncProcessingAcks,
  type ContainerState,
} from './db/session-db.js';
import { log } from './log.js';
import { openInboundDb, openOutboundDb, openOutboundDbRw, inboundDbPath, heartbeatPath } from './session-manager.js';
import { containerStartedAtMs, isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import type { Session } from './types.js';

/**
 * SQLite TIMESTAMP columns store UTC without a timezone marker. Date.parse
 * treats timezoneless ISO strings as local time, so on non-UTC hosts every
 * timestamp looks (TZ offset) hours stale — leading to spurious kill-claim
 * decisions on freshly-claimed messages. Append "Z" when no zone marker is
 * present so Date.parse interprets the string as UTC.
 */
export function parseSqliteUtc(s: string): number {
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z');
}

const SWEEP_INTERVAL_MS = 60_000;
// Absolute idle ceiling for a running container. If the heartbeat file hasn't
// been touched in this long, the container is either stuck or doing genuinely
// nothing — kill and restart on the next inbound.
export const ABSOLUTE_CEILING_MS = 30 * 60 * 1000;
// Stuck tolerance window applied per 'processing' claim — "did we see any
// signs of life since this message was claimed?"
export const CLAIM_STUCK_MS = 60 * 1000;
// Ceiling that applies instead while the container reports background work in
// flight (a background subagent, a backgrounded Bash command). Such work emits
// no stream events between launch and completion, so the heartbeat — which is
// touched per event — goes stale while the container is doing exactly what it
// was asked to do. Six containers died that way on 2026-09-12/13, each taking
// its delegated work with it. Still a ceiling and not an exemption: a container
// wedged behind a task that never settles has to die eventually.
export const BACKGROUND_CEILING_MS = 4 * 60 * 60 * 1000;
// How long a background-task report stays trustworthy. The container re-stamps
// container_state while tasks are outstanding; a report nobody refreshed says
// nothing about now.
export const BACKGROUND_REPORT_FRESH_MS = 5 * 60 * 1000;
const MAX_TRIES = 5;
const BACKOFF_BASE_MS = 5000;

export type StuckDecision =
  | { action: 'ok' }
  | { action: 'kill-ceiling'; heartbeatAgeMs: number; ceilingMs: number }
  | { action: 'kill-claim'; messageId: string; claimAgeMs: number; toleranceMs: number };

/**
 * Pure decision for whether a running container should be killed this sweep
 * tick. Inputs are all deterministic; filesystem + DB reads happen in the
 * caller.
 */
export function decideStuckAction(args: {
  now: number;
  heartbeatMtimeMs: number; // 0 when heartbeat file absent
  containerStartedAtMs?: number | null; // 0/null when the spawn time is unknown
  containerState: ContainerState | null;
  claims: Array<{ message_id: string; status_changed: string }>;
}): StuckDecision {
  const { now, heartbeatMtimeMs, containerState, claims } = args;
  const declaredBashMs = bashTimeoutMs(containerState);

  // The ceiling needs a baseline to measure against. Normally that's the
  // heartbeat; a freshly-spawned container hasn't had any SDK activity yet, so
  // no heartbeat file exists, and treating its absence as infinitely stale
  // would kill every container within seconds of spawn. But treating it as
  // exemption instead made a container that never runs a turn immortal: found
  // live on 2026-09-13, one up for two days across 207k idle poll iterations,
  // holding its memory the whole time. Spawn time is the honest fallback — it
  // is fresh exactly when the container is. If a fresh container is hanging at
  // the gate (claimed a message but never did anything) the claim-stuck check
  // below handles it either way.
  const ceilingBaseline = heartbeatMtimeMs !== 0 ? heartbeatMtimeMs : (args.containerStartedAtMs ?? 0);
  if (ceilingBaseline !== 0) {
    const heartbeatAge = now - ceilingBaseline;
    const ceiling = Math.max(
      ABSOLUTE_CEILING_MS,
      declaredBashMs ?? 0,
      hasLiveBackgroundWork(containerState, now) ? BACKGROUND_CEILING_MS : 0,
    );
    if (heartbeatAge > ceiling) {
      return { action: 'kill-ceiling', heartbeatAgeMs: heartbeatAge, ceilingMs: ceiling };
    }
  }

  const tolerance = Math.max(CLAIM_STUCK_MS, declaredBashMs ?? 0);
  for (const claim of claims) {
    const claimedAt = parseSqliteUtc(claim.status_changed);
    if (Number.isNaN(claimedAt)) continue;
    const claimAge = now - claimedAt;
    if (claimAge <= tolerance) continue;
    if (heartbeatMtimeMs > claimedAt) continue;
    return { action: 'kill-claim', messageId: claim.message_id, claimAgeMs: claimAge, toleranceMs: tolerance };
  }

  return { action: 'ok' };
}

let running = false;

export function startHostSweep(): void {
  if (running) return;
  running = true;
  sweep();
}

export function stopHostSweep(): void {
  running = false;
}

async function sweep(): Promise<void> {
  if (!running) return;

  // Re-heal the egress network so already-running agents keep their gateway hop
  // if it was detached out-of-band. Best-effort here: a heal failure isn't a
  // leak (agents stay on the internal net), so log and continue. No-op when
  // lockdown is disabled.
  try {
    ensureEgressNetwork();
  } catch (err) {
    log.error('Egress lockdown re-heal failed', { err });
  }

  try {
    const sessions = getActiveSessions();
    for (const session of sessions) {
      await sweepSession(session);
    }
  } catch (err) {
    log.error('Host sweep error', { err });
  }

  // Finalize any "Reject with reason…" holds whose reply window elapsed (admin
  // ghosted, or the host restarted mid-capture). Central-DB scan, once per tick
  // — not per session.
  // MODULE-HOOK:approvals-reason-sweep:start
  try {
    const { sweepAwaitingReasonRejects } = await import('./modules/approvals/index.js');
    await sweepAwaitingReasonRejects();
  } catch (err) {
    log.error('Reject-with-reason sweep failed', { err });
  }
  // MODULE-HOOK:approvals-reason-sweep:end

  await refreshProviderPinsIfDue();

  setTimeout(sweep, SWEEP_INTERVAL_MS);
}

/**
 * Epoch-ms of the last provider-pin refresh, or 0 for "never this process".
 * Deliberately in-memory: a restart re-checking once is harmless, and the
 * stored `refreshed_at` is what actually decides whether a pin is usable.
 */
let lastProviderPinRefresh = 0;

/**
 * Refresh the cheapest-tier provider list per model, once a day.
 *
 * Daily rather than at container spawn on purpose. A spawn-time fetch that
 * half-fails would emit a partial `provider.only` union, and a union missing a
 * model is a 404 for whichever subagent runs it — the one failure shape worth
 * engineering against. Here a failure leaves the previous snapshot in place.
 * Pure HTTP against a public endpoint: no container, no model call.
 */
async function refreshProviderPinsIfDue(): Promise<void> {
  const { PROVIDER_PIN_REFRESH_INTERVAL_MS, refreshProviderPins } = await import('./provider-pins.js');
  if (Date.now() - lastProviderPinRefresh < PROVIDER_PIN_REFRESH_INTERVAL_MS) return;
  lastProviderPinRefresh = Date.now();
  try {
    const { allModelsInUse } = await import('./provider-pin-models.js');
    const models = allModelsInUse();
    if (models.length === 0) return;
    const updated = await refreshProviderPins(models);
    log.info('Provider pins refreshed', { models: models.length, updated });
  } catch (err) {
    log.warn('Provider pin refresh failed', { err });
  }
}

/** A per-task session with no live tasks and no running container is spent → close it. */
export function shouldCloseTaskSession(
  threadId: string | null,
  containerRunning: boolean,
  liveTaskCount: number,
): boolean {
  return isTaskThread(threadId) && !containerRunning && liveTaskCount === 0;
}

async function sweepSession(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  const inPath = inboundDbPath(agentGroup.id, session.id);
  if (!fs.existsSync(inPath)) return;

  let inDb: Database.Database;
  let outDb: Database.Database | null = null;
  try {
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch {
    return;
  }

  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
  } catch {
    // outbound.db might not exist yet (container hasn't started)
  }

  try {
    // 1. Sync processing_ack → messages_in status
    if (outDb) {
      syncProcessingAcks(inDb, outDb);
    }

    // 2. Wake a container if work is due and nothing is running. Ordered
    // before the crashed-container cleanup so a fresh container gets a chance
    // to clean its own orphan processing_ack rows on startup (see
    // container/agent-runner/src/db/connection.ts). Otherwise the reset path
    // would keep bumping process_after into the future, dueCount would stay 0,
    // and the wake would never fire.
    const dueCount = countDueMessages(inDb);
    let justWoke = false;
    if (dueCount > 0 && !isContainerRunning(session.id)) {
      log.info('Waking container for due messages', { sessionId: session.id, count: dueCount });
      // wakeContainer never throws — transient spawn failures (OneCLI down,
      // etc.) return false and leave messages pending for the next tick.
      await wakeContainer(session);
      justWoke = true;
    }

    const alive = isContainerRunning(session.id);

    // 2b. Refresh last_active from the heartbeat. A container that polls
    // without producing a model turn is alive, and the column must say so.
    const liveStamp = nextLastActive(session.last_active, heartbeatMtimeMs(agentGroup.id, session.id));
    if (liveStamp) {
      updateSession(session.id, { last_active: liveStamp });
    }

    // 3. Running-container SLA: absolute ceiling + per-claim stuck rules.
    // Skip on the same iteration that just woke the container — it hasn't
    // had a chance to clear stale processing_ack rows from a previous crash
    // yet. Without this grace period, stale claims cause an immediate
    // spawn-kill loop.
    if (alive && outDb && !justWoke) {
      enforceRunningContainerSla(inDb, outDb, session, agentGroup.id);
    }

    // 4. Crashed-container cleanup: processing rows left behind get retried.
    // Only fires when wake in step 2 didn't pick up the work (no due messages,
    // or wake failed). resetStuckProcessingRows itself is idempotent — it
    // skips messages already scheduled for a future retry.
    if (!alive && outDb) {
      resetStuckProcessingRows(inDb, outDb, session, 'container not running');
    }

    // 5. Recurrence fanout for completed recurring tasks.
    // MODULE-HOOK:scheduling-recurrence:start
    const { handleRecurrence } = await import('./modules/scheduling/recurrence.js');
    await handleRecurrence(inDb, session);
    // MODULE-HOOK:scheduling-recurrence:end

    // 6. GC spent task sessions. An isolated per-task session with no live task
    // rows left (one-shot fired, or all cancelled/deleted) and no container
    // running is dead — close it so it stops being swept and listed. Runs after
    // recurrence so a just-fired recurring series has already re-armed its next
    // pending row and is never collected. The per-task log file in the workspace
    // is the durable history and survives the close.
    if (isTaskThread(session.thread_id)) {
      const liveTasks = (
        inDb
          .prepare("SELECT COUNT(*) AS c FROM messages_in WHERE kind = 'task' AND status IN ('pending', 'paused')")
          .get() as { c: number }
      ).c;
      if (shouldCloseTaskSession(session.thread_id, isContainerRunning(session.id), liveTasks)) {
        updateSession(session.id, { status: 'closed' });
        log.info('Closed spent task session', { sessionId: session.id, threadId: session.thread_id });
      }
    }
  } finally {
    inDb.close();
    outDb?.close();
  }
}

/**
 * Keep `sessions.last_active` honest as a liveness signal.
 *
 * It used to move only when the host wrote an inbound row or spawned a
 * container. A container that stays up and polls — the normal state for a
 * scheduled series whose pre-task gate keeps answering `wakeAgent: false` —
 * therefore froze at the timestamp of its last model turn, and `ncl sessions
 * list` showed a live session as hours idle. Both the agent and its watchdog
 * read that column to decide whether a chain had died, so a frozen value made
 * them declare a healthy session dead and take over work nobody had dropped.
 *
 * The heartbeat file is the real liveness signal (see the module header), so
 * fold it in here. Returns the stamp to write, or null when there is nothing
 * newer to record — no heartbeat file, or the column is already ahead of it.
 */
export function nextLastActive(current: string | null, heartbeatMs: number): string | null {
  if (!heartbeatMs) return null;
  if (current !== null) {
    const recorded = Date.parse(current);
    if (!Number.isNaN(recorded) && recorded >= heartbeatMs) return null;
  }
  return new Date(heartbeatMs).toISOString();
}

function heartbeatMtimeMs(agentGroupId: string, sessionId: string): number {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    return fs.statSync(hbPath).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Does the container currently have background work in flight that it has
 * vouched for recently? Both halves matter: a count of zero means nothing is
 * delegated, and a count nobody re-stamped within BACKGROUND_REPORT_FRESH_MS
 * is a leftover from a container that has since gone quiet.
 */
function hasLiveBackgroundWork(state: ContainerState | null, now: number): boolean {
  if (!state || !state.background_tasks) return false;
  if (!state.updated_at) return false;
  const stampedAt = parseSqliteUtc(state.updated_at);
  if (Number.isNaN(stampedAt)) return false;
  return now - stampedAt <= BACKGROUND_REPORT_FRESH_MS;
}

function bashTimeoutMs(state: ContainerState | null): number | null {
  if (!state || state.current_tool !== 'Bash') return null;
  return typeof state.tool_declared_timeout_ms === 'number' ? state.tool_declared_timeout_ms : null;
}

function enforceRunningContainerSla(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  agentGroupId: string,
): void {
  const decision = decideStuckAction({
    now: Date.now(),
    heartbeatMtimeMs: heartbeatMtimeMs(agentGroupId, session.id),
    containerStartedAtMs: containerStartedAtMs(session.id),
    containerState: getContainerState(outDb),
    claims: getProcessingClaims(outDb),
  });

  if (decision.action === 'ok') return;

  if (decision.action === 'kill-ceiling') {
    log.warn('Killing container past absolute ceiling', {
      sessionId: session.id,
      heartbeatAgeMs: decision.heartbeatAgeMs,
      ceilingMs: decision.ceilingMs,
    });
    killContainer(session.id, 'absolute-ceiling');
    resetStuckProcessingRows(inDb, outDb, session, 'absolute-ceiling');
    return;
  }

  log.warn('Killing container — message claimed then silent', {
    sessionId: session.id,
    messageId: decision.messageId,
    claimAgeMs: decision.claimAgeMs,
    toleranceMs: decision.toleranceMs,
  });
  killContainer(session.id, 'claim-stuck');
  resetStuckProcessingRows(inDb, outDb, session, 'claim-stuck');
}

export function _resetStuckProcessingRowsForTesting(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  reason: string,
): void {
  resetStuckProcessingRows(inDb, outDb, session, reason, outDb);
}

function resetStuckProcessingRows(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  reason: string,
  writableOutDb?: Database.Database,
): void {
  const claims = getProcessingClaims(outDb);
  const now = Date.now();
  for (const { message_id } of claims) {
    const msg = getMessageForRetry(inDb, message_id, 'pending');
    if (!msg) continue;

    // Already rescheduled for a future retry — don't bump tries again. The
    // wake path (sweep step 2) will fire when process_after elapses and a
    // fresh container will clean the orphan claim on startup.
    if (msg.processAfter && parseSqliteUtc(msg.processAfter) > now) continue;

    if (msg.tries >= MAX_TRIES) {
      markMessageFailed(inDb, msg.id);
      log.warn('Message marked as failed after max retries', {
        messageId: msg.id,
        sessionId: session.id,
        reason,
      });
    } else {
      const backoffMs = BACKOFF_BASE_MS * Math.pow(2, msg.tries);
      const backoffSec = Math.floor(backoffMs / 1000);
      retryWithBackoff(inDb, msg.id, backoffSec);
      log.info('Reset stale message with backoff', {
        messageId: msg.id,
        tries: msg.tries,
        backoffMs,
        reason,
      });
    }
  }

  // Drop the orphan 'processing' rows. Without this, the next sweep tick
  // would re-read them, see the old status_changed timestamp, conclude the
  // freshly respawned container is stuck, and SIGKILL it before its
  // agent-runner has a chance to run clearStaleProcessingAcks() on startup.
  const ownsDb = !writableOutDb;
  let useDb: Database.Database | null = writableOutDb ?? null;
  try {
    if (!useDb) useDb = openOutboundDbRw(session.agent_group_id, session.id);
    const cleared = deleteOrphanProcessingClaims(useDb);
    if (cleared > 0) {
      log.info('Cleared orphan processing claims', { sessionId: session.id, cleared, reason });
    }
  } catch (err) {
    log.warn('Failed to clear orphan processing claims', { sessionId: session.id, err });
  } finally {
    if (ownsDb) useDb?.close();
  }
}
