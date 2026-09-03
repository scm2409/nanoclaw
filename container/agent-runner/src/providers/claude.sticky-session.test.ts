/**
 * Sticky routing for third-party gateways.
 *
 * OpenRouter serves one model from many provider endpoints — glm-5.3-flash has
 * 23, in two price tiers. A prompt cache lives on the endpoint that wrote it,
 * so a request that lands elsewhere pays full price. OpenRouter's default
 * conversation detection hashes the first system message, which is useless for
 * an agent whose system prompt carries a per-turn runtime addendum. The
 * documented fix is an `x-session-id` header, and the CLI can carry arbitrary
 * headers via ANTHROPIC_CUSTOM_HEADERS.
 *
 * Measured over 8 alternating calls on two distinct prefixes:
 *   no session id     6/8 cache hits, $0.00316, with a tier-2 excursion
 *   with session id   7/8 cache hits, $0.00194, no excursion
 *
 * One id per agent group, not per subagent: the id routes, the prompt prefix
 * is what keys the cache, so distinct prefixes coexist on one endpoint (cold
 * start measured identical either way) and every session of a group then
 * shares one warm tools+system prefix instead of warming several.
 */
import { describe, expect, it } from 'bun:test';

import { stickySessionEnv } from './claude.js';

describe('stickySessionEnv', () => {
  it('sets an x-session-id header derived from the agent group', () => {
    const env = stickySessionEnv('ag-123', { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' });
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe('x-session-id: nanoclaw-ag-123');
  });

  it('does nothing on a stock Anthropic install', () => {
    // No custom endpoint means no third-party router in the path, so there is
    // nothing to pin and no reason to send a header the API does not use.
    expect(stickySessionEnv('ag-123', {})).toEqual({});
  });

  it('leaves an operator-set header list alone but appends to it', () => {
    const env = stickySessionEnv('ag-123', {
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      ANTHROPIC_CUSTOM_HEADERS: 'x-tenant: acme',
    });
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe('x-tenant: acme\nx-session-id: nanoclaw-ag-123');
  });

  it('never overrides an operator who set x-session-id themselves', () => {
    const env = stickySessionEnv('ag-123', {
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      ANTHROPIC_CUSTOM_HEADERS: 'X-Session-Id: mine',
    });
    expect(env).toEqual({});
  });

  it('does nothing without an agent group id to key on', () => {
    expect(stickySessionEnv(undefined, { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' })).toEqual({});
    expect(stickySessionEnv('', { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' })).toEqual({});
  });

  it('keeps the value inside the 256-character limit the gateway documents', () => {
    const env = stickySessionEnv('ag-' + 'x'.repeat(400), { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' });
    const value = env.ANTHROPIC_CUSTOM_HEADERS!.split(': ')[1];
    expect(value.length).toBeLessThanOrEqual(256);
    // Truncation must stay deterministic, or the pin moves between restarts.
    expect(stickySessionEnv('ag-' + 'x'.repeat(400), { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' })).toEqual(env);
  });
});
