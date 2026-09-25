/**
 * Tests for repairIncompleteSyncSnapshot — the startup check that discards a
 * persisted Matrix sync snapshot whose room state is incomplete, so the
 * client does a fresh initial sync instead of resuming incrementally on top
 * of it.
 *
 * Regression context (2026-09-25): the production snapshot held, for the
 * operator's DM, only the two m.room.member events — no m.room.create, no
 * m.room.encryption. Incremental syncs never resend unchanged state, so the
 * gap survived every restart; after each one the first reply went out as
 * plaintext or with its megolm key shared only with the bot's own devices.
 */
import { describe, it, expect, vi } from 'vitest';

import { repairIncompleteSyncSnapshot, wrapWithSyncStoreRepair } from './matrix-sync-store-repair.js';

const SCOPE = 'matrix:store:https%3A%2F%2Fexample.org:%40bot%3Aexample.org:DEVICE';

function stateEvent(type: string, stateKey = '') {
  return { type, state_key: stateKey, content: {}, sender: '@x:example.org', event_id: `$${type}${stateKey}` };
}

const FULL_STATE = [
  stateEvent('m.room.create'),
  stateEvent('m.room.encryption'),
  stateEvent('m.room.member', '@bot:example.org'),
  stateEvent('m.room.member', '@user:example.org'),
];
const MEMBERS_ONLY = [
  stateEvent('m.room.member', '@bot:example.org'),
  stateEvent('m.room.member', '@user:example.org'),
];

function joinedRoom(state: object[], timelineState: object[] = []) {
  return {
    state: { events: state },
    'org.matrix.msc4222.state_after': { events: state },
    timeline: { events: [...timelineState, { type: 'm.room.message', content: {}, event_id: '$msg' }] },
  };
}

function savedSync(join: Record<string, object>) {
  return { nextBatch: 's123', roomsData: { join, invite: {}, leave: {}, knock: {} }, accountData: [] };
}

function makeKv(initial: Record<string, unknown>) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    kv: {
      get: async (key: string) => (data.has(key) ? data.get(key) : null),
      delete: async (key: string) => {
        data.delete(key);
      },
    },
  };
}

const META = { version: 1, nextBatch: 's123', filterIds: {}, nextToDeviceBatchID: 0 };

