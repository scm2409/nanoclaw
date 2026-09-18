/**
 * When a rejected turn gets another chance, and how long it waits for it.
 *
 * Two shapes of rejection arrive here. Anthropic's own reports a reset time
 * through the SDK's `rate_limit_event`, and the retry simply waits for it. A
 * gateway in front of the model does not: OpenRouter answers 429 with
 * `retry-after: 2` and `limit_source: "upstream_provider_shared_pool"` — a
 * pool shared with everyone else's traffic — and the SDK surfaces that only as
 * the turn's error text. Without a reset time the auto-resume never armed at
 * all: `Scheduled usage-limit retry` appears zero times across this install's
 * entire container-log history, while the Deck sweep lost five ticks to 429 in
 * 36 hours, each one simply gone.
 *
 * So the second shape gets a backoff of our own. It grows, because the SDK has
 * already spent ten internal retries inside twenty seconds by the time the turn
 * dies — seconds are demonstrably not the timescale on which a shared pool
 * frees up.
 */

/**
 * Wait before each successive attempt on a gateway rejection. Indexed by how
 * many auto-retries this turn has already had; the length is the cap, so a
 * provider that stays overloaded produces four wakes in total and then stops.
 */
export const RATE_LIMIT_BACKOFF_MS = [2 * 60_000, 10 * 60_000, 30 * 60_000];

/**
 * A rejection of *this* turn, as rendered by the CLI: "API Error: Request
 * rejected (429) · Provider returned error".
 *
 * Anchored on the API-error line rather than a bare `429` so a turn whose text
 * merely quotes the number — an HTTP status in a log the agent just read —
 * cannot arm a retry. Mirrors UPSTREAM_RATE_LIMIT_RE in providers/claude.ts,
 * which decides the same question for the mid-turn provider-pin restart.
 */
const UPSTREAM_RATE_LIMIT_RE = /API Error[^\n]*\b429\b|\b429\b[^\n]*(rate.?limit|rejected|overload)/i;

export interface RateLimitRetryPlan {
  /** Epoch ms the container asks the host to wake it at. */
  resetsAt: number;
  /**
   * Whether the host should add its safety margin on top. True for a
   * provider-reported counter (land past the rollover, not on its edge), false
   * when the delay above is already our own considered wait.
   */
  applyBuffer: boolean;
}

/**
 * Decide whether a finished turn earns another attempt, and when.
 *
 * Returns null for anything that waiting cannot fix: an out-of-credits quota
 * (that clears by paying, not by time), a failure that is not a rate limit at
 * all, or a turn that has already used its retries.
 */
export function planRateLimitRetry(args: {
  classification?: string;
  resetsAt?: number;
  errorText?: string | null;
  retryCount: number;
  now?: number;
}): RateLimitRetryPlan | null {
  const { classification, resetsAt, errorText, retryCount } = args;
  if (classification === 'quota') return null;
  if (retryCount >= RATE_LIMIT_BACKOFF_MS.length) return null;

  if (classification === 'rate_limit' && typeof resetsAt === 'number') {
    return { resetsAt, applyBuffer: true };
  }

  if (typeof errorText === 'string' && UPSTREAM_RATE_LIMIT_RE.test(errorText)) {
    const now = args.now ?? Date.now();
    return { resetsAt: now + RATE_LIMIT_BACKOFF_MS[retryCount]!, applyBuffer: false };
  }

  return null;
}
