/**
 * Startup self-heal for the Matrix adapter's persisted sync snapshot.
 *
 * @beeper/chat-adapter-matrix persists matrix-js-sdk's sync state
 * (ChatStateMatrixStore) in the Chat SDK state adapter: the accumulated sync
 * (`<scope>:saved-sync`), a meta record carrying the sync token
 * (`<scope>:meta`), and per-room lazy-loaded member lists
 * (`<scope>:oob-members:<room>`). On restart the client resumes with an
 * INCREMENTAL sync from that token, and an incremental sync only carries
 * state that changed since — so whatever state the snapshot lacks, it lacks
 * forever.
 *
 * Observed in production on 2026-09-25: the snapshot held, for the operator's
 * encrypted DM, only its two m.room.member events — no m.room.create, no
 * m.room.encryption. After every restart the first reply went out as
 * plaintext, or encrypted with its megolm key shared only with the bot's own
 * devices, so Element X could not decrypt it until the operator wrote first.
 * The likely origin is the adapter's own getSavedSyncToken(), which falls back
 * to meta.nextBatch when the saved sync itself is missing: the client then
 * resumes incrementally on top of an EMPTY accumulator.
 *
 * The repair, run before the adapter creates its store: if the snapshot is
 * missing/unreadable while a sync token survives, knows no joined rooms at
 * all, lacks a room the homeserver lists as joined, or any joined room lacks
 * m.room.create (every room's first state
 * event — its absence proves the room's state was never fully received),
 * delete the snapshot, the token and
 * the cached member lists. The client then does a fresh initial sync, which
 * carries full room state. Events from that initial sync are not re-dispatched
 * as inbound messages — the adapter ignores everything before live sync.
 *
 * Pending outgoing to-device batches and client options are left alone; they
 * are not sync state. Never throws: on any failure the store is left as-is.
 */
import { log } from '../log.js';

export interface SyncStoreKv {
  get(key: string): Promise<unknown>;
  delete(key: string): Promise<void>;
}

export type SyncStoreRepairResult =
  | { repaired: false }
  | { repaired: true; reason: 'orphaned-sync-token' }
  | { repaired: true; reason: 'no-joined-rooms' }
  | { repaired: true; reason: 'missing-joined-rooms'; rooms: string[] }
  | { repaired: true; reason: 'incomplete-room-state'; rooms: string[] };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function isSavedSync(value: Json): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof value.nextBatch === 'string' &&
    !!value.roomsData &&
    typeof value.roomsData === 'object'
  );
}

function hasCreateEvent(room: Json): boolean {
  const events: Json[] = [
    ...(room?.state?.events ?? []),
    ...(room?.['org.matrix.msc4222.state_after']?.events ?? []),
    ...(room?.timeline?.events ?? []),
  ];
  return events.some((e) => e?.type === 'm.room.create' && e?.state_key === '');
}

async function deleteSyncState(kv: SyncStoreKv, scopeKey: string): Promise<void> {
  const indexKey = `${scopeKey}:room-index:oob-members`;
  const index: Json = await kv.get(indexKey);
  const oobRooms: string[] = Array.isArray(index?.roomIDs) ? index.roomIDs : [];
  await kv.delete(`${scopeKey}:saved-sync`);
  await kv.delete(`${scopeKey}:meta`);
  await kv.delete(indexKey);
  for (const roomId of oobRooms) {
    await kv.delete(`${scopeKey}:oob-members:${encodeURIComponent(roomId)}`);
  }
}

export interface SyncStoreRepairOptions {
  /** The account's joined rooms per the homeserver; a failure skips this check. */
  listJoinedRooms?: () => Promise<string[]>;
}