describe('repairIncompleteSyncSnapshot', () => {
  it('leaves a snapshot with complete room state untouched', async () => {
    const { kv, data } = makeKv({
      [`${SCOPE}:saved-sync`]: savedSync({ '!a:example.org': joinedRoom(FULL_STATE) }),
      [`${SCOPE}:meta`]: META,
    });

    const result = await repairIncompleteSyncSnapshot(kv, SCOPE);

    expect(result.repaired).toBe(false);
    expect(data.has(`${SCOPE}:saved-sync`)).toBe(true);
    expect(data.has(`${SCOPE}:meta`)).toBe(true);
  });

  it('accepts m.room.create delivered in the timeline instead of the state block', async () => {
    const { kv } = makeKv({
      [`${SCOPE}:saved-sync`]: savedSync({ '!a:example.org': joinedRoom(MEMBERS_ONLY, [stateEvent('m.room.create')]) }),
      [`${SCOPE}:meta`]: META,
    });

    expect((await repairIncompleteSyncSnapshot(kv, SCOPE)).repaired).toBe(false);
  });

  it('discards the snapshot, sync token and cached member lists when a joined room lacks m.room.create', async () => {
    const oobKey = `${SCOPE}:oob-members:${encodeURIComponent('!dm:example.org')}`;
    const { kv, data } = makeKv({
      [`${SCOPE}:saved-sync`]: savedSync({
        '!fine:example.org': joinedRoom(FULL_STATE),
        '!dm:example.org': joinedRoom(MEMBERS_ONLY),
      }),
      [`${SCOPE}:meta`]: META,
      [`${SCOPE}:room-index:oob-members`]: { roomIDs: ['!dm:example.org'] },
      [oobKey]: [],
      [`${SCOPE}:to-device`]: { batches: [{ id: 1 }] },
      [`${SCOPE}:client-options`]: { lazyLoadMembers: true },
    });

    const result = await repairIncompleteSyncSnapshot(kv, SCOPE);

    expect(result).toEqual({ repaired: true, reason: 'incomplete-room-state', rooms: ['!dm:example.org'] });
    expect(data.has(`${SCOPE}:saved-sync`)).toBe(false);
    expect(data.has(`${SCOPE}:meta`)).toBe(false);
    expect(data.has(`${SCOPE}:room-index:oob-members`)).toBe(false);
    expect(data.has(oobKey)).toBe(false);
    // Pending outgoing to-device messages and client options are not sync
    // state — dropping them would lose data for nothing.
    expect(data.has(`${SCOPE}:to-device`)).toBe(true);
    expect(data.has(`${SCOPE}:client-options`)).toBe(true);
  });

  it('drops an orphaned sync token whose snapshot is gone (the likely origin of the incomplete state)', async () => {
    // getSavedSyncToken() falls back to meta.nextBatch, so the client would
    // resume INCREMENTALLY with an empty accumulator — every room it then
    // learns about carries only the state that changed afterwards.
    const { kv, data } = makeKv({ [`${SCOPE}:meta`]: META });

    const result = await repairIncompleteSyncSnapshot(kv, SCOPE);

    expect(result).toEqual({ repaired: true, reason: 'orphaned-sync-token' });
    expect(data.has(`${SCOPE}:meta`)).toBe(false);
  });

  it('discards a snapshot that knows no joined rooms at all while carrying a sync token', async () => {
    // Observed on the live-test identity: {"join":{}} plus a nextBatch. Resuming
    // from that token, the client only ever learns about rooms whose state
    // changes afterwards — each with just the changed state. A fresh initial
    // sync is cheap for an account that really has no rooms.
    const { kv, data } = makeKv({ [`${SCOPE}:saved-sync`]: savedSync({}), [`${SCOPE}:meta`]: META });

    expect(await repairIncompleteSyncSnapshot(kv, SCOPE)).toEqual({ repaired: true, reason: 'no-joined-rooms' });
    expect(data.has(`${SCOPE}:saved-sync`)).toBe(false);
    expect(data.has(`${SCOPE}:meta`)).toBe(false);
  });

  it('discards the snapshot when the server lists a joined room the snapshot does not know', async () => {
    // The 13:35 plaintext send: a room missing from the snapshot never gets a
    // Room object after an incremental resume, and js-sdk sends into an
    // unknown room without encrypting.
    const { kv, data } = makeKv({
      [`${SCOPE}:saved-sync`]: savedSync({ '!known:example.org': joinedRoom(FULL_STATE) }),
      [`${SCOPE}:meta`]: META,
    });

    const result = await repairIncompleteSyncSnapshot(kv, SCOPE, {
      listJoinedRooms: async () => ['!known:example.org', '!dm:example.org'],
    });

    expect(result).toEqual({ repaired: true, reason: 'missing-joined-rooms', rooms: ['!dm:example.org'] });
    expect(data.has(`${SCOPE}:saved-sync`)).toBe(false);
  });

  it('keeps a complete snapshot that matches the server room list', async () => {
    const { kv } = makeKv({
      [`${SCOPE}:saved-sync`]: savedSync({ '!known:example.org': joinedRoom(FULL_STATE) }),
      [`${SCOPE}:meta`]: META,
    });
    const result = await repairIncompleteSyncSnapshot(kv, SCOPE, {
      listJoinedRooms: async () => ['!known:example.org'],
    });
    expect(result.repaired).toBe(false);
  });

  it('falls back to the local checks when the server room list is unavailable', async () => {
    const { kv } = makeKv({
      [`${SCOPE}:saved-sync`]: savedSync({ '!known:example.org': joinedRoom(FULL_STATE) }),
      [`${SCOPE}:meta`]: META,
    });
    const result = await repairIncompleteSyncSnapshot(kv, SCOPE, {
      listJoinedRooms: async () => {
        throw new Error('network down');
      },
    });
    expect(result.repaired).toBe(false);
  });

  it('ignores rooms we are not joined to', async () => {
    const snapshot = savedSync({ '!a:example.org': joinedRoom(FULL_STATE) });
    (snapshot.roomsData as Record<string, object>).leave = { '!old:example.org': joinedRoom(MEMBERS_ONLY) };
    const { kv } = makeKv({ [`${SCOPE}:saved-sync`]: snapshot, [`${SCOPE}:meta`]: META });

    expect((await repairIncompleteSyncSnapshot(kv, SCOPE)).repaired).toBe(false);
  });

  it('does nothing on a fresh install (no snapshot, no token)', async () => {
    const { kv } = makeKv({});
    expect((await repairIncompleteSyncSnapshot(kv, SCOPE)).repaired).toBe(false);
  });

  it('never throws, even when the state adapter does', async () => {
    const kv = {
      get: async () => {
        throw new Error('db gone');
      },
      delete: async () => {
        throw new Error('db gone');
      },
    };
    await expect(repairIncompleteSyncSnapshot(kv, SCOPE)).resolves.toEqual({ repaired: false });
  });

  it('treats a malformed snapshot like a missing one — the adapter ignores it and would resume from the token', async () => {
    const { kv, data } = makeKv({ [`${SCOPE}:saved-sync`]: 'garbage', [`${SCOPE}:meta`]: META });
    expect(await repairIncompleteSyncSnapshot(kv, SCOPE)).toEqual({ repaired: true, reason: 'orphaned-sync-token' });
    expect(data.has(`${SCOPE}:meta`)).toBe(false);
  });
});

