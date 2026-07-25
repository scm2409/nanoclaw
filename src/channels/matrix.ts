/**
 * Matrix channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 *
 * Supports two auth methods (resolved by the adapter from env):
 *   - Access token: MATRIX_ACCESS_TOKEN + MATRIX_USER_ID
 *   - Password:     MATRIX_USERNAME + MATRIX_PASSWORD (+ optional MATRIX_USER_ID)
 *
 * Optional env vars:
 *   MATRIX_BOT_USERNAME         — display name for the bot (default: "bot")
 *   MATRIX_INVITE_AUTOJOIN      — "true" to auto-accept room invites
 *   MATRIX_INVITE_AUTOJOIN_ALLOWLIST — comma-separated user IDs allowed to invite
 *   MATRIX_RECOVERY_KEY         — enable E2EE cross-signing
 *   MATRIX_DEVICE_ID            — stable device ID across restarts
 *
 * E2EE crypto (matrix-sdk-crypto-wasm) defaults to IndexedDB, a browser API
 * not present in Node. There's no env var to disable it, so we polyfill it
 * with fake-indexeddb (in-memory — proven fully compatible with
 * matrix-sdk-crypto-wasm, including its transaction/commit semantics).
 *
 * Tried swapping fake-indexeddb for a persistent IndexedDB polyfill
 * (indexeddbshim, SQLite-backed) to survive restarts natively — reverted.
 * matrix-sdk-crypto-wasm's Rust/WASM bindings require the modern explicit
 * IDBTransaction.commit() API; indexeddbshim@16.1.0's IDBTransaction has no
 * commit() method at all (WebSQL-era implementation, predates that
 * IndexedDB spec addition), so the crypto store failed to open at all
 * ("arg0.commit is not a function") — a harder failure than the in-memory
 * status quo. Don't retry this package for this purpose without confirming
 * commit() support first.
 *
 * Instead, matrix-crypto-store.ts adds a snapshot/restore layer *on top of*
 * fake-indexeddb, via its standard public IndexedDB API only: restored on
 * startup (before this adapter's crypto init runs, so the engine sees
 * pre-existing data), saved on clean shutdown and periodically. This is why
 * the crypto store now survives restarts even though the underlying
 * indexedDB polyfill is still in-memory — persistence is a save/restore
 * cycle around it, not a property of the polyfill itself.
 *
 * One incident this fixes: each restart's fresh in-memory identity used to
 * try publishing new olm one-time-keys under the same persisted device ID,
 * colliding with keys the server already had on file from earlier restarts
 * — permanently blocking new key exchange (every message undecryptable)
 * until MATRIX_DEVICE_ID was rotated to a fresh value. Rotating clears that
 * poisoned server-side state; matrix-crypto-store.ts's device-ID guard
 * ensures a rotation doesn't replay the old identity's snapshot into the
 * new device's same-named crypto DB.
 */
import 'fake-indexeddb/auto';

import { createMatrixAdapter } from '@beeper/chat-adapter-matrix';

import { log } from '../log.js';
import { readEnvFile } from '../env.js';
import { onShutdown } from '../response-registry.js';
import type { ChannelDefaults } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';
import { restoreSnapshot, saveSnapshot } from './matrix-crypto-store.js';

/** How often the crypto store autosaves, in addition to save-on-shutdown —
 * bounds worst-case data loss (new megolm sessions, rotated keys) on an
 * unclean exit (crash, kill -9) that skips the shutdown hook. */
const CRYPTO_STORE_AUTOSAVE_MS = 60_000;

/**
 * Assumes a dedicated bot account on a homeserver (the common install).
 * Non-threaded at the bridge level, so group engagement is 'mention', never
 * sticky. Personal-account installs should edit their copy to dm 'strict' —
 * install-wide changes live in this declaration by design.
 */
const MATRIX_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

const ENV_KEYS = [
  'MATRIX_BASE_URL',
  'MATRIX_ACCESS_TOKEN',
  'MATRIX_USERNAME',
  'MATRIX_PASSWORD',
  'MATRIX_USER_ID',
  'MATRIX_BOT_USERNAME',
  'MATRIX_DEVICE_ID',
  'MATRIX_RECOVERY_KEY',
  'MATRIX_INVITE_AUTOJOIN',
  'MATRIX_INVITE_AUTOJOIN_ALLOWLIST',
  'MATRIX_SDK_LOG_LEVEL',
] as const;

