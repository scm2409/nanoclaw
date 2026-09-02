/**
 * Failure-streak detection for recurring task runs.
 *
 * A scheduled series that wakes hourly and fails the same way every time is
 * the worst shape of failure this system has: it is busy, it is expensive, it
 * looks alive, and it raises nothing. One such series ran 53 consecutive
 * blocked runs across two days while `ncl tasks list` reported `FAILED 0` —
 * because "failed" meant "no run log arrived", and a run that cleanly reports
 * it could not do its job produces a run log like any other.
 *
 * This closes that gap on the host side, deliberately. An agent that is broken
 * cannot be relied on to report that it is broken; the host can, because it
 * sees every run's outcome regardless of what the agent concluded about it.
 *
 * What counts as a failure is kept narrow on purpose — see `classifyRunText`.
 */
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import { notifyRunHealth } from './run-health-notify.js';

export const RUN_HEALTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS task_run_health (
  agent_group_id TEXT NOT NULL,
  series_id      TEXT NOT NULL,
  signature      TEXT,
  class          TEXT,
  streak         INTEGER NOT NULL DEFAULT 0,
  excerpt        TEXT,
  first_seen     TEXT,
  last_seen      TEXT,
  notified_at    TEXT,
  PRIMARY KEY (agent_group_id, series_id)
);
`;

export interface RunHealthRow {
  agent_group_id: string;
  series_id: string;
  signature: string | null;
  class: string | null;
  streak: number;
  excerpt: string | null;
  first_seen: string | null;
  last_seen: string | null;
  notified_at: string | null;
}

export interface RunFailure {
  /** Coarse family, drives the streak threshold. */
  class: string;
  /** Stable key: same underlying failure ⇒ same signature, whatever the prose around it. */
  signature: string;
  /** The matched text itself, for the notification. */
  excerpt: string;
}

/**
 * Consecutive failures before one notification goes out.
 *
 * `rate-limit` is deliberately far higher. The owner's standing instruction is
 * that the 5-hour token window resets on its own and must not prompt a
 * question — so a handful in a row is normal operation. Twelve in a row is
 * past any window and means it is genuinely stuck.
 */
const THRESHOLDS: Record<string, number> = { 'rate-limit': 12 };
const DEFAULT_THRESHOLD = 3;

/** Longest excerpt kept. Enough for a provider error line, not a whole log. */
const EXCERPT_MAX = 400;

/**
 * Decide whether a run's final text reports a failure.
 *
 * Only markers emitted by the runner or the provider count. Model-authored
 * prose is explicitly not a signal: it is phrased differently every run, it
 * changes language, and in the incident that motivated this it stated a
 * confident and completely wrong cause ("the DokuWiki endpoint is
 * unreachable") for what was a schema rejection. Matching on it would produce
 * both false positives on healthy no-op runs and false confidence about why.
 */
export function classifyRunText(text: string): RunFailure | null {
  if (!text) return null;

  // `API Error: <status> …` — emitted by the runner around the provider call.
  const api = /API Error:\s*(\d{3})\b/.exec(text);
  if (api) {
    return { class: 'api-error', signature: `api-error:${api[1]}`, excerpt: excerptAround(text, api.index) };
  }

  // Provider-side usage stops. Both strings come from the provider verbatim.
  const limit = /(hit your org's monthly spend limit|Rate limit \[[a-z_]+\])/i.exec(text);
  if (limit) {
    return { class: 'rate-limit', signature: 'rate-limit', excerpt: excerptAround(text, limit.index) };
  }

  return null;
}

function excerptAround(text: string, at: number): string {
  return text.slice(at, at + EXCERPT_MAX).trim();
}

export function getRunHealth(agentGroupId: string, series: string): RunHealthRow | undefined {
  return getDb()
    .prepare('SELECT * FROM task_run_health WHERE agent_group_id = ? AND series_id = ?')
    .get(agentGroupId, series) as RunHealthRow | undefined;
}

/**
 * Record one finished run and raise a notification when a failure has repeated
 * past its threshold. Exactly one notification per distinct failure: the
 * streak keeps climbing silently after that, and a different failure — or a
 * healthy run — re-arms it.
 *
 * Never throws. This runs inside delivery; a diagnostics failure must not turn
 * a delivered message into a retried one.
 */
export async function recordRunOutcome(agentGroupId: string, series: string, text: string): Promise<void> {
  try {
    const now = new Date().toISOString();
    const failure = classifyRunText(text);
    const prev = getRunHealth(agentGroupId, series);

    if (!failure) {
      // Healthy run clears the streak and re-arms notification.
      getDb()
        .prepare(
          `INSERT INTO task_run_health (agent_group_id, series_id, signature, class, streak, excerpt, first_seen, last_seen, notified_at)
           VALUES (?, ?, NULL, NULL, 0, NULL, NULL, ?, NULL)
           ON CONFLICT(agent_group_id, series_id) DO UPDATE SET
             signature = NULL, class = NULL, streak = 0, excerpt = NULL,
             first_seen = NULL, last_seen = excluded.last_seen, notified_at = NULL`,
        )
        .run(agentGroupId, series, now);
      return;
    }

    const continuing = prev?.signature === failure.signature;
    const streak = continuing ? prev!.streak + 1 : 1;
    const firstSeen = continuing ? (prev!.first_seen ?? now) : now;
    const notifiedAt = continuing ? prev!.notified_at : null;

    getDb()
      .prepare(
        `INSERT INTO task_run_health (agent_group_id, series_id, signature, class, streak, excerpt, first_seen, last_seen, notified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_group_id, series_id) DO UPDATE SET
           signature = excluded.signature, class = excluded.class, streak = excluded.streak,
           excerpt = excluded.excerpt, first_seen = excluded.first_seen,
           last_seen = excluded.last_seen, notified_at = excluded.notified_at`,
      )
      .run(agentGroupId, series, failure.signature, failure.class, streak, failure.excerpt, firstSeen, now, notifiedAt);

    const threshold = THRESHOLDS[failure.class] ?? DEFAULT_THRESHOLD;
    if (streak < threshold || notifiedAt) return;

    // Mark notified before delivering. A delivery that throws must not leave
    // the row un-notified, or every subsequent run retries the notification.
    getDb()
      .prepare('UPDATE task_run_health SET notified_at = ? WHERE agent_group_id = ? AND series_id = ?')
      .run(now, agentGroupId, series);

    await notifyRunHealth({
      agentGroupId,
      series,
      signature: failure.signature,
      class: failure.class,
      streak,
      firstSeen,
      excerpt: failure.excerpt,
    });
  } catch (err) {
    log.warn('Run-health accounting failed', { agentGroupId, series, err });
  }
}
