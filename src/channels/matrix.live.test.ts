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
import { spawn, execSync, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { readEnvFile } from '../env.js';
import { getSystemdUnit } from '../install-slug.js';

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

/**
 * Extract the bare Matrix room id from an encoded thread id
 * (`matrix:!abc%3Aserver` → `!abc:server`), so a room can be compared
 * regardless of which side produced the id.
 */
function roomOf(threadId: string | undefined): string | undefined {
  if (!threadId) return undefined;
  const withoutPrefix = threadId.startsWith('matrix:') ? threadId.slice('matrix:'.length) : threadId;
  // Encoded ids percent-escape the ':' separating localpart from server.
  return decodeURIComponent(withoutPrefix).split(':').slice(0, 2).join(':');
}

/** Wait until `needle` appears in the host log after the current end-of-file. */
async function waitForHostLog(needle: string, timeoutMs: number): Promise<void> {
  const logPath = path.join(PROJECT_ROOT, 'logs/nanoclaw.log');
  const startSize = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(logPath)) {
      const size = fs.statSync(logPath).size;
      if (size > startSize) {
        const fd = fs.openSync(logPath, 'r');
        try {
          const buf = Buffer.alloc(size - startSize);
          fs.readSync(fd, buf, 0, buf.length, startSize);
          if (buf.toString('utf-8').includes(needle)) return;
        } finally {
          fs.closeSync(fd);
        }
      }
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`Timed out waiting for host log line: ${needle}`);
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

  /**
   * Wait for an event satisfying `pred`. Needed because the harness reports
   * EVERY inbound message, including unrelated history the homeserver
   * back-fills during initial sync — so "the first INBOUND" is not
   * necessarily the reply we are waiting for.
   */
  waitForMatching(eventName: string, pred: (e: HarnessEvent) => boolean, timeoutMs: number): Promise<HarnessEvent> {
    const matches = (e: HarnessEvent) => e.event === eventName && pred(e);
    const already = this.events.find(matches);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== onEvent);
        const seen = this.events
          .filter((e) => e.event === eventName)
          .map((e) => e.payload?.slice(0, 200))
          .join('\n');
        reject(new Error(`Timed out waiting for a matching ${eventName} after ${timeoutMs}ms. Seen:\n${seen}`));
      }, timeoutMs);
      const onEvent = (e: HarnessEvent) => {
        clearTimeout(timer);
        resolve(e);
      };
      this.waiters.push({ pred: matches, resolve: onEvent });
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

  test('encrypted voice note: production bot transcribes it', async () => {
    // Sends a real MSC3245 voice note — attachment encrypted with
    // AES-256-CTR exactly like Element does in an E2EE room — to the live
    // production bot, then asserts host-side that the transcription pipeline
    // ran: the routed message in the test agent group's inbound.db must
    // carry a non-empty `transcript` on the attachment. This covers, against
    // the real server: encrypted-media extraction (wrapWithEncryptedMedia),
    // download+decrypt (matrix-media-crypto), MSC3245 voice detection
    // (matrixIsVoiceAttachment), staging, and OpenRouter transcription.
    const voiceName = `voice-probe-${crypto.randomUUID().slice(0, 8)}.wav`;
    const fixturePath = path.join(PROJECT_ROOT, 'src/channels/fixtures/matrix-voice-fixture.wav');
    expect(fs.existsSync(fixturePath)).toBe(true);

    const h = new Harness({
      MATRIX_CRYPTO_SNAPSHOT_DIR: MAIN_DIR,
      MATRIX_HARNESS_DEVICE_ID: MAIN_DEVICE_ID,
      MATRIX_HARNESS_PEER_ID: env.MATRIX_USER_ID,
      MATRIX_HARNESS_VOICE_FILE: fixturePath,
      MATRIX_HARNESS_VOICE_NAME: voiceName,
      MATRIX_HARNESS_MAX_MS: '320000',
    });
    await h.waitFor('SYNC_READY', 90_000);
    await h.waitFor('VOICE_SENT', 60_000);

    // Poll the production-side session DB (same host) for the routed message
    // carrying our uniquely-named attachment WITH a transcript. The
    // transcript is written before the message lands in inbound.db (router
    // blocks on extractAndTranscribeAttachments), so its presence in the row
    // is binary: either the whole pipeline worked or it didn't.
    const { default: Database } = await import('better-sqlite3');
    const sessionsRoot = path.join(PROJECT_ROOT, 'data/v2-sessions');
    const deadline = Date.now() + 180_000;
    let matchedContent: string | null = null;
    while (Date.now() < deadline && !matchedContent) {
      const dbPaths: string[] = [];
      for (const group of fs.readdirSync(sessionsRoot)) {
        const groupDir = path.join(sessionsRoot, group);
        if (!fs.statSync(groupDir).isDirectory()) continue;
        for (const sess of fs.readdirSync(groupDir)) {
          const p = path.join(groupDir, sess, 'inbound.db');
          if (fs.existsSync(p)) dbPaths.push(p);
        }
      }
      for (const dbPath of dbPaths) {
        try {
          const db = new Database(dbPath, { readonly: true });
          try {
            const row = db
              .prepare(`SELECT content FROM messages_in WHERE content LIKE ? LIMIT 1`)
              .get(`%${voiceName}%`) as { content: string } | undefined;
            if (row) matchedContent = row.content;
          } finally {
            db.close();
          }
        } catch {
          // DB mid-write or locked — retry on the next poll tick.
        }
        if (matchedContent) break;
      }
      if (!matchedContent) await new Promise((r) => setTimeout(r, 3_000));
    }

    expect(matchedContent, 'voice-note message never appeared in any inbound.db').toBeTruthy();
    const parsed = JSON.parse(matchedContent!) as {
      attachments?: Array<{ name?: string; isVoice?: boolean; transcript?: string; localPath?: string }>;
    };
    const att = parsed.attachments?.find((a) => a.name === voiceName);
    expect(att, 'attachment missing from routed message').toBeTruthy();
    expect(att!.isVoice, 'attachment not flagged as voice').toBe(true);
    expect(att!.localPath, 'attachment audio was not staged to disk').toBeTruthy();
    expect(att!.transcript?.trim(), 'attachment has no transcript').toBeTruthy();

    // The fixture says "NanoClaw voice transcription test, one two three" —
    // assert loosely (espeak's robotic voice garbles the odd word).
    expect(att!.transcript!.toLowerCase()).toMatch(/transcription|one two three|1 2 3/);

    await h.killAndWaitExit();
  }, 400_000);

  test('reply lands in the room the user wrote from, even after openDM cached another', async () => {
    // The 2026-07-25 "typing indicator, then silence" incident. Sequence:
    //   1. Host restarts -> the in-memory DM room cache is empty.
    //   2. Something makes the host send FIRST (here: an injected message,
    //      in the incident: an operator test). With a cold cache that falls
    //      through to openDM, which resolves/creates room A and caches it.
    //   3. The user writes from their real room B.
    //   4. Every reply still goes to room A. The user sees the bot typing
    //      and never receives an answer; the agent's replies pile up in a
    //      room they never opened.
    //
    // The unit test in matrix-dm-resolution.test.ts asserts that confirmed
    // inbound traffic overrides openDM's cache, and it passes — so this
    // covers the integration the unit test cannot see: whether the inbound
    // path actually reaches that cache in a running host.
    //
    // The assertion is deliberately end-to-end and room-exact: the harness
    // must receive the reply IN THE SAME ROOM it wrote from. A reply routed
    // anywhere else simply never arrives here, which is precisely the
    // user-visible symptom.
    // Resolve the unit via the same install-slug-scoped function the setup
    // wizard uses to create it (src/install-slug.ts), not a `grep -i
    // nanoclaw` shell pipeline — this machine also runs a
    // "claude-rc-nanoclaw.service" (this session's own remote-control
    // server), and a substring grep has no way to prefer the real host over
    // it. Restarting the wrong unit silently no-ops this test (the log line
    // it waits for never appears) without touching the actual host at all.
    const unitName = getSystemdUnit(PROJECT_ROOT);
    try {
      execSync(`systemctl --user is-active --quiet ${unitName}`);
    } catch {
      throw new Error(
        `nanoclaw systemd unit "${unitName}" is not active — is the host running under systemd on this machine?`,
      );
    }

    // Step 1 — cold cache.
    execSync(`systemctl --user restart ${unitName}`);
    await waitForHostLog('Matrix sync ready', 120_000);

    // Step 2 — poison it: make the host send before any inbound arrives.
    execSync(
      `pnpm exec tsx src/cli/client.ts messaging-groups send --channel-type matrix ` +
        `--platform-id ${JSON.stringify(`matrix:${env.MATRIX_TEST_USER_ID}`)} --instance matrix ` +
        `--sender-id ${JSON.stringify(`matrix:${env.MATRIX_TEST_USER_ID}`)} --sender LiveTest ` +
        `--text ${JSON.stringify('cache-poison probe, no reply needed')}`,
      { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 60_000 },
    );
    // Give the host time to run openDM and cache whatever it resolves.
    await new Promise((r) => setTimeout(r, 20_000));

    // Step 3 — the user's real message, from the test account's own room.
    const probeText = `nanoclaw-live-roomcheck-${crypto.randomUUID()}`;
    const h = new Harness({
      MATRIX_CRYPTO_SNAPSHOT_DIR: MAIN_DIR,
      MATRIX_HARNESS_DEVICE_ID: MAIN_DEVICE_ID,
      MATRIX_HARNESS_PEER_ID: env.MATRIX_USER_ID,
      MATRIX_HARNESS_PROBE_TEXT: probeText,
      MATRIX_HARNESS_MAX_MS: '320000',
    });
    await h.waitFor('SYNC_READY', 90_000);
    const sent = await h.waitFor('PROBE_SENT', 60_000);
    const sentRoom = roomOf(JSON.parse(sent.payload ?? '{}').threadId);
    expect(sentRoom, 'harness did not report the room it sent to').toBeTruthy();

    // Step 4 — a reply must arrive in that same room. Matching on the room
    // (rather than taking the first INBOUND) is deliberate: the homeserver
    // back-fills unrelated history from other rooms during initial sync, and
    // an earlier revision of this test failed on exactly that, blaming the
    // routing for a stale message it had picked up by accident.
    const inbound = await h.waitForMatching(
      'INBOUND',
      (e) => roomOf((JSON.parse(e.payload ?? '{}') as { threadId?: string }).threadId) === sentRoom,
      300_000,
    );
    expect(roomOf((JSON.parse(inbound.payload ?? '{}') as { threadId?: string }).threadId)).toBe(sentRoom);

    await h.killAndWaitExit();
  }, 600_000);

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
