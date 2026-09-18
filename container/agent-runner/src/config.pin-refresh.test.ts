/**
 * The provider pin is the one config field the host rewrites under a running
 * container: `provider_pins` is refreshed daily from the gateway's roster and
 * re-materialized into container.json, which is mounted (not copied) into the
 * container. Everything else in that file changes only through a path that
 * respawns the container anyway.
 *
 * So the pin — and only the pin — is read fresh instead of from the startup
 * cache. Observed live (2026-09-18): a container that had been up for two days
 * still sent the roster from its spawn day, and 101 of its 155 requests came
 * back 429 from a provider the current roster no longer names.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readProviderPin } from './config.js';

const PIN_A = { only: ['openai', 'wafer'], allow_fallbacks: true };
const PIN_B = { only: ['inference-net', 'relace'], allow_fallbacks: true };

let tmp: string;
let configPath: string;

function write(value: unknown): void {
  fs.writeFileSync(configPath, JSON.stringify({ provider: 'claude', providerPin: value }));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'config-pin-refresh-'));
  configPath = path.join(tmp, 'container.json');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('readProviderPin', () => {
  it('sees a pin the host rewrote after startup', () => {
    write(PIN_A);
    expect(readProviderPin(configPath)).toEqual(PIN_A);

    write(PIN_B);
    expect(readProviderPin(configPath)).toEqual(PIN_B);
  });

  it('refuses a malformed pin rather than passing it to the gateway', () => {
    // An empty allowlist permits nothing, which is a 404 for every model.
    write({ only: [], allow_fallbacks: true });
    expect(readProviderPin(configPath)).toBeUndefined();

    write({ only: ['relace'] });
    expect(readProviderPin(configPath)).toBeUndefined();
  });

  it('returns nothing when the file is absent or unreadable', () => {
    expect(readProviderPin(path.join(tmp, 'nope.json'))).toBeUndefined();

    fs.writeFileSync(configPath, 'not json');
    expect(readProviderPin(configPath)).toBeUndefined();
  });
});
