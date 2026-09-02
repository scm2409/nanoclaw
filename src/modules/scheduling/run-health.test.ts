/**
 * Tests for the task-run failure-streak detector.
 *
 * The failure it exists for: a recurring hourly sweep reported the same
 * blocker in its run text 53 times over 53 hours and raised nothing. `ncl
 * tasks list` showed `RUNS 769 / FAILED 0` throughout, because "failed" only
 * ever meant "the container never produced a run log" — not "the run said it
 * could not do its job."
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const notify = vi.hoisted(() => vi.fn());
vi.mock('./run-health-notify.js', () => ({ notifyRunHealth: notify }));
vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

let db: Database.Database;
vi.mock('../../db/connection.js', () => ({ getDb: () => db }));

import { classifyRunText, recordRunOutcome, getRunHealth, RUN_HEALTH_SCHEMA } from './run-health.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(RUN_HEALTH_SCHEMA);
  notify.mockClear();
});

// ── Classification ───────────────────────────────────────────────────────
//
// Only runner- and provider-emitted markers count. Model-authored prose is
// not a reliable failure signal: it varies run to run, changes language, and
// (as in the incident) confidently misattributes the cause.

describe('classifyRunText', () => {
  it('detects a provider API error and keys on its status code', () => {
    const c = classifyRunText('… Ergebnis: Weiterhin `API Error: 400 Provider returned error`.');
    expect(c?.class).toBe('api-error');
    expect(c?.signature).toBe('api-error:400');
  });

  it('gives the same signature to the same error wrapped in different prose', () => {
    const a = classifyRunText('Deck Sweep Summary — DokuWiki check: `API Error: 400 Provider returned error`');
    const b = classifyRunText('Work-Log: der Subagent meldet `API Error: 400 Provider returned error`.');
    expect(a?.signature).toBe(b!.signature);
  });

  it('separates different status codes', () => {
    expect(classifyRunText('API Error: 502 OneCLI gateway failed')?.signature).toBe('api-error:502');
    expect(classifyRunText('API Error: 400 Provider returned error')?.signature).toBe('api-error:400');
  });

  it('detects the spend-limit and rate-limit stops as their own class', () => {
    expect(classifyRunText("You've hit your org's monthly spend limit · ask your admin")?.class).toBe('rate-limit');
    expect(classifyRunText('Error: Rate limit [seven_day] (resets 2026-08-30T07:00:00.000Z)')?.class).toBe(
      'rate-limit',
    );
  });

  it('returns null for a normal run, including a no-op sweep', () => {
    expect(classifyRunText('Board unchanged since last check. Nothing actionable this run.')).toBeNull();
    expect(classifyRunText('Stack "To do" (ID 11): 0 Karten. Nichts zu tun.')).toBeNull();
    expect(classifyRunText('')).toBeNull();
  });

  it('does not treat model prose about a service being unavailable as a failure', () => {
    // This exact sentence ran hourly for two days and was wrong about the cause.
    expect(classifyRunText('Die Nextcloud-Deck-Tools stehen derzeit nicht zur Verfügung.')).toBeNull();
  });
});

// ── Streak accounting ────────────────────────────────────────────────────

describe('recordRunOutcome', () => {
  const err = 'API Error: 400 Provider returned error';

  it('counts consecutive identical failures', async () => {
    for (let i = 0; i < 3; i++) await recordRunOutcome('ag-1', 'sweep', err);
    expect(getRunHealth('ag-1', 'sweep')?.streak).toBe(3);
  });

  it('notifies once the streak reaches the threshold, then stays quiet', async () => {
    for (let i = 0; i < 8; i++) await recordRunOutcome('ag-1', 'sweep', err);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({
      agentGroupId: 'ag-1',
      series: 'sweep',
      signature: 'api-error:400',
      streak: 3,
    });
  });

  it('does not notify before the threshold', async () => {
    await recordRunOutcome('ag-1', 'sweep', err);
    await recordRunOutcome('ag-1', 'sweep', err);
    expect(notify).not.toHaveBeenCalled();
  });

  it('holds rate-limit failures to a longer streak — they clear themselves', async () => {
    // Standing rule from the owner: the 5h token window resets on its own, so
    // a handful in a row is normal and must not raise anything.
    const limit = "You've hit your org's monthly spend limit";
    for (let i = 0; i < 6; i++) await recordRunOutcome('ag-1', 'sweep', limit);
    expect(notify).not.toHaveBeenCalled();
    for (let i = 0; i < 6; i++) await recordRunOutcome('ag-1', 'sweep', limit);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('resets the streak on a healthy run', async () => {
    await recordRunOutcome('ag-1', 'sweep', err);
    await recordRunOutcome('ag-1', 'sweep', err);
    await recordRunOutcome('ag-1', 'sweep', 'Board unchanged. Nothing actionable.');
    expect(getRunHealth('ag-1', 'sweep')?.streak).toBe(0);

    await recordRunOutcome('ag-1', 'sweep', err);
    expect(getRunHealth('ag-1', 'sweep')?.streak).toBe(1);
  });

  it('restarts the count and re-arms notification when the failure changes', async () => {
    for (let i = 0; i < 4; i++) await recordRunOutcome('ag-1', 'sweep', err);
    expect(notify).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 3; i++) await recordRunOutcome('ag-1', 'sweep', 'API Error: 502 gateway');
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0]).toMatchObject({ signature: 'api-error:502', streak: 3 });
  });

  it('tracks each series separately', async () => {
    for (let i = 0; i < 3; i++) await recordRunOutcome('ag-1', 'sweep', err);
    await recordRunOutcome('ag-1', 'briefing', err);
    expect(getRunHealth('ag-1', 'sweep')?.streak).toBe(3);
    expect(getRunHealth('ag-1', 'briefing')?.streak).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('keeps the raw excerpt so the notification can carry the real error', async () => {
    await recordRunOutcome('ag-1', 'sweep', `prefix ${err} suffix`);
    expect(getRunHealth('ag-1', 'sweep')?.excerpt).toContain(err);
  });

  it('never throws when notification fails', async () => {
    notify.mockRejectedValueOnce(new Error('no delivery adapter'));
    for (let i = 0; i < 3; i++) {
      await expect(recordRunOutcome('ag-1', 'sweep', err)).resolves.toBeUndefined();
    }
  });
});
