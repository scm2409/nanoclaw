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
import { loadDmRooms, saveDmRoom, deleteDmRoom } from './matrix-dm-room-store.js';
import { restoreSnapshot, saveSnapshot } from './matrix-crypto-store.js';
import { decryptMatrixAttachment, isEncryptedFile } from './matrix-media-crypto.js';

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
 * Register a crypto encryptor for every joined room that has encryption
 * enabled, so outbound messages can be encrypted regardless of how the
 * client synced.
 *
 * matrix-js-sdk only registers a room's encryptor when the room's
 * `m.room.encryption` state event arrives *inside a sync response*
 * (sync.js → `cryptoCallbacks.onCryptoEvent`). An INCREMENTAL sync — which
 * is what happens whenever a persisted sync snapshot is restored at startup
 * — never re-sends unchanged state, so a room whose encryption was
 * configured in some earlier process never gets an encryptor again. The
 * room and its keys are all present; only the registration is missing, and
 * every send into it then fails with "Cannot encrypt event in unconfigured
 * room <id>".
 *
 * Confirmed in production on 2026-07-25: after a restart that restored a
 * sync snapshot, the operator's live DM room could not be replied to at all
 * — the agent's answer was generated, retried three times, and dropped.
 *
 * Room state itself IS restored from the snapshot, so the fix is to walk the
 * restored rooms and drive the same callback the sync loop would have.
 * Idempotent: `onCryptoEvent` updates an existing encryptor rather than
 * duplicating it, so re-running this (or running it on a client that synced
 * fully) is harmless.
 *
 * Best-effort by design — never throws. A failure here leaves exactly
 * today's behavior, so it can't turn a working start into a broken one.
 */
export async function ensureEncryptorForRoom(
  adapter: ReturnType<typeof createMatrixAdapter>,
  roomId: string,
): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = (adapter as any).client;
    const crypto = client?.getCrypto?.();
    if (!client || typeof crypto?.onCryptoEvent !== 'function') return;

    // Already registered — nothing to do. Reading the backend's internal map
    // keeps the common case free; if the field ever disappears we fall
    // through to onCryptoEvent, which is idempotent anyway.
    if (crypto.roomEncryptors?.[roomId]) return;

    const room = client.getRoom?.(roomId);
    const event = room?.currentState?.getStateEvents?.('m.room.encryption', '');
    if (!room || !event) return;

    await crypto.onCryptoEvent(room, event);
    log.info('Matrix: registered missing room encryptor before send', { roomId });
  } catch (err) {
    log.warn('Matrix: could not ensure room encryptor', { roomId, err });
  }
}

export async function ensureRoomEncryptors(adapter: ReturnType<typeof createMatrixAdapter>): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = (adapter as any).client;
    const crypto = client?.getCrypto?.();
    if (!client || typeof crypto?.onCryptoEvent !== 'function') {
      log.debug('Matrix: skipping encryptor backfill (no crypto backend)');
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rooms: any[] = client.getRooms?.() ?? [];
    let registered = 0;
    for (const room of rooms) {
      try {
        if (room.getMyMembership?.() !== 'join') continue;
        const event = room.currentState?.getStateEvents?.('m.room.encryption', '');
        if (!event) continue;
        await crypto.onCryptoEvent(room, event);
        registered++;
      } catch (err) {
        log.debug('Matrix: could not register encryptor for room', { roomId: room?.roomId, err });
      }
    }
    log.info('Matrix encryptors ensured', { encryptedRooms: registered, totalRooms: rooms.length });
  } catch (err) {
    log.warn('Matrix: encryptor backfill failed, encrypted sends may fail until next full sync', { err });
  }
}

/**
 * Wrap the Matrix adapter so encrypted media attachments survive parsing.
 *
 * @beeper/chat-adapter-matrix@0.2.0's extractAttachments() only reads the
 * plaintext `content.url` field. In an E2EE room, decrypted media events
 * (m.image/m.audio/m.file/...) carry `content.file` instead — the mxc URL of
 * the *ciphertext* plus AES-256-CTR key material. Result: every attachment
 * in an encrypted room parsed to `attachments: []`, so voice notes reached
 * the agent as a bare filename with no audio and no transcript.
 *
 * This override handles the `content.file` shape by reusing the adapter's own
 * download machinery (createAttachmentFetcher: URL resolution + auth headers)
 * and decrypting its result with the event's key material. Plaintext
 * attachments keep going through the original path untouched.
 */
