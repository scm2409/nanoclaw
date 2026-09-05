/**
 * Provider pinning: bound which upstream endpoints a gateway may route to.
 *
 * A gateway serves one model from many provider endpoints at different prices —
 * `glm-5.3-flash` from 23, the cheapest four at $0.075/M and the rest at up to
 * twice that. Left alone the router picks; measured over five turns, that cost
 * $0.00286 against $0.00143 with the cheapest tier pinned and the session
 * header holding one endpoint inside it.
 *
 * The dangerous part is `provider.only`: a list containing no provider that
 * serves the requested model is a 404, **even with `allow_fallbacks: true`**
 * (measured). One container's env applies to every model it uses, subagents
 * included, so the pin must be the union across all of them and must fail open
 * whenever that union cannot be built completely.
 */
import { describe, expect, it } from 'vitest';

import {
  CACHE_UNRELIABLE_PROVIDERS,
  buildProviderPin,
  cheapestTierPrice,
  cheapestTierProviders,
  type ProviderPinRow,
} from './provider-pins.js';

const endpoint = (tag: string, prompt: number, extra: Record<string, unknown> = {}) => ({
  tag,
  provider_name: tag.split('/')[0],
  pricing: { prompt: String(prompt) },
  status: 0,
  ...extra,
});

describe('cheapestTierProviders', () => {
  it('takes the provider slug from the tag, before the quantisation suffix', () => {
    const eps = [endpoint('z-ai/fp8', 7.5e-8), endpoint('wafer', 7.5e-8)];
    expect(cheapestTierProviders(eps)).toEqual(['wafer', 'z-ai']);
  });

  it('keeps only the cheapest price tier', () => {
    const eps = [
      endpoint('gmicloud/fp8', 7.5e-8),
      endpoint('novita/fp8', 7.5e-8),
      endpoint('wafer', 1.0e-7),
      endpoint('morph/fp8', 1.3e-7),
    ];
    expect(cheapestTierProviders(eps)).toEqual(['gmicloud', 'novita']);
  });

  it('skips endpoints the gateway reports as unhealthy', () => {
    // A negative status means deranked or down; pinning to it would trade a
    // price saving for failed turns.
    const eps = [endpoint('z-ai/fp8', 7.5e-8, { status: -1 }), endpoint('novita/fp8', 7.5e-8)];
    expect(cheapestTierProviders(eps)).toEqual(['novita']);
  });

  it('de-duplicates a provider that serves several quantisations', () => {
    const eps = [endpoint('novita/fp8', 7.5e-8), endpoint('novita/bf16', 7.5e-8)];
    expect(cheapestTierProviders(eps)).toEqual(['novita']);
  });

  it('returns nothing when no endpoint carries a usable price', () => {
    expect(cheapestTierProviders([])).toEqual([]);
    expect(cheapestTierProviders([{ tag: 'x', pricing: {} } as never])).toEqual([]);
    expect(cheapestTierProviders([endpoint('free/one', 0)])).toEqual([]);
  });
});

describe('buildProviderPin', () => {
  const fresh = (model: string, providers: string[]): ProviderPinRow => ({
    model,
    providers,
    cheapest_price: 7.5e-8,
    refreshed_at: new Date().toISOString(),
  });

  it('unions the tiers of every model the group uses', () => {
    // The gateway intersects `only` with each model's own providers, so one
    // union serves them all: glm gets its cheap four, gpt gets openai.
    const pin = buildProviderPin(
      ['z-ai/glm-5.3-flash', 'openai/gpt-5.6-sol'],
      [fresh('z-ai/glm-5.3-flash', ['z-ai', 'novita']), fresh('openai/gpt-5.6-sol', ['openai'])],
    );
    expect(pin).toEqual({ only: ['novita', 'openai', 'z-ai'], allow_fallbacks: true });
  });

  it('fails open when a model has no pin at all', () => {
    // A partial union is worse than none: it would 404 the unlisted model.
    expect(buildProviderPin(['a/one', 'b/two'], [fresh('a/one', ['x'])])).toBeNull();
  });

  it('fails open when a model has an empty provider list', () => {
    expect(buildProviderPin(['a/one'], [fresh('a/one', [])])).toBeNull();
  });

  it('fails open when a pin is older than the freshness window', () => {
    const stale: ProviderPinRow = {
      model: 'a/one',
      providers: ['x'],
      cheapest_price: 1,
      refreshed_at: new Date(Date.now() - 50 * 3600_000).toISOString(),
    };
    expect(buildProviderPin(['a/one'], [stale])).toBeNull();
    expect(buildProviderPin(['a/one'], [stale], { maxAgeHours: 72 })).toEqual({
      only: ['x'],
      allow_fallbacks: true,
    });
  });

  it('fails open on an empty model list rather than emitting an empty allowlist', () => {
    expect(buildProviderPin([], [])).toBeNull();
  });

  it('always allows fallbacks, so a whole tier going down degrades in price not availability', () => {
    const pin = buildProviderPin(['a/one'], [fresh('a/one', ['x'])]);
    expect(pin?.allow_fallbacks).toBe(true);
  });
});