/**
 * Detect MSC3245 voice notes ("send as voice message" in Matrix clients) so
 * chat-sdk-bridge.ts can flag the attachment for automatic transcription.
 * Plain uploaded audio files (m.audio without the voice marker) are left
 * alone — those get no auto-transcript, matching every other file type.
 *
 * `raw` is a matrix-js-sdk MatrixEvent instance, not a plain object — content
 * is only reachable via `.getContent()`, never a `.content` property.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function matrixIsVoiceAttachment(_att: Record<string, any>, raw: Record<string, any> | undefined): boolean {
  const content = typeof raw?.getContent === 'function' ? raw.getContent() : undefined;
  if (!content || typeof content !== 'object') return false;
  return 'org.matrix.msc3245.voice' in content || 'org.matrix.msc3245.voice.v2' in content;
}

/**
 * Wrap the Matrix adapter so DM conversations are identified by user handle
 * across the whole system, not by ephemeral room IDs.
 *
 * Matrix DMs live in rooms (e.g. "!abc:server"), but NanoClaw identifies
 * channels by platform_id. Using a user handle as platform_id means both
 * the user and the messaging group reference the same stable identifier.
 *
 * Two directions to bridge:
 *   - Outbound: delivery passes "matrix:@user:server" → resolve to room via openDM
 *   - Inbound: adapter emits "matrix:!room:server" → rewrite to user handle
 *     so the router finds the existing messaging group instead of creating
 *     a new one.
 *
 * Both resolutions are cached for the process lifetime.
 *
 * Outbound resolution has a fast path that bypasses the underlying SDK's
 * own openDM() entirely when possible — see resolveThreadId below for why.
 */
