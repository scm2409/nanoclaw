/**
 * A turn rejected with a provider quota error (402/403 budget, key or credit
 * limit) gets no timed retry — unlike a 429, no known interval fixes it. It
 * clears when the operator raises the limit, and only they know when. But
 * "no retry" left the rejection invisible to the agent: the first wake after
 * the limit was raised started from scratch, with no record that the ticks in
 * between never ran. The 403 night of 19.–20.09.2026 cost the Deck sweep six
 * failed ticks, and the agent only pieced the outage together by hand from
 * run logs — after the fact.
 *
 * So a quota rejection queues a note instead of a wake: the container writes
 * a `queue_quota_recovery_note` system action, and the host turns it into a
 * trigger=0 inbound row (see src/modules/quota-recovery-note.ts) — accumulated
 * context that never wakes anything on its own but rides along with the next
 * wake that happens for another reason. The first successful tick after the
 * limit raise reads it.
 */

/**
 * A quota rejection of *this* turn, as rendered by the CLI. Anchored on the
 * API-error line and, for 403, on a limit keyword sharing that line: a bare
 * 403 is an authentication failure, not an exhausted budget, and "waiting for
 * the operator to raise the limit" would be nonsense advice there. Both
 * production shapes seen on this install match — the workspace budget
 * ("Budget limit exceeded") and the per-key monthly cap ("Key limit
 * exceeded").
 *
 * Same-line discipline mirrors UPSTREAM_RATE_LIMIT_RE in providers/claude.ts,
 * which decides the same question for 429s: a turn whose text merely quotes
 * the number from a log it read cannot arm anything — and in practice cannot
 * here either, since this is only consulted for the turn's own error results.
 */
const BUDGET_402_RE = /\bAPI Error[^\n]*\b402\b/;
const LIMIT_403_RE = /\bAPI Error[^\n]*\b403\b[^\n]*(?:budget|spend|credit|quota|limit)/i;

/**
 * Decide whether a finished turn's rejection is a quota exhaustion worth a
 * recovery note. `classification` comes from the provider's rate_limit_event
 * (Anthropic-native path); the text check covers gateways like OpenRouter,
 * which surface the rejection only as the turn's error text.
 */
export function isQuotaRejection(
  errorText: string | null | undefined,
  classification?: string,
): boolean {
  if (classification === 'quota') return true;
  if (typeof errorText !== 'string') return false;
  return BUDGET_402_RE.test(errorText) || LIMIT_403_RE.test(errorText);
}

/**
 * The note's wording, per what was rejected. Kept free of wire detail (status
 * codes, provider names): the note rides into a prompt the agent may quote
 * back to the user, and it must describe the situation, not the HTTP layer.
 */
export function quotaRecoveryNoteText(routing: { taskRun: boolean }): string {
  if (routing.taskRun) {
    return (
      'The previous scheduled run(s) of this series were rejected with a provider ' +
      'quota error (budget or key limit exhausted) and never executed. This note was ' +
      'queued back then; reading it means the model is reachable again. Check what those ' +
      'rejected runs were meant to do and carry it out, per this series’ own instructions.'
    );
  }
  return (
    'Your previous turn was rejected with a provider quota error (budget or key limit ' +
    'exhausted) before it executed, so messages delivered into it went unread. This note ' +
    'was queued back then; reading it means the model is reachable again. Ask the user to ' +
    'repeat anything that went unanswered.'
  );
}
