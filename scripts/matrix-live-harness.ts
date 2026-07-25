/**
 * Standalone child process that drives the real Matrix channel adapter
 * (same code as production: createMatrixAdapter + wrapWithDmResolution +
 * createChatSdkBridge + the crypto-store snapshot/restore cycle) against a
 * live homeserver, using an isolated identity and data directory.
 *
 * Never imports src/channels/matrix.ts directly — that module's factory is
 * wired to the production .env layout and the host's onShutdown/DATA_DIR
 * machinery. This harness re-composes the same pieces standalone so it can
 * be spawned as a real, independent OS process (required to genuinely test
 * "survives a restart" rather than simulating it in-process), pointed at a
 * throwaway account and a data directory that is never the production one.
 *
 * Driven entirely by env vars (set by the spawning test):
 *   MATRIX_BASE_URL            — reused from the real .env (same homeserver)
 *   MATRIX_TEST_USER_ID/_PASSWORD/_RECOVERY_KEY — the throwaway test account
 *   MATRIX_HARNESS_DEVICE_ID   — device ID to use (stable across a
 *                                 restart-survival test; a fresh one for a
 *                                 from-scratch bootstrap test)
 *   MATRIX_CRYPTO_SNAPSHOT_DIR — isolated snapshot dir (never the real
 *                                 data/matrix-crypto/)
 *   MATRIX_HARNESS_PEER_ID     — optional; when set, opens a DM with this
 *                                 user (the real production bot) and posts
 *                                 MATRIX_HARNESS_PROBE_TEXT once synced
 *   MATRIX_HARNESS_VOICE_FILE  — optional; path to an audio file to send to
 *                                 MATRIX_HARNESS_PEER_ID as an ENCRYPTED
 *                                 MSC3245 voice note (the exact shape Element
 *                                 produces in an E2EE room), under the name
 *                                 MATRIX_HARNESS_VOICE_NAME
 *   MATRIX_HARNESS_MAX_MS      — safety timeout before the harness exits on
 *                                 its own (default 90s)
 *
 * Protocol: every line of interest is written to stdout prefixed
 * "HARNESS:<EVENT>[:<base64 payload>]" so the test can grep stdout without
 * parsing the regular (human-oriented, colorized) log output mixed in
 * alongside it. On SIGTERM, saves a final crypto snapshot before exiting —
 * mirrors production's onShutdown hook in src/channels/matrix.ts.
 */
import 'fake-indexeddb/auto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const snapshotDir = process.env.MATRIX_CRYPTO_SNAPSHOT_DIR;
if (!snapshotDir) {
  console.error('HARNESS:FATAL:missing MATRIX_CRYPTO_SNAPSHOT_DIR');
  process.exit(1);
}

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Map the throwaway test identity onto the standard env vars the SDK reads
// (see resolveAuthFromEnv / createMatrixAdapter in @beeper/chat-adapter-matrix).
// Must happen before createMatrixAdapter() is called below.
process.env.MATRIX_USERNAME = process.env.MATRIX_TEST_USER_ID;
process.env.MATRIX_USER_ID = process.env.MATRIX_TEST_USER_ID;
process.env.MATRIX_PASSWORD = process.env.MATRIX_TEST_PASSWORD;
process.env.MATRIX_RECOVERY_KEY = process.env.MATRIX_TEST_RECOVERY_KEY;
process.env.MATRIX_DEVICE_ID = process.env.MATRIX_HARNESS_DEVICE_ID;
process.env.MATRIX_INVITE_AUTOJOIN = 'true';
process.env.MATRIX_BOT_USERNAME = 'nanoclaw-live-test';

// createChatSdkBridge unconditionally starts the shared webhook HTTP server
// (src/webhook-server.ts) for any non-gateway adapter, Matrix included, even
// though Matrix never receives an inbound webhook (it long-polls via sync).
// That server defaults to a fixed port (3000) — fine for the single
// production process, but this harness runs as a second, independent OS
// process alongside it and would collide on the same port. Port 0 = let the
// OS pick a free one; nothing needs to reach this listener from outside.
process.env.WEBHOOK_PORT = process.env.WEBHOOK_PORT ?? '0';

const { createMatrixAdapter } = await import('@beeper/chat-adapter-matrix');
const { createChatSdkBridge } = await import('../src/channels/chat-sdk-bridge.js');
const { wrapWithDmResolution, wrapWithEncryptedMedia } = await import('../src/channels/matrix.js');
const { restoreSnapshot, saveSnapshot } = await import('../src/channels/matrix-crypto-store.js');
const { encryptMatrixAttachment } = await import('../src/channels/matrix-media-crypto.js');
const { initDb } = await import('../src/db/connection.js');

// createChatSdkBridge's Chat SDK instance persists subscription state via
// SqliteStateAdapter, which requires the central DB to be initialized
// (getDb() throws otherwise — this is normally done once by src/index.ts on
// host startup, which this standalone harness bypasses entirely). Reuses
// the REAL central DB — safe because SqliteStateAdapter namespaces every
// key under the 'matrix-live-test' instance name passed below, so it can
// never collide with production's own (default, unprefixed) Matrix state.
initDb(path.join(PROJECT_ROOT, 'data', 'v2.db'));

