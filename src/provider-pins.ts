/**
 * Provider pinning — bound which upstream endpoints the gateway may route to.
 *
 * A gateway fronting many providers for one model picks an endpoint per
 * request, and endpoints differ in price: `glm-5.3-flash` is served by 23, the
 * cheapest four at $0.075/M and others at up to twice that. A prompt cache also
 * lives on the endpoint that wrote it, so bouncing costs twice over. Measured
 * across five turns of the same conversation:
 *
 *   nothing                                   $0.00286
 *   session header only                       $0.00462   (pinned to a dear endpoint)
 *   cheapest-tier `provider.only` only        $0.00222   (bounced within the tier)
 *   cheapest tier + session header            $0.00143
 *
 * The two are complementary: `provider.only` bounds the price tier, the
 * `x-session-id` header holds one endpoint inside it (see `stickySessionEnv`).
 *
 * **`provider.only` is sharp.** A list containing no provider that serves the
 * requested model returns 404 — `allow_fallbacks: true` does not rescue it
 * (measured). One container's env applies to every model it runs, subagents
 * included, so the pin is the union across all of them and is omitted entirely
 * whenever that union cannot be built. Failing open costs money; failing
 * closed breaks a subagent silently.
 *
 * Refreshed on a daily cadence from the host sweep rather than per container
 * start: a spawn-time fetch that half-fails would emit a partial union, which
 * is the one shape that breaks things.
 */
import { getDb } from './db/connection.js';
import { log } from './log.js';

/** How long a stored pin stays usable. Two days of slack on a daily refresh. */
const DEFAULT_MAX_AGE_HOURS = 48;

/** Refresh cadence for the host sweep. */
export const PROVIDER_PIN_REFRESH_INTERVAL_MS = 24 * 3600_000;

export interface ProviderPinRow {
  model: string;
  providers: string[];
  cheapest_price: number;
  refreshed_at: string;
}

export interface ProviderPin {
  only: string[];
  allow_fallbacks: boolean;
}

/** The endpoint shape we consume from `/api/v1/models/<model>/endpoints`. */
interface Endpoint {
  tag?: string;
  provider_name?: string;
  pricing?: { prompt?: string | number };
  status?: number;
}

/**
 * The provider slugs serving a model at its cheapest prompt price.
 *
 * The slug `provider.only` expects is the part of `tag` before the
 * quantisation suffix (`z-ai/fp8` -> `z-ai`), not the display `provider_name`
 * (`Z.AI`) — the two differ and only the slug is accepted.
 *
 * Unhealthy endpoints are dropped: a negative `status` means deranked or down,
 * and pinning to one trades a price saving for failed turns. A zero or missing
 * price is not a tier, it is missing data.
 */
export function cheapestTierProviders(endpoints: Endpoint[]): string[] {
  const priced: Array<{ slug: string; price: number }> = [];
  for (const e of endpoints) {
    if (typeof e.status === 'number' && e.status < 0) continue;
    const price = Number(e.pricing?.prompt);
    if (!Number.isFinite(price) || price <= 0) continue;
    const tag = e.tag ?? '';
    const slug = tag.split('/')[0]?.trim();
    if (!slug) continue;
    priced.push({ slug, price });
  }
  if (priced.length === 0) return [];
  const cheapest = Math.min(...priced.map((p) => p.price));
  return [...new Set(priced.filter((p) => p.price === cheapest).map((p) => p.slug))].sort();
}

/**
 * The pin for a group, as the union of its models' cheapest tiers.
 *
 * Returns null — meaning "send no `provider` field at all" — unless every
 * model has a fresh, non-empty entry. See the note on sharpness above.
 */
export function buildProviderPin(
  models: string[],
  pins: ProviderPinRow[],
  options: { maxAgeHours?: number; now?: Date } = {},
): ProviderPin | null {
  const wanted = [...new Set(models.filter(Boolean))];
  if (wanted.length === 0) return null;
  const maxAgeMs = (options.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS) * 3600_000;
  const now = (options.now ?? new Date()).getTime();
  const byModel = new Map(pins.map((p) => [p.model, p]));

  const only = new Set<string>();
  for (const model of wanted) {
    const pin = byModel.get(model);
    if (!pin || pin.providers.length === 0) return null;
    const age = now - Date.parse(pin.refreshed_at);
    if (!Number.isFinite(age) || age > maxAgeMs) return null;
    for (const slug of pin.providers) only.add(slug);
  }
  // Fallbacks stay on: if a whole tier is down, degrade in price rather than
  // in availability.
  return { only: [...only].sort(), allow_fallbacks: true };
}

export function getProviderPins(models: string[]): ProviderPinRow[] {
  const wanted = [...new Set(models.filter(Boolean))];
  if (wanted.length === 0) return [];
  const placeholders = wanted.map(() => '?').join(',');
  const rows = getDb()
    .prepare(
      `SELECT model, providers, cheapest_price, refreshed_at FROM provider_pins WHERE model IN (${placeholders})`,
    )
    .all(...wanted) as Array<{ model: string; providers: string; cheapest_price: number; refreshed_at: string }>;
  return rows.map((r) => ({
    model: r.model,
    providers: JSON.parse(r.providers) as string[],
    cheapest_price: r.cheapest_price,
    refreshed_at: r.refreshed_at,
  }));
}

function upsertProviderPin(row: ProviderPinRow): void {
  getDb()
    .prepare(
      `INSERT INTO provider_pins (model, providers, cheapest_price, refreshed_at)
       VALUES (@model, @providers, @cheapest_price, @refreshed_at)
       ON CONFLICT(model) DO UPDATE SET
         providers = excluded.providers,
         cheapest_price = excluded.cheapest_price,
         refreshed_at = excluded.refreshed_at`,
    )
    .run({
      model: row.model,
      providers: JSON.stringify(row.providers),
      cheapest_price: row.cheapest_price,
      refreshed_at: row.refreshed_at,
    });
}

/** Endpoint listing for one model. Injectable so the refresh is testable offline. */
export type EndpointFetcher = (model: string) => Promise<Endpoint[]>;

async function fetchEndpoints(model: string): Promise<Endpoint[]> {
  const res = await fetch(`https://openrouter.ai/api/v1/models/${model}/endpoints`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { endpoints?: Endpoint[] } };
  return body.data?.endpoints ?? [];
}

/**
 * Refresh the stored pin for each model. Per-model failures are logged and
 * skipped: the previous snapshot stays, and a model with no snapshot simply
 * keeps its group unpinned.
 */
export async function refreshProviderPins(
  models: string[],
  fetcher: EndpointFetcher = fetchEndpoints,
): Promise<number> {
  let updated = 0;
  for (const model of [...new Set(models.filter(Boolean))]) {
    try {
      const endpoints = await fetcher(model);
      const providers = cheapestTierProviders(endpoints);
      if (providers.length === 0) {
        log.warn('Provider pin refresh found no priced endpoints', { model });
        continue;
      }
      const cheapest = Math.min(
        ...endpoints.map((e) => Number(e.pricing?.prompt)).filter((p) => Number.isFinite(p) && p > 0),
      );
      upsertProviderPin({
        model,
        providers,
        cheapest_price: cheapest,
        refreshed_at: new Date().toISOString(),
      });
      updated += 1;
      log.debug('Provider pin refreshed', { model, providers, cheapest });
    } catch (err) {
      log.warn('Provider pin refresh failed', { model, err });
    }
  }
  return updated;
}