export async function repairIncompleteSyncSnapshot(
  kv: SyncStoreKv,
  scopeKey: string,
  opts: SyncStoreRepairOptions = {},
): Promise<SyncStoreRepairResult> {
  try {
    const savedSync: Json = await kv.get(`${scopeKey}:saved-sync`);

    if (!isSavedSync(savedSync)) {
      const meta: Json = await kv.get(`${scopeKey}:meta`);
      if (typeof meta?.nextBatch !== 'string') return { repaired: false };
      await deleteSyncState(kv, scopeKey);
      log.warn('Matrix sync snapshot missing but sync token survived — discarding token for a fresh initial sync', {
        scopeKey,
      });
      return { repaired: true, reason: 'orphaned-sync-token' };
    }

    const joined: Record<string, Json> = savedSync.roomsData.join ?? {};

    // A joined room the snapshot doesn't know at all never gets a Room object
    // after an incremental resume — until something changes in it — and
    // js-sdk sends into an unknown room WITHOUT encrypting (the 2026-09-25
    // plaintext send). Only the server can tell us about such a room.
    let serverRooms: string[] | null = null;
    try {
      serverRooms = opts.listJoinedRooms ? await opts.listJoinedRooms() : null;
    } catch (err) {
      log.debug('Matrix joined-rooms lookup failed, skipping that snapshot check', { err });
    }
    const missing = (serverRooms ?? []).filter((roomId) => !(roomId in joined));
    if (missing.length > 0) {
      await deleteSyncState(kv, scopeKey);
      log.warn('Matrix sync snapshot is missing joined rooms — discarding it for a fresh initial sync', {
        scopeKey,
        rooms: missing,
      });
      return { repaired: true, reason: 'missing-joined-rooms', rooms: missing };
    }

    if (Object.keys(joined).length === 0) {
      // Resuming from this token, the client only learns about rooms whose
      // state changes afterwards — and only that changed state. Seen on the
      // live-test identity. A fresh initial sync is cheap for an account that
      // really has no rooms.
      await deleteSyncState(kv, scopeKey);
      log.warn('Matrix sync snapshot knows no joined rooms — discarding it for a fresh initial sync', { scopeKey });
      return { repaired: true, reason: 'no-joined-rooms' };
    }
    const rooms = Object.entries(joined)
      .filter(([, room]) => !hasCreateEvent(room))
      .map(([roomId]) => roomId);
    if (rooms.length === 0) return { repaired: false };

    await deleteSyncState(kv, scopeKey);
    log.warn('Matrix sync snapshot has rooms with incomplete state — discarding it for a fresh initial sync', {
      scopeKey,
      rooms,
    });
    return { repaired: true, reason: 'incomplete-room-state', rooms };
  } catch (err) {
    log.warn('Matrix sync snapshot check failed, leaving it as-is', { scopeKey, err });
    return { repaired: false };
  }
}

/**
 * Run repairIncompleteSyncSnapshot inside the adapter, right before it builds
 * its sync store — the one point where both the adapter's own state adapter
 * (already namespaced per instance) and its exact store scope key are known.
 * Patches the adapter's private `maybeCreateMatrixStore`
 * (@beeper/chat-adapter-matrix@0.2.0); if that hook ever disappears the wrap
 * is a no-op and startup is unchanged. Mutates and returns the adapter.
 */
export function wrapWithSyncStoreRepair<T extends object>(adapter: T): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = adapter as any;
  if (typeof a.maybeCreateMatrixStore !== 'function') {
    log.warn('Matrix adapter has no maybeCreateMatrixStore hook — sync snapshot self-heal disabled');
    return adapter;
  }
  const orig = a.maybeCreateMatrixStore;
  a.maybeCreateMatrixStore = async function (this: Json, ...args: unknown[]) {
    try {
      const auth = args[0] as Json;
      const scopeKey = this.stateAdapter ? this.resolveMatrixStoreContext?.(auth)?.scopeKey : undefined;
      const baseURL = typeof this.baseURL === 'string' ? this.baseURL.replace(/\/+$/, '') : undefined;
      const accessToken = auth?.accessToken;
      const listJoinedRooms =
        baseURL && accessToken
          ? async (): Promise<string[]> => {
              const res = await fetch(`${baseURL}/_matrix/client/v3/joined_rooms`, {
                headers: { Authorization: `Bearer ${accessToken}` },
                signal: AbortSignal.timeout(15_000),
              });
              if (!res.ok) throw new Error(`joined_rooms: HTTP ${res.status}`);
              const body = (await res.json()) as { joined_rooms?: unknown };
              return Array.isArray(body.joined_rooms) ? body.joined_rooms.filter((r) => typeof r === 'string') : [];
            }
          : undefined;
      if (scopeKey) await repairIncompleteSyncSnapshot(this.stateAdapter, scopeKey, { listJoinedRooms });
    } catch (err) {
      log.warn('Matrix sync snapshot self-heal skipped', { err });
    }
    return orig.apply(this, args);
  };
  return adapter;
}