export function wrapWithEncryptedMedia(adapter: ReturnType<typeof createMatrixAdapter>): typeof adapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyAdapter = adapter as any;
  const origExtract = anyAdapter.extractAttachments?.bind(adapter);
  if (!origExtract) {
    log.warn('Matrix adapter has no extractAttachments — encrypted media support disabled');
    return adapter;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  anyAdapter.extractAttachments = (content: Record<string, any>) => {
    const plain = origExtract(content);
    if (Array.isArray(plain) && plain.length > 0) return plain;

    const file = content?.file;
    if (!isEncryptedFile(file)) return plain;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const info: Record<string, any> = content.info && typeof content.info === 'object' ? content.info : {};
    const mimeType = typeof info.mimetype === 'string' ? info.mimetype : undefined;
    const downloadCiphertext = anyAdapter.createAttachmentFetcher?.(file.url);

    return [
      {
        type: anyAdapter.attachmentTypeForContent?.(content, mimeType) ?? 'file',
        url: file.url,
        name: typeof content.body === 'string' && content.body ? content.body : undefined,
        mimeType,
        size: typeof info.size === 'number' ? info.size : undefined,
        width: typeof info.w === 'number' ? info.w : undefined,
        height: typeof info.h === 'number' ? info.h : undefined,
        fetchData: downloadCiphertext
          ? async () => decryptMatrixAttachment(await downloadCiphertext(), file)
          : undefined,
      },
    ];
  };

  return adapter;
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

  // Seed both caches from disk so a restart doesn't start cold: a
  // proactive/host-initiated send right after a restart (a scheduled task,
  // an approval prompt) — before any fresh inbound message has re-warmed
  // the in-memory caches — previously had nothing to fall back on except
  // openDM(), which is exactly the unreliable path every incident so far
  // traced back to. See matrix-dm-room-store.ts.
  for (const [userHandle, entry] of Object.entries(loadDmRooms())) {
    userToRoomCache.set(userHandle, entry.roomId);
    roomToUserCache.set(entry.roomId, userHandle);
  }

  function isUserHandle(threadId: string): boolean {
    try {
      const { roomID } = adapter.decodeThreadId(threadId);
      return !roomID.startsWith('!');
    } catch {
      return true;
    }
  }

  /**
   * Follow an m.room.tombstone chain to its replacement room.
   *
   * A room upgrade is the "expected" way a Matrix room's identity changes —
   * unlike a departure, it isn't evidence the mapping is wrong, just that the
   * room id moved. A cached/persisted pointer at the old room id must resolve
   * through to the successor rather than being treated as merely stale (which
   * would fall to openDM() and invent a brand-new room for a user we already
   * have a perfectly good, if renamed, room for).
   *
   * `seen` guards against a (malformed/cyclic) tombstone chain looping forever.
   */
  function followTombstone(roomId: string): string {
    const client = (adapter as any).client;
    let current = roomId;
    const seen = new Set<string>();
    while (!seen.has(current)) {
      seen.add(current);
      const room = client?.getRoom?.(current);
      const tombstone = room?.currentState?.getStateEvents?.('m.room.tombstone', '');
      const replacement = tombstone?.getContent?.()?.replacement_room;
      if (typeof replacement !== 'string' || !replacement) break;
      current = replacement;
    }
    return current;
  }

  /**
   * Search roomToUserCache (room -> user, populated from every confirmed
   * inbound event and never pruned) for ANY room still on record for this
   * user, before ever giving up to openDM().
   *
   * This closes the gap the single-slot userToRoomCache leaves: that slot
   * holds only the MOST RECENTLY confirmed room, so when it goes stale
   * (confirmed leave/ban — typically an openDM()-invented ghost room the
   * user never actually joined, whose invite eventually reads as a
   * departure), the old behavior deleted the slot and fell straight to
   * openDM(), even when an older, perfectly live room for this same user
   * was still sitting in roomToUserCache. That room is strictly better
   * evidence than inventing yet another one.
   *
   * Prefers a room with confirmed 'join' membership; falls back to a room
   * whose membership can't be determined yet (unloaded client store right
   * after a restart — same "don't false-negative on missing state" policy
   * as the single-slot check above) only if no confirmed-join room exists.
   * Never returns a confirmed leave/ban room.
   */
  function findConfirmedRoomForUser(userHandle: string): string | undefined {
    const client = (adapter as any).client;
    let candidate: string | undefined;
    for (const [roomId, user] of roomToUserCache) {
      if (user !== userHandle) continue;
      const resolvedRoomId = followTombstone(roomId);
      const room = client?.getRoom?.(resolvedRoomId);
      const membership = room?.getMyMembership?.();
      if (membership === 'leave' || membership === 'ban') continue;
      if (membership === 'join') return resolvedRoomId;
      candidate = candidate ?? resolvedRoomId;
    }
    return candidate;
  }

  /**
   * Drop a room from both caches for this user — used when a real send into
   * it just failed, which is strictly stronger evidence of staleness than
   * anything a membership check can tell us (the local Room object can look
   * perfectly joined for a room that's genuinely dead server-side).
   */
  function invalidateKnownRoom(userHandle: string, roomId: string): void {
    if (userToRoomCache.get(userHandle) === roomId) {
      userToRoomCache.delete(userHandle);
      deleteDmRoom(userHandle);
    }
    if (roomToUserCache.get(roomId) === userHandle) roomToUserCache.delete(roomId);
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
      // A room upgrade (m.room.tombstone) isn't evidence the pointer is
      // wrong, just that the room id moved — follow it before judging
      // membership, which is meaningless on the superseded room.
      const resolvedKnownRoomId = followTombstone(knownRoomId);
      const room = client?.getRoom(resolvedKnownRoomId);
      const membership = room?.getMyMembership?.();
      log.debug('Matrix resolveThreadId cache validity check', {
        knownRoomId,
        resolvedKnownRoomId,
        hasClient: Boolean(client),
        hasRoom: Boolean(room),
        membership,
      });
      if (membership === 'leave' || membership === 'ban') {
        // Confirmed departure of the single-slot pointer. Before falling to
        // openDM(), check whether another room for this same user is still
        // on record — see findConfirmedRoomForUser for why that outranks
        // inventing a new room.
        userToRoomCache.delete(userHandle);
        const otherKnownRoom = findConfirmedRoomForUser(userHandle);
        if (otherKnownRoom) {
          log.info('Matrix: single-slot room went stale, reusing another confirmed room instead of openDM', {
            userHandle,
            staleRoomId: knownRoomId,
            recoveredRoomId: otherKnownRoom,
          });
          userToRoomCache.set(userHandle, otherKnownRoom);
          roomToUserCache.set(otherKnownRoom, userHandle);
          saveDmRoom(userHandle, otherKnownRoom);
          return adapter.encodeThreadId({ roomID: otherKnownRoom });
        }
      } else {
        if (resolvedKnownRoomId !== knownRoomId) {
          log.info('Matrix: cached room was tombstoned, following to replacement', {
            userHandle,
            oldRoomId: knownRoomId,
            newRoomId: resolvedKnownRoomId,
          });
          userToRoomCache.set(userHandle, resolvedKnownRoomId);
          roomToUserCache.set(resolvedKnownRoomId, userHandle);
          saveDmRoom(userHandle, resolvedKnownRoomId);
        }
        return adapter.encodeThreadId({ roomID: resolvedKnownRoomId });
      }
    }

    log.info('Matrix: resolving DM room for user handle', { userHandle });
    const resolved = await adapter.openDM(userHandle);

    // openDM can take tens of seconds — it may create a room and invite the
    // user into it. A confirmed inbound message can easily land inside that
    // window, and it is strictly better evidence than openDM's guess. Writing
    // openDM's result unconditionally after the await clobbered exactly that,
    // which is what took the operator's DM down on 2026-07-25:
    //   15:12:21  cacheSize=0                    -> openDM starts
    //   15:12:45  __onInboundSender roomID=!new  -> cache corrected
    //   15:12:48  openDM lands                   -> cache reverted to !stale
    // Every reply then went to a room the user never had open, so they saw a
    // typing indicator and nothing else.
    //
    // So: re-read the cache after the await. If a confirmed inbound claimed a
    // different room meanwhile, that room wins — for the cache AND for this
    // very send, which is still in flight and would otherwise be misrouted.
    try {
      const { roomID } = adapter.decodeThreadId(resolved);
      roomToUserCache.set(roomID, userHandle);

      const confirmedMeanwhile = userToRoomCache.get(userHandle);
      if (confirmedMeanwhile && confirmedMeanwhile !== roomID) {
        log.info('Matrix: inbound confirmed a different room while openDM was in flight, preferring it', {
          userHandle,
          openDmRoom: roomID,
          confirmedRoom: confirmedMeanwhile,
        });
        return adapter.encodeThreadId({ roomID: confirmedMeanwhile });
      }

      userToRoomCache.set(userHandle, roomID);
      saveDmRoom(userHandle, roomID);
    } catch (err) {
      // decode failure is non-fatal — outbound still works
      log.debug('Matrix: could not decode openDM result', { userHandle, err });
    }

    return resolved;
  }

  // Rewrite inbound room-based channel IDs to user-handle form for DM rooms.
  // Non-DM rooms pass through unchanged.
  //
  // Deliberately populates roomToUserCache ONLY, never userToRoomCache.
  // "Which DM partner does this room belong to" is a stable property of the
  // room and safe to learn from any event. "Which room is this user
  // currently reachable in" is not — and this function runs for every event
  // it resolves, including ones in rooms the user has moved on from and the
  // bot's own echoes.
  //
  // Writing userToRoomCache here caused the 2026-07-25 outage: the operator's
  // reply room was correctly cached from their inbound message, then a stray
  // event in an older room reverted it 3.4s later, and every reply after that
  // went to a room they never had open. They saw the bot typing, then
  // silence. The host's own debug trace:
  //   14:48:02.800  __onInboundSender  roomID=!new   (cache -> !new)
  //   14:48:06.225  cache lookup       knownRoomId=!old  <- reverted
  // userToRoomCache is now written only from confirmed inbound traffic
  // (__onInboundSender) and from openDM's own result when nothing is known.
  adapter.channelIdFromThreadId = (threadId: string): string => {
    try {
      const { roomID } = adapter.decodeThreadId(threadId);
      if (!roomID.startsWith('!')) return origChannelIdFromThreadId(threadId);

      const cached = roomToUserCache.get(roomID);
      if (cached) return `matrix:${cached}`;

      // Not cached — check if this is a DM by membership count
      const client = (adapter as any).client;
      const room = client?.getRoom(roomID);
      if (!room) return origChannelIdFromThreadId(threadId);
      if (room.getJoinedMemberCount() > 2) return origChannelIdFromThreadId(threadId);

      const botId = (adapter as any).userID;
      const otherMember = room.getJoinedMembers().find((m: { userId: string }) => m.userId !== botId);
      if (!otherMember) return origChannelIdFromThreadId(threadId);

      roomToUserCache.set(roomID, otherMember.userId);
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
      saveDmRoom(senderId, roomID);
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
    // Repair a missing encryptor at the one moment the target room is
    // guaranteed to be known and loaded. The startup backfill can miss rooms
    // whose state the client's store hadn't materialized yet when sync first
    // reported ready — observed in production as encryptedRooms=0 on a start
    // that later had several encrypted rooms. Without this, that gap surfaces
    // as a permanent "Cannot encrypt event in unconfigured room" delivery
    // failure. No-ops once the encryptor exists.
    try {
      const { roomID } = adapter.decodeThreadId(resolvedTid);
      await ensureEncryptorForRoom(adapter, roomID);
    } catch {
      // Undecodable thread id — let the underlying send surface the error.
    }
    try {
      return await origPostMessage(resolvedTid, ...args);
    } catch (err) {
      // Self-heal only applies to sends we resolved ourselves from a user
      // handle — a caller sending directly into an explicit room id owns
      // that resolution and any retry policy itself.
      if (!isUserHandle(threadId)) throw err;

      let staleRoomId: string;
      try {
        staleRoomId = adapter.decodeThreadId(resolvedTid).roomID;
      } catch {
        throw err;
      }
      const userHandle = threadId.startsWith('matrix:') ? threadId.slice('matrix:'.length) : threadId;

      // The local Room object can look perfectly joined for a room that's
      // genuinely dead server-side (kicked, room deleted, etc.) — a real
      // send failure is stronger evidence than any membership check, so
      // this is the one case where re-deferring to openDM() is correct: we
      // just learned our own cached/persisted history is wrong.
      log.warn('Matrix: send into resolved room failed, invalidating cache and re-resolving via openDM', {
        userHandle,
        staleRoomId,
        err,
      });
      invalidateKnownRoom(userHandle, staleRoomId);

      const forced = await adapter.openDM(userHandle);
      try {
        const { roomID } = adapter.decodeThreadId(forced);
        roomToUserCache.set(roomID, userHandle);
        userToRoomCache.set(userHandle, roomID);
        saveDmRoom(userHandle, roomID);
        await ensureEncryptorForRoom(adapter, roomID);
      } catch {
        // Non-fatal — the retry below still has its best shot at the raw
        // openDM result even if cache bookkeeping or encryptor setup failed.
      }
      return origPostMessage(forced, ...args);
    }
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

    const matrixAdapter = wrapWithDmResolution(wrapWithEncryptedMedia(createMatrixAdapter()));
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

      // Must run AFTER sync is ready (rooms are only in the client's store
      // once the initial/restored sync has been applied) and BEFORE the host
      // starts delivering, so the first outbound message after a restart
      // already has a usable encryptor.
      await ensureRoomEncryptors(matrixAdapter);

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
