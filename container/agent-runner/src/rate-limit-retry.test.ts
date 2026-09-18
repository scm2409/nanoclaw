/**
 * A turn the gateway rejected outright is a lost wake unless something puts it
 * back on the clock.
 *
 * The SDK's own `rate_limit_event` carries a `resetsAt`, and the auto-resume
 * flow was built on it. A gateway in front of the model does not send one:
 * OpenRouter answers `429` with `retry-after: 2` and
 * `limit_source: "upstream_provider_shared_pool"`, and the SDK surfaces that
 * only as the turn's error text ("API Error: Request rejected (429) · Provider
 * returned error"). With no `resetsAt` the retry never armed — measured across
 * this install's whole container-log history, `Scheduled usage-limit retry`
 * appears zero times, while the Deck sweep lost five ticks to 429 in 36 hours.
 *
 * So a rejection we recognise but have no reset time for gets a backoff of our
 * own. It grows because the thing being waited on is someone else's traffic on
 * a shared pool, which two seconds does not fix — the SDK already spent ten
 * retries inside twenty seconds before the turn died.
 */
import { describe, expect, it } from 'bun:test';

import { RATE_LIMIT_BACKOFF_MS, planRateLimitRetry } from './rate-limit-retry.js';

const NOW = Date.parse('2026-09-18T10:00:00.000Z');
const UPSTREAM_429 = 'API Error: Request rejected (429) · Provider returned error';

describe('planRateLimitRetry', () => {
  it('uses the reset time the SDK reported when there is one', () => {
    const resetsAt = NOW + 60_000;
    expect(planRateLimitRetry({ classification: 'rate_limit', resetsAt, retryCount: 0, now: NOW })).toEqual({
      resetsAt,
      applyBuffer: true,
    });
  });

  it('backs off on its own for a gateway 429 that reports no reset time', () => {
    expect(planRateLimitRetry({ errorText: UPSTREAM_429, retryCount: 0, now: NOW })).toEqual({
      resetsAt: NOW + RATE_LIMIT_BACKOFF_MS[0]!,
      // Our own delay already is the wait; the buffer exists to clear a
      // provider-reported counter, and there is none here.
      applyBuffer: false,
    });
  });

  it('waits longer each time the same turn comes back rejected', () => {
    const first = planRateLimitRetry({ errorText: UPSTREAM_429, retryCount: 0, now: NOW })!;
    const second = planRateLimitRetry({ errorText: UPSTREAM_429, retryCount: 1, now: NOW })!;
    const third = planRateLimitRetry({ errorText: UPSTREAM_429, retryCount: 2, now: NOW })!;

    expect(second.resetsAt).toBeGreaterThan(first.resetsAt);
    expect(third.resetsAt).toBeGreaterThan(second.resetsAt);
  });

  it('gives up once the retry cap is spent', () => {
    // Guards against a provider that stays overloaded turning one wake into an
    // endless series of them.
    expect(planRateLimitRetry({ errorText: UPSTREAM_429, retryCount: 3, now: NOW })).toBeNull();
    expect(
      planRateLimitRetry({ classification: 'rate_limit', resetsAt: NOW + 60_000, retryCount: 3, now: NOW }),
    ).toBeNull();
  });

  it('never retries an out-of-credits rejection', () => {
    // Quota does not clear by waiting — it clears by paying.
    expect(
      planRateLimitRetry({ classification: 'quota', resetsAt: NOW + 60_000, retryCount: 0, now: NOW }),
    ).toBeNull();
  });

  it('leaves an unrelated failure alone', () => {
    expect(planRateLimitRetry({ errorText: 'API Error: 400 Provider returned error', retryCount: 0, now: NOW })).toBeNull();
    expect(planRateLimitRetry({ errorText: null, retryCount: 0, now: NOW })).toBeNull();
    // A 429 the agent is merely quoting — from a log it read, say — is not this
    // turn being rejected, so it must not arm a retry.
    expect(planRateLimitRetry({ errorText: 'the server log shows 429 responses', retryCount: 0, now: NOW })).toBeNull();
  });
});
