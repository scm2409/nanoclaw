/**
 * Persisted user -> room mapping for Matrix DMs.
 *
 * wrapWithDmResolution's in-memory caches (matrix.ts) are the fast path, but
 * they're wiped on every restart. A proactive/host-initiated send (a
 * scheduled task, an approval prompt) right after a restart — before any
 * fresh inbound message has re-warmed the cache — had nothing to fall back
 * on except openDM(), which is exactly the unreliable path three prior
 * incidents traced back to (it silently invents a new, unencrypted room on
 * any cache miss). This store gives that lookup a durable source of truth,
 * so openDM() is only ever called for a user we have truly never heard from.
 *
 * Deliberately a small flat JSON file, not the crypto store's IndexedDB
 * snapshot machinery — this is a handful of plain strings, not binary crypto
 * key material, so v8-serialize-and-restore would be overkill.
 *
 * Never throws: a missing or corrupt file degrades to "no known rooms",
 * matching the crypto store's philosophy of never turning a working start
 * into a broken one.
 */
import fs from 'fs';
import path from 'path';

import { log } from '../log.js';
import { DATA_DIR } from '../config.js';

// Overridable for the same reason matrix-crypto-store.ts's SNAPSHOT_DIR is:
// the live-server integration harness runs against a throwaway test account
// and must never read or overwrite the production bot's real store.
const STORE_DIR = process.env.MATRIX_DM_ROOM_STORE_DIR ? path.resolve(process.env.MATRIX_DM_ROOM_STORE_DIR) : DATA_DIR;
const STORE_PATH = path.join(STORE_DIR, 'matrix-dm-rooms.json');
const STORE_TMP_PATH = `${STORE_PATH}.tmp`;

export interface DmRoomEntry {
  roomId: string;
  confirmedAt: number;
}

export type DmRoomMap = Record<string, DmRoomEntry>;

function readStore(): DmRoomMap {
  let raw: string;
  try {
    raw = fs.readFileSync(STORE_PATH, 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as DmRoomMap;
  } catch (err) {
    log.warn('Matrix DM room store is corrupt, starting fresh', { err });
    return {};
  }
}

function writeStore(map: DmRoomMap): void {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    // Atomic: write to a temp file, then rename over the real path — a crash
    // mid-write can't corrupt the last good store.
    fs.writeFileSync(STORE_TMP_PATH, JSON.stringify(map));
    fs.renameSync(STORE_TMP_PATH, STORE_PATH);
  } catch (err) {
    log.warn('Failed to save Matrix DM room store', { err });
  }
}

/** All known user -> confirmed-room mappings. Never throws. */
export function loadDmRooms(): DmRoomMap {
  return readStore();
}

/** Persist (or overwrite) the confirmed room for a user handle. Never throws. */
export function saveDmRoom(userHandle: string, roomId: string): void {
  const map = readStore();
  map[userHandle] = { roomId, confirmedAt: Date.now() };
  writeStore(map);
}

/** Remove a user's entry (the room turned out to be stale/dead). Never throws. */
export function deleteDmRoom(userHandle: string): void {
  const map = readStore();
  if (!(userHandle in map)) return;
  delete map[userHandle];
  writeStore(map);
}
