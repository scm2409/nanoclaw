/**
 * Live-server Matrix integration tests. NOT part of `pnpm test` (excluded in
 * vitest.config.ts) — these hit a real homeserver with a real throwaway
 * account and must be run explicitly: `pnpm test:matrix-live`.
 *
 * What this proves, against the real server rather than a fake adapter:
 *   1. The channel actually connects and syncs.
 *   2. A real encrypted DM round-trips through the live, already-running
 *      production NanoClaw host (the same account/session as every other
 *      channel).
 *   3. The crypto identity survives a genuine OS-process kill + respawn
 *      (not an in-process simulation) — the exact regression fixed earlier
 *      tonight in src/channels/matrix.ts's resolveThreadId.
 *   4. A corrupted local snapshot degrades gracefully (no crash) rather than
 *      wedging the channel, and — since its first spawn has no snapshot at
 *      all yet — this test's opening phase doubles as a from-scratch
 *      bootstrap check (MATRIX_RECOVERY_KEY alone restoring cross-signing
 *      trust for a brand new device).
 *
 * Requires MATRIX_TEST_USER_ID / MATRIX_TEST_PASSWORD / MATRIX_TEST_RECOVERY_KEY
 * (a dedicated throwaway Matrix account — see .env) and MATRIX_BASE_URL /
 * MATRIX_USER_ID (the real bot's identity, used as the round-trip peer).
 * The production NanoClaw host must be running for tests 2 and 3 — they
 * wait for a reply from its live agent pipeline, not a mock.
 *
 * Identity layout:
 *   - "main" (tests 1-3): a FIXED device ID in a directory that persists
 *     across suite runs (data/matrix-crypto-live-test/main/, gitignored via
 *     data/). Reusing a device ID with no matching local snapshot is exactly
 *     the one-time-key poisoning bug from tonight's incident — persisting
 *     this directory for real (never a temp dir) is what keeps every run's
 *     restore valid instead of reproducing that bug on the second run.
 *   - "throwaway" (test 4): a fresh random device ID + a scratch temp dir,
 *     new every run and deleted after. Deliberately corrupting this identity's
 *     snapshot must never risk poisoning the reusable "main" device.
 */
import { describe, test, expect, beforeAll } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { readEnvFile } from '../env.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HARNESS_PATH = path.join(PROJECT_ROOT, 'scripts/matrix-live-harness.ts');
const MAIN_DIR = path.join(PROJECT_ROOT, 'data/matrix-crypto-live-test/main');
const MAIN_DEVICE_ID = 'nanoclaw-livetest-main';

const env = readEnvFile([
  'MATRIX_BASE_URL',
  'MATRIX_USER_ID',
  'MATRIX_TEST_USER_ID',
  'MATRIX_TEST_PASSWORD',
  'MATRIX_TEST_RECOVERY_KEY',
]);

const haveCreds = Boolean(
  env.MATRIX_BASE_URL &&
  env.MATRIX_USER_ID &&
  env.MATRIX_TEST_USER_ID &&
  env.MATRIX_TEST_PASSWORD &&
  env.MATRIX_TEST_RECOVERY_KEY,
);

interface HarnessEvent {
  event: string;
  payload?: string;
}

class Harness {
  proc: ChildProcessByStdio<null, Readable, Readable>;
  events: HarnessEvent[] = [];
  private waiters: Array<{ pred: (e: HarnessEvent) => boolean; resolve: (e: HarnessEvent) => void }> = [];

  constructor(envOverrides: Record<string, string | undefined>) {
    this.proc = spawn('pnpm', ['exec', 'tsx', HARNESS_PATH], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env, ...envOverrides },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    createInterface({ input: this.proc.stdout }).on('line', (line) => {
      const m = /^HARNESS:([A-Z_]+)(?::(.*))?$/.exec(line);
      if (!m) return;
      const evt: HarnessEvent = {
        event: m[1],
        payload: m[2] !== undefined ? Buffer.from(m[2], 'base64').toString('utf-8') : undefined,
      };
      this.events.push(evt);
      for (const w of [...this.waiters]) {
        if (w.pred(evt)) {
          this.waiters = this.waiters.filter((x) => x !== w);
          w.resolve(evt);
        }
      }
    });
    // Surfaced on failure via captured stderr, not asserted on directly.
    createInterface({ input: this.proc.stderr }).on('line', (line) => {
      this.events.push({ event: 'STDERR', payload: line });
    });
  }

