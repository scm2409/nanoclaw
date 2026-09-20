/**
 * A turn rejected with a provider quota error (402/403 budget, key or credit
 * limit) gets no timed retry — unlike a 429, no known interval fixes it. But
 * "no retry" also left the rejection invisible to the agent: the first wake
 * after the operator raised the limit started from scratch, with no record
 * that the ticks in between never ran. The 403 night of 19.–20.09.2026 cost
 * the Deck sweep six failed ticks, and the agent only pieced the outage
 * together by hand from run logs — after the fact.
 *
 * So a quota rejection queues a note instead of a wake: the container writes
 * a `queue_quota_recovery_note` system action, and the host turns it into a
 * trigger=0 inbound row — accumulated context that never wakes anything on
 * its own but rides along with the next wake that happens for another reason.
 * The first successful tick after the limit raise reads it.
 */
import { describe, expect, it } from 'bun:test';

import { isQuotaRejection, quotaRecoveryNoteText } from './quota-recovery-note.js';

describe('isQuotaRejection', () => {
  it('recognises the OpenRouter budget-exhaustion text seen in production', () => {
    // The verbatim task_log line from the 403 night of 19.–20.09.2026.
    expect(
      isQuotaRejection(
        'Failed to authenticate. API Error: 403 Budget limit exceeded (monthly limit). Contact your org admin.',
      ),
    ).toBe(true);
  });

  it('recognises the per-key limit variant and a 402', () => {
    // Seen 2026-09-13: same shape, but the workspace *key* ran out rather than
    // the organisation budget — the operator fixes both the same way.
    expect(
      isQuotaRejection(
        'API Error: 403 Key limit exceeded (monthly limit). Manage it using https://openrouter.ai/workspaces/default/keys/x',
      ),
    ).toBe(true);
    expect(isQuotaRejection('API Error: 402 Payment Required · Not enough credits')).toBe(true);
  });

  it('does not mistake a plain auth 403 for a quota problem', () => {
    // A 403 without any limit keyword is an authentication failure — waiting
    // for the operator to "raise the limit" would be nonsense advice.
    expect(isQuotaRejection('API Error: 403 · authentication_failed')).toBe(false);
    expect(isQuotaRejection('Failed to authenticate. API Error: 403')).toBe(false);
  });

  it('does not fire on rate limits or unrelated failures', () => {
    // 429s have their own flow (the timed backoff in rate-limit-retry.ts).
    expect(isQuotaRejection('API Error: Request rejected (429) · Provider returned error')).toBe(false);
    expect(isQuotaRejection('API Error: 500 Provider returned error')).toBe(false);
    expect(isQuotaRejection(null)).toBe(false);
    expect(isQuotaRejection(undefined)).toBe(false);
  });

  it('honours an explicit quota classification from the provider', () => {
    // Anthropic's own rate_limit_event with credits_required classifies the
    // error even when the rendered text carries no "API Error" line.
    expect(isQuotaRejection('Out of credits', 'quota')).toBe(true);
  });

  it('does not match a keyword that appears on a different line', () => {
    // The quota wording must share a line with the status code — a turn whose
    // error text merely wraps onto unrelated lines must not queue a note.
    expect(isQuotaRejection('API Error: 403\nContact your org admin about the budget.')).toBe(false);
  });
});

describe('quotaRecoveryNoteText', () => {
  it('tells a task run to re-check its unexecuted work', () => {
    const text = quotaRecoveryNoteText({ taskRun: true });
    expect(text).toContain('scheduled run');
    expect(text).toContain('never executed');
  });

  it('tells a chat turn that the user was left hanging', () => {
    const text = quotaRecoveryNoteText({ taskRun: false });
    expect(text).toContain('quota');
    expect(text).toContain('repeat');
  });

  it('never mentions internal error details a user could see', () => {
    // These notes ride into a prompt the agent may quote back to the user;
    // they describe the situation, not wire-level detail.
    for (const taskRun of [true, false]) {
      expect(quotaRecoveryNoteText({ taskRun })).not.toMatch(/40[23]/);
    }
  });
});