export function wrapWithDmResolution(adapter: ReturnType<typeof createMatrixAdapter>): typeof adapter {
  const origPostMessage = adapter.postMessage.bind(adapter);
  const origStartTyping = adapter.startTyping.bind(adapter);
  const origChannelIdFromThreadId = adapter.channelIdFromThreadId.bind(adapter);

  // roomId → user handle, used to rewrite inbound channel IDs.
  const roomToUserCache = new Map<string, string>();
  // user handle → roomId, the reverse direction. Populated ONLY from
  // confirmed inbound traffic (a room we've actually received a message
  // in), never from openDM()'s own return value — see resolveThreadId.
  const userToRoomCache = new Map<string, string>();

  function isUserHandle(threadId: string): boolean {
    try {
      const { roomID } = adapter.decodeThreadId(threadId);
      return !roomID.startsWith('!');
    } catch {
      return true;
    }
  }

  async function resolveThreadId(threadId: string): Promise<string> {
    if (!isUserHandle(threadId)) return threadId;

    const userHandle = threadId.startsWith('matrix:') ? threadId.slice('matrix:'.length) : threadId;

    // Fast path: reuse a room we've actually received a message from this
    // user in, bypassing the underlying SDK's openDM() entirely.
    //
    // openDM() (chat-adapter-matrix@0.2.0) tries its own persisted room-id
    // cache first, then falls back to the bot's m.direct account data, and
    // SILENTLY CREATES A NEW ROOM (inviting the user into it) if both come
    // up empty. Both of those lookups can fail for a room that is
    // completely real and currently in use — the persisted-cache check
    // (isUsableDirectRoom) requires the room to already be loaded in the
    // client's local store, which can lag right after a restart, and the
    // account-data fallback only has an entry if openDM itself created the
    // room originally (a room the user started by DMing the bot first
    // never gets added there). We hit exactly this: a live, working,
    // encrypted DM room got silently abandoned for a fresh unencrypted one
    // moments after a restart.
    //
    // userToRoomCache is populated only from confirmed inbound traffic
    // (channelIdFromThreadId below), so a hit here means "we've definitely
    // exchanged messages in this room" — strictly more trustworthy than
    // openDM's own fallbacks. Only distrust it on a CONFIRMED departure
    // signal (membership 'leave'/'ban'); anything else — including
    // undefined/'invite'/no Room object at all — is treated as valid.
    //
    // This was tightened after a real incident: requiring an exact
    // membership === 'join' match caused a false "stale" verdict on the very
    // first reply after receiving a message, because the client's local Room
    // object's membership field can still lag a few ms behind the timeline
    // event that already reached us in that same room — despite the room
    // being demonstrably current (we just got a message from it moments
    // earlier). That false negative sent the reply through openDM() instead,
    // which silently created ANOTHER new unencrypted room, so the user's
    // reply landed somewhere they never saw it.
    const knownRoomId = userToRoomCache.get(userHandle);
    log.debug('Matrix resolveThreadId cache lookup', { userHandle, knownRoomId, cacheSize: userToRoomCache.size });
    if (knownRoomId) {
      const client = (adapter as any).client;
      const room = client?.getRoom(knownRoomId);
      const membership = room?.getMyMembership?.();
      log.debug('Matrix resolveThreadId cache validity check', {
        knownRoomId,
        hasClient: Boolean(client),
        hasRoom: Boolean(room),
        membership,
      });
      if (membership === 'leave' || membership === 'ban') {
        // Confirmed departure — let the normal openDM path below re-resolve
        // (or recreate) the room.
        userToRoomCache.delete(userHandle);
      } else {
        return adapter.encodeThreadId({ roomID: knownRoomId });
      }
    }

    log.info('Matrix: resolving DM room for user handle', { userHandle });
    const resolved = await adapter.openDM(userHandle);

    try {
      const { roomID } = adapter.decodeThreadId(resolved);
      roomToUserCache.set(roomID, userHandle);
      userToRoomCache.set(userHandle, roomID);
    } catch {
      // decode failure is non-fatal — outbound still works
    }

    return resolved;
  }

  // Rewrite inbound room-based channel IDs to user-handle form for DM rooms.
  // Non-DM rooms pass through unchanged.
  adapter.channelIdFromThreadId = (threadId: string): string => {
    try {
      const { roomID } = adapter.decodeThreadId(threadId);
      if (!roomID.startsWith('!')) return origChannelIdFromThreadId(threadId);

      const cached = roomToUserCache.get(roomID);
      if (cached) {
        userToRoomCache.set(cached, roomID);
        return `matrix:${cached}`;
      }

      // Not cached — check if this is a DM by membership count
      const client = (adapter as any).client;
      const room = client?.getRoom(roomID);
      if (!room) return origChannelIdFromThreadId(threadId);
      if (room.getJoinedMemberCount() > 2) return origChannelIdFromThreadId(threadId);

      const botId = (adapter as any).userID;
      const otherMember = room.getJoinedMembers().find((m: { userId: string }) => m.userId !== botId);
      if (!otherMember) return origChannelIdFromThreadId(threadId);

      roomToUserCache.set(roomID, otherMember.userId);
      userToRoomCache.set(otherMember.userId, roomID);
      return `matrix:${otherMember.userId}`;
    } catch {
      return origChannelIdFromThreadId(threadId);
    }
  };

  // Populate both caches directly from an inbound event's own sender field
  // (wired to chat-sdk-bridge.ts's onInboundSender hook in the factory
  // below) — the reliable path. channelIdFromThreadId's room-membership
  // enumeration (getJoinedMembers(), just below) requires lazily-loaded
  // member state that can be incomplete right after a fresh login/sync,
  // which is exactly what caused a real incident: a reply routed to a
  // brand-new room instead of the one the inbound message came from,
  // because the membership-based cache never got warmed in time. A
  // message's sender is embedded in the event itself — no additional state
  // needs to have loaded for this to work.
  (adapter as any).__onInboundSender = (threadId: string, senderId: string): void => {
    try {
      const { roomID } = adapter.decodeThreadId(threadId);
      log.debug('Matrix __onInboundSender', { threadId, senderId, roomID });
      if (!roomID.startsWith('!')) return;
      roomToUserCache.set(roomID, senderId);
      userToRoomCache.set(senderId, roomID);
    } catch (err) {
      log.debug('Matrix __onInboundSender decode failed', { threadId, senderId, err });
    }
  };

  // The Chat SDK calls adapter.isDM(threadId) synchronously to decide whether
  // to dispatch to onDirectMessage handlers. The Matrix adapter doesn't expose
  // this method — it only has an async isDirectRoom(). We add a synchronous
  // isDM that checks room membership count: 2 members = DM.
  (adapter as any).isDM = (threadId: string): boolean => {
    try {
      const { roomID } = adapter.decodeThreadId(threadId);
      const client = (adapter as any).client;
      if (!client) return false;
      const room = client.getRoom(roomID);
      if (!room) return false;
      const members = room.getJoinedMemberCount();
      return members <= 2;
    } catch {
      return false;
    }
  };

  adapter.postMessage = async (
    threadId: string,
    ...args: Parameters<typeof origPostMessage> extends [string, ...infer R] ? R : never
  ) => {
    const resolvedTid = await resolveThreadId(threadId);
    return origPostMessage(resolvedTid, ...args);
  };

  adapter.startTyping = async (threadId: string) => {
    const resolvedTid = await resolveThreadId(threadId);
    return origStartTyping(resolvedTid);
  };

  return adapter;
}

