/**
 * Snapshot/restore for the Matrix E2EE crypto store.
 *
 * matrix.ts uses `fake-indexeddb` (in-memory) to satisfy matrix-sdk-crypto-wasm's
 * requirement for a global `indexedDB`, which doesn't exist natively in Node. Being
 * in-memory, every host restart wiped all E2EE state (olm one-time keys, megolm
 * sessions, cross-signing trust) while the Matrix device ID persisted separately —
 * causing one-time-key upload collisions on the server that permanently blocked new
 * key exchange until the device ID was rotated. See matrix.ts's top comment for the
 * full incident writeup, including why a prior attempt to swap in a disk-backed
 * IndexedDB implementation (`indexeddbshim`) was reverted (missing IDBTransaction.commit()).
 *
 * This module keeps `fake-indexeddb` (proven compatible with matrix-sdk-crypto-wasm —
 * it's the engine already running) and adds save/restore on top of it, going through
 * its standard public IndexedDB API only — never its internals — so it exercises the
 * exact same code paths already proven correct.
 *
 * Serialization uses `node:v8` (structured-clone-family), not JSON: crypto key
 * material is stored as binary (ArrayBuffer/Uint8Array), which JSON.stringify would
 * silently corrupt.
 *
 * Every failure mode here degrades to today's fresh-empty-store behavior — a missing,
 * corrupt, or partially-restorable snapshot must never crash the Matrix channel or
 * leave the crypto engine looking at inconsistent data.
 */
import fs from 'fs';
import path from 'path';
import v8 from 'v8';
import { indexedDB } from 'fake-indexeddb';

import { log } from '../log.js';
import { DATA_DIR } from '../config.js';

// Overridable so the live-server integration harness (scripts/matrix-live-harness.ts)
// can point at an isolated directory — it runs against a throwaway test
// account and must never read or overwrite the production bot's real
// snapshot. Unset in every real deployment, so production always resolves
// the DATA_DIR-based path below.
const SNAPSHOT_DIR = process.env.MATRIX_CRYPTO_SNAPSHOT_DIR
  ? path.resolve(process.env.MATRIX_CRYPTO_SNAPSHOT_DIR)
  : path.join(DATA_DIR, 'matrix-crypto');
const SNAPSHOT_PATH = path.join(SNAPSHOT_DIR, 'snapshot.v8');
const SNAPSHOT_TMP_PATH = `${SNAPSHOT_PATH}.tmp`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Key = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Value = any;

interface IndexSchema {
  name: string;
  keyPath: string | string[];
  unique: boolean;
  multiEntry: boolean;
}

interface StoreSnapshot {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: IndexSchema[];
  // `key` is present only for out-of-line-key stores (keyPath === null); for
  // in-line-key stores the key is embedded in `value` and re-derived by put().
  records: { key?: Key; value: Value }[];
}

interface DatabaseSnapshot {
  name: string;
  version: number;
  stores: StoreSnapshot[];
}

interface Snapshot {
  format: 1;
  deviceID: string | undefined;
  userID: string | undefined;
  baseURL: string | undefined;
  savedAt: number;
  databases: DatabaseSnapshot[];
}

export interface SnapshotMeta {
  deviceID?: string;
  userID?: string;
  baseURL?: string;
}

