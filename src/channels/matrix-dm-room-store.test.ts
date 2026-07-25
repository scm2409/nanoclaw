/**
 * Round-trip tests for the persisted Matrix DM user->room store.
 *
 * This is the durable half of the DM-room-resolution fix: the in-memory
 * caches in matrix.ts's wrapWithDmResolution are wiped on every restart,
 * so a proactive/host-initiated send right after a restart (before any
 * fresh inbound message has re-warmed the cache) had nothing to fall back
 * on except openDM() — which is exactly the unreliable path three prior
 * incidents traced back to. This store gives that lookup a persisted
 * source of truth instead.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: '/tmp/nanoclaw-test-matrix-dm-room-store' }));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

import { loadDmRooms, saveDmRoom, deleteDmRoom } from './matrix-dm-room-store.js';

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('matrix-dm-room-store', () => {
  it('returns an empty map when nothing has been saved yet', () => {
    expect(loadDmRooms()).toEqual({});
  });

  it('round-trips a saved room across separate load calls (simulates surviving a restart)', () => {
    saveDmRoom('@user1:example.org', '!known:example.org');
    saveDmRoom('@user2:example.org', '!other:example.org');

    // A fresh load call, as a fresh process would do at startup.
    const loaded = loadDmRooms();
    expect(loaded['@user1:example.org']?.roomId).toBe('!known:example.org');
    expect(loaded['@user2:example.org']?.roomId).toBe('!other:example.org');
    expect(typeof loaded['@user1:example.org']?.confirmedAt).toBe('number');
  });

  it('overwrites a prior entry for the same user', () => {
    saveDmRoom('@user1:example.org', '!old:example.org');
    saveDmRoom('@user1:example.org', '!new:example.org');

    const loaded = loadDmRooms();
    expect(loaded['@user1:example.org']?.roomId).toBe('!new:example.org');
    expect(Object.keys(loaded)).toHaveLength(1);
  });

  it('removes an entry on deleteDmRoom', () => {
    saveDmRoom('@user1:example.org', '!known:example.org');
    deleteDmRoom('@user1:example.org');

    expect(loadDmRooms()).toEqual({});
  });

  it('never throws on a corrupt store file — degrades to empty', () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(path.join(TEST_DIR, 'matrix-dm-rooms.json'), '{not valid json');

    expect(() => loadDmRooms()).not.toThrow();
    expect(loadDmRooms()).toEqual({});
  });

  it('deleteDmRoom on a nonexistent user is a no-op, never throws', () => {
    expect(() => deleteDmRoom('@nobody:example.org')).not.toThrow();
  });
});