describe('wrapWithSyncStoreRepair', () => {
  function makeAdapter(kv: ReturnType<typeof makeKv>['kv'] | undefined) {
    const order: string[] = [];
    const adapter = {
      stateAdapter: kv,
      resolveMatrixStoreContext: (auth?: { userID: string; deviceID: string }) =>
        auth ? { userID: auth.userID, deviceID: auth.deviceID, scopeKey: SCOPE } : null,
      maybeCreateMatrixStore: async function (this: { stateAdapter: unknown }, _auth?: unknown) {
        order.push('createStore');
        return { store: true, sawState: this.stateAdapter };
      },
    };
    return { adapter, order };
  }

  it("repairs the snapshot in the adapter's own state scope before the store is created", async () => {
    const { kv, data } = makeKv({ [`${SCOPE}:meta`]: META });
    const { adapter, order } = makeAdapter(kv);
    const origDelete = kv.delete;
    kv.delete = async (key: string) => {
      order.push(`delete ${key.slice(SCOPE.length + 1)}`);
      return origDelete(key);
    };

    wrapWithSyncStoreRepair(adapter);
    const store = await adapter.maybeCreateMatrixStore({ userID: '@bot:example.org', deviceID: 'DEVICE' });

    expect(data.has(`${SCOPE}:meta`)).toBe(false);
    expect(order.indexOf('delete meta')).toBeLessThan(order.indexOf('createStore'));
    expect(store).toEqual({ store: true, sawState: kv });
  });

  it("checks the snapshot against the server room list using the adapter's own credentials", async () => {
    const { kv, data } = makeKv({
      [`${SCOPE}:saved-sync`]: savedSync({ '!known:example.org': joinedRoom(FULL_STATE) }),
      [`${SCOPE}:meta`]: META,
    });
    const { adapter } = makeAdapter(kv);
    (adapter as Record<string, unknown>).baseURL = 'https://hs.example.org/';
    const fetchMock = vi.fn(async (_url: string, _init?: { headers?: Record<string, string> }) => ({
      ok: true,
      json: async () => ({ joined_rooms: ['!known:example.org', '!missing:example.org'] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      wrapWithSyncStoreRepair(adapter);
      await adapter.maybeCreateMatrixStore({
        userID: '@bot:example.org',
        deviceID: 'DEVICE',
        accessToken: 'tok',
      } as { userID: string; deviceID: string });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetchMock).toHaveBeenCalledWith(
      'https://hs.example.org/_matrix/client/v3/joined_rooms',
      expect.objectContaining({ headers: { Authorization: 'Bearer tok' } }),
    );
    expect(data.has(`${SCOPE}:saved-sync`)).toBe(false);
  });

  it('passes straight through when there is no state adapter or no scope', async () => {
    const { adapter, order } = makeAdapter(undefined);
    wrapWithSyncStoreRepair(adapter);
    await adapter.maybeCreateMatrixStore();
    expect(order).toEqual(['createStore']);
  });

  it('is a no-op on an adapter without the private store hook (SDK shape changed)', () => {
    const adapter = {};
    expect(() => wrapWithSyncStoreRepair(adapter)).not.toThrow();
  });
});