function emit(event: string, payload?: string): void {
  process.stdout.write(`HARNESS:${event}${payload !== undefined ? ':' + Buffer.from(payload).toString('base64') : ''}\n`);
}

async function main(): Promise<void> {
  emit('STARTED');

  const deviceId = process.env.MATRIX_HARNESS_DEVICE_ID;
  try {
    const result = await restoreSnapshot(deviceId);
    emit('RESTORE_RESULT', JSON.stringify(result));
  } catch (err) {
    emit('RESTORE_THREW', String(err));
  }

  const matrixAdapter = wrapWithDmResolution(wrapWithEncryptedMedia(createMatrixAdapter()));
  const bridge = createChatSdkBridge({
    adapter: matrixAdapter,
    instance: 'matrix-live-test',
    concurrency: 'concurrent',
    supportsThreads: false,
  });

  await bridge.setup({
    onInbound: (_platformId, threadId, message) => {
      const content = message.content as Record<string, unknown>;
      const text = (content?.markdown as string) ?? (content?.text as string) ?? '';
      emit('INBOUND', JSON.stringify({ threadId, text }));
    },
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  });

  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if ((matrixAdapter as unknown as { liveSyncReady?: boolean }).liveSyncReady) {
        clearInterval(check);
        resolve();
      }
    }, 300);
    setTimeout(() => {
      clearInterval(check);
      resolve();
    }, 60_000);
  });

  if ((matrixAdapter as unknown as { liveSyncReady?: boolean }).liveSyncReady) {
    emit('SYNC_READY');
  } else {
    emit('SYNC_TIMEOUT');
  }

  const peerId = process.env.MATRIX_HARNESS_PEER_ID;
  const probeText = process.env.MATRIX_HARNESS_PROBE_TEXT;
  if (peerId && probeText) {
    try {
      // Goes through the wrapped postMessage (resolveThreadId's fast-path
      // cache + openDM fallback) — the exact code path this whole test
      // suite exists to exercise against a real server.
      const result = await matrixAdapter.postMessage(`matrix:${peerId}`, { markdown: probeText });
      emit('PROBE_SENT', JSON.stringify(result ?? null));
    } catch (err) {
      emit('PROBE_FAILED', String(err));
    }
  }

  const voiceFile = process.env.MATRIX_HARNESS_VOICE_FILE;
  if (peerId && voiceFile) {
    try {
      const fs = await import('node:fs');
      const plaintext = fs.readFileSync(voiceFile);
      const voiceName = process.env.MATRIX_HARNESS_VOICE_NAME ?? 'voice-probe.wav';

      // Resolve the DM room the same way outbound delivery does.
      const resolvedThreadId = await (matrixAdapter as any).openDM(peerId);
      const { roomID } = matrixAdapter.decodeThreadId(resolvedThreadId);
      const client = (matrixAdapter as any).client;

      // Encrypt-then-upload, exactly like a real client in an E2EE room:
      // the *ciphertext* goes to the media repo, the key material rides in
      // the (room-encrypted) event body under `file`.
      const { ciphertext, file } = encryptMatrixAttachment(plaintext);
      const upload = await client.uploadContent(ciphertext, {
        type: 'application/octet-stream',
        includeFilename: false,
      });
      const mxcUrl: string = upload.content_uri;

      await client.sendEvent(roomID, 'm.room.message', {
        msgtype: 'm.audio',
        body: voiceName,
        info: { mimetype: 'audio/wav', size: plaintext.length },
        file: { ...file, url: mxcUrl, mimetype: 'audio/wav' },
        // MSC3245 voice-note markers — what matrixIsVoiceAttachment keys on.
        'org.matrix.msc3245.voice': {},
        'org.matrix.msc1767.audio': {},
      });
      emit('VOICE_SENT', JSON.stringify({ roomID, mxcUrl, name: voiceName }));
    } catch (err) {
      emit('VOICE_FAILED', String(err instanceof Error ? (err.stack ?? err.message) : err));
    }
  }

  const saveFinal = async (): Promise<void> => {
    const fields = matrixAdapter as unknown as { deviceID?: string; userID?: string; baseURL?: string };
    try {
      await saveSnapshot({ deviceID: fields.deviceID, userID: fields.userID, baseURL: fields.baseURL });
      emit('SNAPSHOT_SAVED');
    } catch (err) {
      emit('SNAPSHOT_SAVE_FAILED', String(err));
    }
  };

  let shuttingDown = false;
  process.on('SIGTERM', () => {
    if (shuttingDown) return;
    shuttingDown = true;
    setTimeout(() => process.exit(0), 5_000).unref();
    void saveFinal().finally(() => process.exit(0));
  });

  const maxMs = Number(process.env.MATRIX_HARNESS_MAX_MS ?? 90_000);
  setTimeout(() => {
    if (shuttingDown) return;
    emit('MAX_LIFETIME_REACHED');
    void saveFinal().finally(() => process.exit(0));
  }, maxMs).unref();
}

main().catch((err) => {
  emit('FATAL', String(err instanceof Error ? (err.stack ?? err.message) : err));
  process.exit(1);
});