/**
 * Price is not the only property of an endpoint that costs money. Measured on
 * 2026-09-05, same model, same prompt, six turns each: z-ai read its prefix
 * back on five of six turns, novita on three, deepinfra returned a 46% partial
 * read, and gmicloud on one. A cheapest-tier pin that keeps gmicloud is a pin
 * that pays full input price on most turns — dearer than the endpoint it
 * undercut by a tenth of a cent.
 */
describe('providers that do not cache', () => {
  it('names the measured offender so a refresh cannot pick it up again', () => {
    expect(CACHE_UNRELIABLE_PROVIDERS['z-ai/glm-5.3-flash']).toEqual(expect.arrayContaining(['gmicloud', 'deepinfra']));
  });

  it('leaves the cheapest tier alone when nothing in it is denied', () => {
    const eps = [endpoint('z-ai/fp8', 7.5e-8), endpoint('novita/fp8', 7.5e-8)];
    expect(cheapestTierProviders(eps, ['gmicloud'])).toEqual(['novita', 'z-ai']);
  });

  it('drops a denied provider from the tier it would otherwise share', () => {
    const eps = [endpoint('gmicloud/fp8', 7.5e-8), endpoint('z-ai/fp8', 7.5e-8)];
    expect(cheapestTierProviders(eps, ['gmicloud'])).toEqual(['z-ai']);
  });

  it('moves up to the next price tier rather than returning nothing', () => {
    // Denying the whole cheapest tier must not unpin the group: unpinned means
    // routing bounces across every endpoint, which is the more expensive
    // failure. A tenth of a cent more per million buys a cache that works.
    const eps = [endpoint('gmicloud/fp8', 7.5e-8), endpoint('novita/fp8', 1.0e-7), endpoint('wafer', 1.3e-7)];
    expect(cheapestTierProviders(eps, ['gmicloud'])).toEqual(['novita']);
  });

  it('filters a stored pin too, so the fix does not wait for the next refresh', () => {
    const row: ProviderPinRow = {
      model: 'z-ai/glm-5.3-flash',
      providers: ['deepinfra', 'gmicloud', 'novita', 'z-ai'],
      cheapest_price: 7.5e-8,
      refreshed_at: new Date().toISOString(),
    };
    expect(buildProviderPin(['z-ai/glm-5.3-flash'], [row])).toEqual({
      only: ['novita', 'z-ai'],
      allow_fallbacks: true,
    });
  });

  it('fails open when a stored pin holds nothing but denied providers', () => {
    const row: ProviderPinRow = {
      model: 'z-ai/glm-5.3-flash',
      providers: ['gmicloud'],
      cheapest_price: 7.5e-8,
      refreshed_at: new Date().toISOString(),
    };
    expect(buildProviderPin(['z-ai/glm-5.3-flash'], [row])).toBeNull();
  });
});

describe('cheapestTierPrice', () => {
  it('reports the price of the tier actually pinned, not of one that was denied', () => {
    // The stored price is what an operator reads when asking why a group pays
    // what it pays. Quoting a price from an endpoint the pin refuses to use
    // would make that column a lie.
    const eps = [endpoint('gmicloud/fp8', 7.5e-8), endpoint('novita/fp8', 1.0e-7)];
    expect(cheapestTierPrice(eps, ['gmicloud'])).toBe(1.0e-7);
  });

  it('returns null when nothing is priced', () => {
    expect(cheapestTierPrice([endpoint('z-ai/fp8', 0)], [])).toBeNull();
  });
});