registerChannelAdapter('matrix', {
  factory: () => {
    const env = readEnvFile([...ENV_KEYS]);
    if (!env.MATRIX_BASE_URL) return null;
    if (!env.MATRIX_ACCESS_TOKEN && !(env.MATRIX_USERNAME && env.MATRIX_PASSWORD)) return null;

    for (const key of ENV_KEYS) {
      if (env[key]) process.env[key] = env[key];
    }

    // Default: auto-join room invites so DMs work without manual acceptance
    if (!process.env.MATRIX_INVITE_AUTOJOIN) {
      process.env.MATRIX_INVITE_AUTOJOIN = 'true';
    }

    const matrixAdapter = wrapWithDmResolution(createMatrixAdapter());
    const bridge = createChatSdkBridge({
      adapter: matrixAdapter,
      concurrency: 'concurrent',
      supportsThreads: false,
      defaults: MATRIX_DEFAULTS,
      isVoiceAttachment: matrixIsVoiceAttachment,
      onInboundSender: (threadId, senderId) =>
        (matrixAdapter as unknown as { __onInboundSender?: (t: string, s: string) => void }).__onInboundSender?.(
          threadId,
          senderId,
        ),
    });

    // Matrix user IDs contain ":" (e.g. "@user:matrix.org") which the shared
    // permissions module interprets as already-prefixed. Wrap onInbound to
    // ensure senderId always carries the "matrix:" channel prefix so user
    // records match between init-first-agent and inbound routing.
    const origSetup = bridge.setup.bind(bridge);
    bridge.setup = async (hostConfig) => {
      // Restore the crypto store BEFORE origSetup, which is what triggers
      // this adapter's E2EE init (matrix-sdk-crypto-wasm opening its
      // IndexedDB store) — the engine must see pre-existing data, not an
      // empty store, for restore to have any effect. Never blocks startup:
      // restoreSnapshot degrades to today's fresh-empty-store behavior on
      // any failure (missing/corrupt snapshot, wrong device ID, partial
      // restore failure) rather than throwing.
      try {
        const result = await restoreSnapshot(process.env.MATRIX_DEVICE_ID);
        if (result.restored) {
          log.info('Matrix crypto store restored');
        } else if (result.reason && result.reason !== 'no-snapshot') {
          log.warn('Matrix crypto store not restored', { reason: result.reason });
        }
      } catch (err) {
        log.warn('Matrix crypto store restore threw unexpectedly, starting fresh', { err });
      }

      const origOnInbound = hostConfig.onInbound.bind(hostConfig);
      await origSetup({
        ...hostConfig,
        onInbound: (platformId, threadId, message) => {
          if (message.content && typeof message.content === 'object') {
            const content = message.content as Record<string, unknown>;
            if (typeof content.senderId === 'string' && !content.senderId.startsWith('matrix:')) {
              content.senderId = `matrix:${content.senderId}`;
            }
          }
          return origOnInbound(platformId, threadId, message);
        },
      });

      // Wait for Matrix sync to reach PREPARED state before returning from setup.
      // Without this, the host's delivery poll and sweep timer start immediately
      // and can starve the SDK's sync generator microtask queue, blocking
      // incremental syncs so new inbound messages never get dispatched.
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if ((matrixAdapter as unknown as { liveSyncReady?: boolean }).liveSyncReady) {
            log.info('Matrix sync ready');
            clearInterval(check);
            resolve();
          }
        }, 500);
        setTimeout(() => {
          clearInterval(check);
          resolve();
        }, 30_000);
      });

      // Persist the crypto store going forward: on a timer (bounds data loss
      // on an unclean exit that skips the shutdown hook below) and once more
      // on clean shutdown, while the client — and its crypto store — is
      // still open (teardownChannelAdapters, which closes it, runs after
      // onShutdown callbacks; see src/index.ts).
      const adapterFields = matrixAdapter as unknown as { deviceID?: string; userID?: string; baseURL?: string };
      const saveCryptoSnapshot = () =>
        saveSnapshot({
          deviceID: adapterFields.deviceID,
          userID: adapterFields.userID,
          baseURL: adapterFields.baseURL,
        });
      const autosaveTimer = setInterval(() => {
        void saveCryptoSnapshot();
      }, CRYPTO_STORE_AUTOSAVE_MS);
      onShutdown(async () => {
        clearInterval(autosaveTimer);
        await saveCryptoSnapshot();
      });
    };

    return bridge;
  },
  defaults: MATRIX_DEFAULTS,
});
