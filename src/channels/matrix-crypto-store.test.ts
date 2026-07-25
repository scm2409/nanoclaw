/**
 * Snapshot/restore round-trip tests for the Matrix crypto store persistence
 * layer. The crux is binary data (crypto key material) surviving a save+
 * restore cycle byte-for-byte — this is exactly what a naive JSON-based
 * export/import approach (evaluated and rejected during design) would
 * silently corrupt.
 */
import fs from 'fs';
import path from 'path';
import v8 from 'v8';
import { indexedDB } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: '/tmp/nanoclaw-test-matrix-crypto-store' }));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

import { restoreSnapshot, saveSnapshot } from './matrix-crypto-store.js';

const SNAPSHOT_PATH = path.join(TEST_DIR, 'matrix-crypto', 'snapshot.v8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function reqToPromise<T>(req: any): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function allDatabaseNames(): Promise<string[]> {
  const infos = await indexedDB.databases();
  const names: (string | undefined)[] = infos.map((d: { name?: string }) => d.name);
  return names.filter((n): n is string => Boolean(n));
}

async function deleteAllDatabases(): Promise<void> {
  for (const name of await allDatabaseNames()) {
    await reqToPromise(indexedDB.deleteDatabase(name));
  }
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await deleteAllDatabases();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('matrix-crypto-store: binary round-trip', () => {
  it('preserves records — including binary, Map, and Date values — byte-for-byte across save+restore', async () => {
    const secretBytes = new Uint8Array([1, 2, 3, 250, 255, 0]);
    const blobBytes = new Uint8Array([9, 8, 7, 6]);
    const when = new Date('2024-01-01T00:00:00.000Z');

    // Store A: in-line keys (keyPath 'id'), with an index.
    const dbA = await new Promise<any>((resolve, reject) => {
      const req = indexedDB.open('crypto-test', 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore('items', { keyPath: 'id' });
        store.createIndex('byName', 'name', { unique: false, multiEntry: false });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = dbA.transaction(['items'], 'readwrite');
      tx.objectStore('items').put({ id: 'k1', name: 'alice', secret: secretBytes });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    dbA.close();

    // Store B: out-of-line keys (no keyPath), value holds a Map and a Date.
    const dbB = await new Promise<any>((resolve, reject) => {
      const req = indexedDB.open('crypto-test-2', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('sessions');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = dbB.transaction(['sessions'], 'readwrite');
      tx.objectStore('sessions').put({ meta: new Map([['a', 1]]), when, blob: blobBytes }, 'session-1');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    dbB.close();

    await saveSnapshot({ deviceID: 'dev1', userID: '@bot:example.org', baseURL: 'https://example.org' });
    expect(fs.existsSync(SNAPSHOT_PATH)).toBe(true);

    await deleteAllDatabases();
    expect(await allDatabaseNames()).toHaveLength(0);

    const result = await restoreSnapshot('dev1');
    expect(result).toEqual({ restored: true });

    const reopenedA = await reqToPromise<any>(indexedDB.open('crypto-test', 1));
    const recordA = await reqToPromise<{ id: string; name: string; secret: Uint8Array }>(
      reopenedA.transaction(['items'], 'readonly').objectStore('items').get('k1'),
    );
    reopenedA.close();
    expect(recordA.name).toBe('alice');
    expect(recordA.secret).toBeInstanceOf(Uint8Array);
    expect(Array.from(recordA.secret)).toEqual(Array.from(secretBytes));

    const reopenedB = await reqToPromise<any>(indexedDB.open('crypto-test-2', 1));
    const recordB = await reqToPromise<{ meta: Map<string, number>; when: Date; blob: Uint8Array }>(
      reopenedB.transaction(['sessions'], 'readonly').objectStore('sessions').get('session-1'),
    );
    reopenedB.close();
    expect(recordB.meta).toBeInstanceOf(Map);
    expect(recordB.meta.get('a')).toBe(1);
    expect(recordB.when).toBeInstanceOf(Date);
    expect(recordB.when.getTime()).toBe(when.getTime());
    expect(Array.from(recordB.blob)).toEqual(Array.from(blobBytes));
  });
});

describe('matrix-crypto-store: safety fallbacks', () => {
  it('returns not-restored with no throw when no snapshot exists', async () => {
    const result = await restoreSnapshot('dev1');
    expect(result).toEqual({ restored: false, reason: 'no-snapshot' });
    expect(await allDatabaseNames()).toHaveLength(0);
  });

  it('returns not-restored with no throw when the snapshot file is corrupt', async () => {
    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
    fs.writeFileSync(SNAPSHOT_PATH, Buffer.from([1, 2, 3, 4, 5, 255, 254, 253]));

    const result = await restoreSnapshot('dev1');
    expect(result.restored).toBe(false);
    expect(result.reason).toBe('corrupt');
    expect(await allDatabaseNames()).toHaveLength(0);
  });

  it('skips restore when the snapshot is tagged for a different device ID', async () => {
    await saveSnapshot({ deviceID: 'deviceA', userID: '@bot:example.org', baseURL: 'https://example.org' });

    const result = await restoreSnapshot('deviceB');
    expect(result).toEqual({ restored: false, reason: 'device-mismatch' });
    expect(await allDatabaseNames()).toHaveLength(0);
  });

  it('deletes all databases (not just the failing one) when restore fails partway', async () => {
    // Pre-create 'fail-target' at version 1 with NO object stores. The
    // crafted snapshot below claims it should have a store 'foo' at the
    // same version — opening an existing db at its current version never
    // fires onupgradeneeded, so 'foo' is never created there, and the
    // restore's put-phase transaction throws NotFoundError.
    const preexisting = await reqToPromise<any>(indexedDB.open('fail-target', 1));
    preexisting.close();

    const snapshot = {
      format: 1,
      deviceID: 'dev1',
      userID: '@bot:example.org',
      baseURL: 'https://example.org',
      savedAt: Date.now(),
      databases: [
        {
          name: 'good-db',
          version: 1,
          stores: [{ name: 'ok', keyPath: 'id', autoIncrement: false, indexes: [], records: [{ value: { id: 'a' } }] }],
        },
        {
          name: 'fail-target',
          version: 1,
          stores: [
            { name: 'foo', keyPath: null, autoIncrement: false, indexes: [], records: [{ key: 'x', value: 1 }] },
          ],
        },
      ],
    };
    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
    fs.writeFileSync(SNAPSHOT_PATH, v8.serialize(snapshot));

    const result = await restoreSnapshot('dev1');
    expect(result.restored).toBe(false);
    expect(result.reason).toBe('restore-failed');

    // All-or-nothing: 'good-db' must not be left behind even though it
    // would have restored successfully on its own.
    expect(await allDatabaseNames()).not.toContain('good-db');
    expect(await allDatabaseNames()).not.toContain('fail-target');
  });
});