export interface RestoreResult {
  restored: boolean;
  reason?: 'no-snapshot' | 'corrupt' | 'device-mismatch' | 'restore-failed';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function reqToPromise<T>(req: any): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function txDone(tx: any): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** Read every database currently in `indexedDB` via the standard public API. */
export async function exportDatabases(): Promise<DatabaseSnapshot[]> {
  const dbInfos = await indexedDB.databases();
  const databases: DatabaseSnapshot[] = [];

  for (const { name } of dbInfos) {
    if (!name) continue;
    // No version arg: open at the current version, no upgrade triggered.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db: any = await reqToPromise(indexedDB.open(name));
    try {
      const storeNames: string[] = Array.from(db.objectStoreNames);
      const stores: StoreSnapshot[] = [];

      if (storeNames.length > 0) {
        const tx = db.transaction(storeNames, 'readonly');
        for (const storeName of storeNames) {
          const store = tx.objectStore(storeName);
          const indexes: IndexSchema[] = Array.from(store.indexNames as string[]).map((indexName: string) => {
            const idx = store.index(indexName);
            return { name: indexName, keyPath: idx.keyPath, unique: idx.unique, multiEntry: idx.multiEntry };
          });

          const records: { key?: Key; value: Value }[] = [];
          await new Promise<void>((resolve, reject) => {
            const cursorReq = store.openCursor();
            cursorReq.onsuccess = () => {
              const cursor = cursorReq.result;
              if (!cursor) {
                resolve();
                return;
              }
              records.push(store.keyPath == null ? { key: cursor.key, value: cursor.value } : { value: cursor.value });
              cursor.continue();
            };
            cursorReq.onerror = () => reject(cursorReq.error);
          });

          stores.push({
            name: storeName,
            keyPath: store.keyPath,
            autoIncrement: store.autoIncrement,
            indexes,
            records,
          });
        }
        await txDone(tx);
      }

      databases.push({ name, version: db.version, stores });
    } finally {
      db.close();
    }
  }

  return databases;
}

/** Recreate one database (schema + records) from a snapshot. Throws on any failure. */
async function restoreDatabase(dbSnap: DatabaseSnapshot): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = await new Promise((resolve, reject) => {
    const req = indexedDB.open(dbSnap.name, dbSnap.version);
    req.onupgradeneeded = () => {
      const database = req.result;
      for (const store of dbSnap.stores) {
        const objectStore = database.createObjectStore(store.name, {
          keyPath: store.keyPath,
          autoIncrement: store.autoIncrement,
        });
        for (const idx of store.indexes) {
          objectStore.createIndex(idx.name, idx.keyPath, { unique: idx.unique, multiEntry: idx.multiEntry });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  try {
    const storeNames = dbSnap.stores.map((s) => s.name);
    if (storeNames.length > 0) {
      const tx = db.transaction(storeNames, 'readwrite');
      for (const store of dbSnap.stores) {
        const objectStore = tx.objectStore(store.name);
        for (const record of store.records) {
          if (store.keyPath == null) {
            objectStore.put(record.value, record.key);
          } else {
            objectStore.put(record.value);
          }
        }
      }
      await txDone(tx);
    }
  } finally {
    db.close();
  }
}

/**
 * Export the current crypto store and write it to disk. Never throws — a failed
 * save just means the next restore (or the next autosave) tries again.
 */
export async function saveSnapshot(meta: SnapshotMeta): Promise<void> {
  try {
    const databases = await exportDatabases();
    const snapshot: Snapshot = {
      format: 1,
      deviceID: meta.deviceID,
      userID: meta.userID,
      baseURL: meta.baseURL,
      savedAt: Date.now(),
      databases,
    };
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const buf = v8.serialize(snapshot);
    // Atomic: write to a temp file, then rename over the real path. A crash
    // mid-write can't corrupt the last good snapshot.
    fs.writeFileSync(SNAPSHOT_TMP_PATH, buf);
    fs.renameSync(SNAPSHOT_TMP_PATH, SNAPSHOT_PATH);
    log.debug('Matrix crypto store snapshot saved', { databases: databases.length, bytes: buf.length });
  } catch (err) {
    log.warn('Failed to save Matrix crypto store snapshot', { err });
  }
}

/**
 * Restore a previously-saved snapshot into the current (fresh, empty) `indexedDB`.
 * Always degrades to "not restored" (today's empty-store behavior) instead of
 * throwing — called on the startup path, must never block channel start.
 *
 * `expectedDeviceID` guards against replaying a stale identity's crypto state into
 * a new device ID (e.g. after a deliberate rotation to clear poisoned server-side
 * one-time-key state) — the crypto DB name isn't device-scoped, so without this
 * check a rotation wouldn't actually get a clean slate.
 */
export async function restoreSnapshot(expectedDeviceID: string | undefined): Promise<RestoreResult> {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(SNAPSHOT_PATH);
  } catch {
    return { restored: false, reason: 'no-snapshot' };
  }

  let snapshot: Snapshot;
  try {
    snapshot = v8.deserialize(raw) as Snapshot;
    if (snapshot?.format !== 1 || !Array.isArray(snapshot.databases)) {
      throw new Error('Malformed snapshot');
    }
  } catch (err) {
    log.warn('Matrix crypto store snapshot is corrupt, starting fresh', { err });
    return { restored: false, reason: 'corrupt' };
  }

  if (expectedDeviceID && snapshot.deviceID && snapshot.deviceID !== expectedDeviceID) {
    log.info('Matrix crypto store snapshot is for a different device ID, starting fresh', {
      snapshotDeviceID: snapshot.deviceID,
      expectedDeviceID,
    });
    return { restored: false, reason: 'device-mismatch' };
  }

  try {
    for (const dbSnap of snapshot.databases) {
      await restoreDatabase(dbSnap);
    }
  } catch (err) {
    log.warn('Failed to restore Matrix crypto store snapshot, deleting partially-restored databases', { err });
    for (const dbSnap of snapshot.databases) {
      try {
        await reqToPromise(indexedDB.deleteDatabase(dbSnap.name));
      } catch {
        // Best effort — nothing more we can do if cleanup itself fails.
      }
    }
    return { restored: false, reason: 'restore-failed' };
  }

  log.info('Matrix crypto store restored from snapshot', { databases: snapshot.databases.length });
  return { restored: true };
}
