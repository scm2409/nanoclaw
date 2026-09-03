/**
 * The provider pin reaches the CLI through `CLAUDE_CODE_EXTRA_BODY`, which the
 * CLI merges into the request body verbatim (verified against the real binary:
 * the body arrives with a top-level `provider` key).
 *
 * That is the whole reason this is an env var and not a rewrite in our own
 * proxy — the CLI still builds its own request; we only hand it one more field.
 */
import { describe, expect, it } from 'bun:test';

import { providerPinEnv } from './claude.js';

const PIN = { only: ['z-ai', 'novita'], allow_fallbacks: true };
const CUSTOM = { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' };

describe('providerPinEnv', () => {
  it('puts the pin in CLAUDE_CODE_EXTRA_BODY under a provider key', () => {
    const env = providerPinEnv(PIN, CUSTOM);
    expect(JSON.parse(env.CLAUDE_CODE_EXTRA_BODY!)).toEqual({ provider: PIN });
  });

  it('does nothing without a pin', () => {
    expect(providerPinEnv(undefined, CUSTOM)).toEqual({});
  });

  it('does nothing on a stock Anthropic install', () => {
    // No gateway in front means one upstream and nothing to bound.
    expect(providerPinEnv(PIN, {})).toEqual({});
  });

  it('never overrides an operator who set the extra body themselves', () => {
    // Their JSON may carry unrelated fields; merging blind could contradict a
    // deliberate routing choice.
    const env = providerPinEnv(PIN, { ...CUSTOM, CLAUDE_CODE_EXTRA_BODY: '{"provider":{"only":["mine"]}}' });
    expect(env).toEqual({});
  });

  it('refuses an empty allowlist', () => {
    // `only: []` permits nothing, which is a 404 for every model.
    expect(providerPinEnv({ only: [], allow_fallbacks: true }, CUSTOM)).toEqual({});
  });
});