  waitFor(eventName: string, timeoutMs: number): Promise<HarnessEvent> {
    const already = this.events.find((e) => e.event === eventName);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== onEvent);
        const recent = this.events.slice(-15).map((e) => `${e.event}${e.payload ? ':' + e.payload.slice(0, 200) : ''}`);
        reject(
          new Error(`Timed out waiting for ${eventName} after ${timeoutMs}ms. Recent events:\n${recent.join('\n')}`),
        );
      }, timeoutMs);
      const onEvent = (e: HarnessEvent) => {
        clearTimeout(timer);
        resolve(e);
      };
      this.waiters.push({ pred: (e) => e.event === eventName, resolve: onEvent });
    });
  }

  async killAndWaitExit(timeoutMs = 15_000): Promise<void> {
    if (this.proc.exitCode !== null) return;
    this.proc.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

const describeIfCreds = haveCreds ? describe : describe.skip;

describeIfCreds('Matrix live channel (real homeserver)', () => {
  beforeAll(() => {
    fs.mkdirSync(MAIN_DIR, { recursive: true });
  });

  test('connects and reaches sync-ready', async () => {
    const h = new Harness({
      MATRIX_CRYPTO_SNAPSHOT_DIR: MAIN_DIR,
      MATRIX_HARNESS_DEVICE_ID: MAIN_DEVICE_ID,
    });
    await h.waitFor('SYNC_READY', 90_000);
    await h.killAndWaitExit();
    await h.waitFor('SNAPSHOT_SAVED', 3_000);
  }, 120_000);

  test('E2EE round-trip: production bot replies to an encrypted DM', async () => {
    const probeText = `nanoclaw-live-test-probe-${crypto.randomUUID()}`;
    const h = new Harness({
      MATRIX_CRYPTO_SNAPSHOT_DIR: MAIN_DIR,
      MATRIX_HARNESS_DEVICE_ID: MAIN_DEVICE_ID,
      MATRIX_HARNESS_PEER_ID: env.MATRIX_USER_ID,
      MATRIX_HARNESS_PROBE_TEXT: probeText,
      // Must outlive the INBOUND wait below — the harness self-exits at its
      // max lifetime, and a reply arriving after that would be missed even
      // though the test is still waiting. A brand-new agent group's very
      // first container spawn pays a real one-time cold-start cost (image
      // build/init, not just the agent call) — observed ~4.5 minutes on this
      // suite's first-ever run against the dedicated test agent group.
      MATRIX_HARNESS_MAX_MS: '320000',
    });
    await h.waitFor('SYNC_READY', 90_000);
    await h.waitFor('PROBE_SENT', 30_000);
    // The live production agent has to actually run and reply — generous timeout.
    const inbound = await h.waitFor('INBOUND', 300_000);
    expect(inbound.payload).toBeTruthy();
    await h.killAndWaitExit();
  }, 450_000);

  test('survives a real process kill + respawn with encryption intact', async () => {
    const h = new Harness({
      MATRIX_CRYPTO_SNAPSHOT_DIR: MAIN_DIR,
      MATRIX_HARNESS_DEVICE_ID: MAIN_DEVICE_ID,
    });
    const restoreResult = await h.waitFor('RESTORE_RESULT', 10_000);
    expect(JSON.parse(restoreResult.payload ?? '{}').restored).toBe(true);
    await h.waitFor('SYNC_READY', 90_000);
    await h.killAndWaitExit();

    // Prove E2EE still works immediately after the restart, not just that
    // the process started — this is the exact scenario that regressed
    // earlier tonight (a reply sent right after restart landing in a
    // freshly-created, wrong room instead of decrypting/routing correctly).
    const probeText = `nanoclaw-live-test-restart-probe-${crypto.randomUUID()}`;
    const h2 = new Harness({
      MATRIX_CRYPTO_SNAPSHOT_DIR: MAIN_DIR,
      MATRIX_HARNESS_DEVICE_ID: MAIN_DEVICE_ID,
      MATRIX_HARNESS_PEER_ID: env.MATRIX_USER_ID,
      MATRIX_HARNESS_PROBE_TEXT: probeText,
      MATRIX_HARNESS_MAX_MS: '320000',
    });
    await h2.waitFor('SYNC_READY', 90_000);
    await h2.waitFor('PROBE_SENT', 30_000);
    const inbound = await h2.waitFor('INBOUND', 300_000);
    expect(inbound.payload).toBeTruthy();
    await h2.killAndWaitExit();
  }, 550_000);

  test('corrupted snapshot degrades gracefully (and covers from-scratch bootstrap)', async () => {
    const throwawayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-matrix-live-'));
    const deviceId = `nanoclaw-livetest-throwaway-${crypto.randomUUID().slice(0, 8)}`;
    try {
      // Phase A: first-ever spawn for this device — no snapshot exists yet,
      // so this exercises the from-scratch bootstrap path (recovery key
      // alone establishing cross-signing trust for a brand new device).
      const h1 = new Harness({ MATRIX_CRYPTO_SNAPSHOT_DIR: throwawayDir, MATRIX_HARNESS_DEVICE_ID: deviceId });
      const restoreResult = await h1.waitFor('RESTORE_RESULT', 10_000);
      expect(JSON.parse(restoreResult.payload ?? '{}').reason).toBe('no-snapshot');
      await h1.waitFor('SYNC_READY', 90_000);
      await h1.killAndWaitExit();
      await h1.waitFor('SNAPSHOT_SAVED', 3_000);

      // Phase B: corrupt the snapshot that was just saved.
      const snapshotPath = path.join(throwawayDir, 'snapshot.v8');
      fs.writeFileSync(snapshotPath, crypto.randomBytes(256));

      // Phase C: respawn with the same (now-corrupted) identity. Must not
      // crash. Full E2EE function isn't asserted here — a corrupted-then-
      // regenerated local identity on an already-used device ID can hit the
      // same server-side one-time-key collision as the original incident;
      // graceful, stable degradation is the contract, not full recovery
      // (real recovery for that case is a device-ID rotation, same as prod).
      const h2 = new Harness({ MATRIX_CRYPTO_SNAPSHOT_DIR: throwawayDir, MATRIX_HARNESS_DEVICE_ID: deviceId });
      const restoreResult2 = await h2.waitFor('RESTORE_RESULT', 10_000);
      expect(JSON.parse(restoreResult2.payload ?? '{}').restored).toBe(false);
      expect(JSON.parse(restoreResult2.payload ?? '{}').reason).toBe('corrupt');
      const fatal = h2.events.find((e) => e.event === 'FATAL');
      expect(fatal).toBeUndefined();
      await h2.killAndWaitExit();
    } finally {
      fs.rmSync(throwawayDir, { recursive: true, force: true });
    }
  }, 180_000);
});
