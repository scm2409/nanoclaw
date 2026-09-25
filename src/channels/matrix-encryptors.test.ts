/**
 * Tests for ensureRoomEncryptors — the startup backfill that registers a
 * crypto encryptor for every joined encrypted room.
 *
 * Regression context: matrix-js-sdk only registers a room's encryptor when
 * `m.room.encryption` arrives inside a sync response. After a restart that
 * restores a persisted sync snapshot, the sync is incremental and that event
 * never re-arrives — so sends into long-established rooms failed with
 * "Cannot encrypt event in unconfigured room". See matrix.ts for the full
 * incident writeup.
 */
import { describe, it, expect, vi } from 'vitest';

import { ensureRoomEncryptors, ensureEncryptorForRoom } from './matrix.js';
import type { createMatrixAdapter } from '@beeper/chat-adapter-matrix';

type Adapter = ReturnType<typeof createMatrixAdapter>;

interface FakeRoom {
  roomId: string;
  membership: string;
  encrypted: boolean;
}

function makeAdapter(rooms: FakeRoom[], opts: { noCrypto?: boolean } = {}) {
  const onCryptoEvent = vi.fn().mockResolvedValue(undefined);

  const client = {
    getRooms: () =>
      rooms.map((r) => ({
        roomId: r.roomId,
        getMyMembership: () => r.membership,
        currentState: {
          getStateEvents: (type: string, stateKey: string) =>
            type === 'm.room.encryption' && stateKey === '' && r.encrypted
              ? { getContent: () => ({ algorithm: 'm.megolm.v1.aes-sha2' }) }
              : null,
        },
      })),
    getCrypto: () => (opts.noCrypto ? undefined : { onCryptoEvent }),
  };

  return { adapter: { client } as unknown as Adapter, onCryptoEvent };
}

describe('ensureRoomEncryptors', () => {
  it('registers an encryptor for every joined encrypted room', async () => {
    const { adapter, onCryptoEvent } = makeAdapter([
      { roomId: '!a:server', membership: 'join', encrypted: true },
      { roomId: '!b:server', membership: 'join', encrypted: true },
    ]);

    await ensureRoomEncryptors(adapter);

    expect(onCryptoEvent).toHaveBeenCalledTimes(2);
    const roomIds = onCryptoEvent.mock.calls.map((c) => c[0].roomId).sort();
    expect(roomIds).toEqual(['!a:server', '!b:server']);
  });

  it('skips unencrypted rooms and rooms we are not joined to', async () => {
    const { adapter, onCryptoEvent } = makeAdapter([
      { roomId: '!joined-encrypted:server', membership: 'join', encrypted: true },
      { roomId: '!joined-plain:server', membership: 'join', encrypted: false },
      { roomId: '!left:server', membership: 'leave', encrypted: true },
      { roomId: '!invited:server', membership: 'invite', encrypted: true },
    ]);

    await ensureRoomEncryptors(adapter);

    expect(onCryptoEvent).toHaveBeenCalledTimes(1);
    expect(onCryptoEvent.mock.calls[0][0].roomId).toBe('!joined-encrypted:server');
  });

  it('never throws when the crypto backend is unavailable', async () => {
    const { adapter, onCryptoEvent } = makeAdapter([{ roomId: '!a:server', membership: 'join', encrypted: true }], {
      noCrypto: true,
    });

    await expect(ensureRoomEncryptors(adapter)).resolves.toBeUndefined();
    expect(onCryptoEvent).not.toHaveBeenCalled();
  });

  it('keeps going when one room fails to register', async () => {
    const { adapter, onCryptoEvent } = makeAdapter([
      { roomId: '!bad:server', membership: 'join', encrypted: true },
      { roomId: '!good:server', membership: 'join', encrypted: true },
    ]);
    onCryptoEvent.mockImplementation((room: { roomId: string }) => {
      if (room.roomId === '!bad:server') return Promise.reject(new Error('boom'));
      return Promise.resolve(undefined);
    });

    await expect(ensureRoomEncryptors(adapter)).resolves.toBeUndefined();
    // Both attempted — one failure must not abort the backfill.
    expect(onCryptoEvent).toHaveBeenCalledTimes(2);
  });

  it('never throws when the adapter has no client at all', async () => {
    await expect(ensureRoomEncryptors({} as Adapter)).resolves.toBeUndefined();
  });
});

describe('ensureEncryptorForRoom', () => {
  /** Adapter whose crypto backend already knows about `registeredRooms`. */
  function makeSendAdapter(rooms: (FakeRoom & { stateHydrated?: boolean })[], registeredRooms: string[] = []) {
    const onCryptoEvent = vi.fn().mockResolvedValue(undefined);
    const roomEncryptors: Record<string, object> = {};
    for (const id of registeredRooms) roomEncryptors[id] = {};

    // Live homeserver fetch — the fallback when currentState hasn't
    // hydrated the state event locally yet. Always authoritative: a room
    // that isn't really encrypted 404s, same as the real API.
    const getStateEvent = vi.fn(async (roomId: string, type: string, stateKey: string) => {
      const r = rooms.find((x) => x.roomId === roomId);
      if (type === 'm.room.encryption' && stateKey === '' && r?.encrypted) {
        return { algorithm: 'm.megolm.v1.aes-sha2' };
      }
      throw new Error('M_NOT_FOUND: Event not found.');
    });

    const client = {
      getRoom: (roomId: string) => {
        const r = rooms.find((x) => x.roomId === roomId);
        if (!r) return null;
        const hasLocal = () => r.encrypted && r.stateHydrated !== false;
        return {
          roomId: r.roomId,
          currentState: {
            getStateEvents: (type: string, stateKey: string) =>
              type === 'm.room.encryption' && stateKey === '' && hasLocal() ? { getContent: () => ({}) } : null,
            // Taking the injected event is what "hydrates" the fake room.
            setStateEvents: () => {
              r.stateHydrated = true;
            },
          },
          hasEncryptionStateEvent: hasLocal,
          clearLoadedMembersIfNeeded: async () => undefined,
          loadMembersIfNeeded: async () => true,
        };
      },
      getCrypto: () => ({ onCryptoEvent, roomEncryptors }),
      getStateEvent,
    };
    return { adapter: { client } as unknown as Adapter, onCryptoEvent, getStateEvent };
  }

  it('registers the encryptor for a known encrypted room that has none', async () => {
    const { adapter, onCryptoEvent } = makeSendAdapter([{ roomId: '!a:server', membership: 'join', encrypted: true }]);
    await ensureEncryptorForRoom(adapter, '!a:server');
    expect(onCryptoEvent).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the room already has an encryptor', async () => {
    const { adapter, onCryptoEvent } = makeSendAdapter(
      [{ roomId: '!a:server', membership: 'join', encrypted: true }],
      ['!a:server'],
    );
    await ensureEncryptorForRoom(adapter, '!a:server');
    expect(onCryptoEvent).not.toHaveBeenCalled();
  });

  it('does nothing for an unencrypted or unknown room', async () => {
    const { adapter, onCryptoEvent } = makeSendAdapter([
      { roomId: '!plain:server', membership: 'join', encrypted: false },
    ]);
    await ensureEncryptorForRoom(adapter, '!plain:server');
    await ensureEncryptorForRoom(adapter, '!nonexistent:server');
    expect(onCryptoEvent).not.toHaveBeenCalled();
  });

  it('never throws when crypto is unavailable', async () => {
    await expect(ensureEncryptorForRoom({} as Adapter, '!a:server')).resolves.toBeUndefined();
  });

  it('falls back to a live server fetch when local state has not hydrated yet (2026-07-26 incident)', async () => {
    // Observed live: a room the client had already decrypted an INBOUND
    // message from (proving it's genuinely encrypted and joined) still had
    // no m.room.encryption event in currentState — timeline processing and
    // state application are separate pipelines. The free local check came
    // up empty, so this used to give up silently, and the next send failed
    // with "Cannot encrypt event in unconfigured room" — which then tripped
    // postMessage's send-failure self-heal into abandoning the room
    // entirely for a fresh, unencrypted one via openDM().
    const { adapter, onCryptoEvent, getStateEvent } = makeSendAdapter([
      { roomId: '!not-yet-hydrated:server', membership: 'join', encrypted: true, stateHydrated: false },
    ]);

    await ensureEncryptorForRoom(adapter, '!not-yet-hydrated:server');

    expect(getStateEvent).toHaveBeenCalledWith('!not-yet-hydrated:server', 'm.room.encryption', '');
    expect(onCryptoEvent).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a genuinely unencrypted room even after checking the server', async () => {
    const { adapter, onCryptoEvent, getStateEvent } = makeSendAdapter([
      { roomId: '!plain-unhydrated:server', membership: 'join', encrypted: false, stateHydrated: false },
    ]);

    await ensureEncryptorForRoom(adapter, '!plain-unhydrated:server');

    expect(getStateEvent).toHaveBeenCalledWith('!plain-unhydrated:server', 'm.room.encryption', '');
    expect(onCryptoEvent).not.toHaveBeenCalled();
  });
});

describe('ensureEncryptorForRoom — incomplete restored room state (2026-09-25 incident)', () => {
  // Observed live after a restart: the persisted sync snapshot held only the
  // two m.room.member events for the operator's DM — no m.room.create, no
  // m.room.encryption. Two failures followed:
  //   - one send went out as PLAINTEXT m.room.message into the encrypted
  //     room (js-sdk decides "encrypt?" from the room's local state + olm
  //     room settings, and neither knew the room was encrypted);
  //   - the next send was encrypted, but the megolm key was shared only with
  //     the bot's own devices ("Encrypting for users: [@bot]") — the
  //     room trusted a cached, empty lazy-loaded member list, because
  //     js-sdk only force-fetches members from the server for rooms whose
  //     local state carries m.room.encryption. The operator's Element X
  //     could not decrypt until they wrote first.
  interface RepairRoomOpts {
    localEncryptionEvent: boolean;
    serverEncrypted: boolean;
    registered?: boolean;
    injectionSticks?: boolean;
    loaded?: boolean;
    serverError?: Error;
  }

  function makeRepairAdapter(opts: RepairRoomOpts) {
    const calls: string[] = [];
    const roomId = '!dm:server';
    let hasLocal = opts.localEncryptionEvent;
    const onCryptoEvent = vi.fn(async () => {
      calls.push('onCryptoEvent');
    });
    const roomEncryptors: Record<string, object> = opts.registered ? { [roomId]: {} } : {};
    const setStateEvents = vi.fn((events: { getType: () => string }[]) => {
      calls.push('setStateEvents');
      if (events.some((e) => e.getType() === 'm.room.encryption') && opts.injectionSticks !== false) hasLocal = true;
    });
    const clearLoadedMembersIfNeeded = vi.fn(async () => {
      calls.push('clearLoadedMembers');
    });
    const loadMembersIfNeeded = vi.fn(async () => {
      calls.push(hasLocal ? 'loadMembers(encrypted)' : 'loadMembers(plain)');
      return true;
    });
    const getStateEvent = vi.fn(async () => {
      calls.push('getStateEvent');
      if (opts.serverError) throw opts.serverError;
      if (opts.serverEncrypted) return { algorithm: 'm.megolm.v1.aes-sha2' };
      throw Object.assign(new Error('M_NOT_FOUND: Event not found.'), { errcode: 'M_NOT_FOUND', httpStatus: 404 });
    });
    const room = {
      roomId,
      currentState: {
        getStateEvents: (type: string, stateKey: string) =>
          type === 'm.room.encryption' && stateKey === '' && hasLocal
            ? { getContent: () => ({ algorithm: 'm.megolm.v1.aes-sha2' }) }
            : null,
        setStateEvents,
      },
      hasEncryptionStateEvent: () => hasLocal,
      clearLoadedMembersIfNeeded,
      loadMembersIfNeeded,
    };
    const client = {
      getRoom: (id: string) => (id === roomId && opts.loaded !== false ? room : null),
      getCrypto: () => ({ onCryptoEvent, roomEncryptors }),
      getStateEvent,
      getUserId: () => '@bot:server',
      getEventMapper: () => (raw: { type: string; state_key: string; content: unknown }) => ({
        getType: () => raw.type,
        getStateKey: () => raw.state_key,
        getContent: () => raw.content,
      }),
    };
    return {
      adapter: { client } as unknown as Adapter,
      roomId,
      calls,
      setStateEvents,
      getStateEvent,
      onCryptoEvent,
      loadMembersIfNeeded,
    };
  }

  it('injects the server-side encryption event into local room state', async () => {
    const t = makeRepairAdapter({ localEncryptionEvent: false, serverEncrypted: true });

    await ensureEncryptorForRoom(t.adapter, t.roomId);

    expect(t.setStateEvents).toHaveBeenCalledTimes(1);
    const injected = t.setStateEvents.mock.calls[0][0][0] as { getType(): string; getStateKey(): string };
    expect(injected.getType()).toBe('m.room.encryption');
    expect(injected.getStateKey()).toBe('');
    expect(t.onCryptoEvent).toHaveBeenCalledTimes(1);
  });

  it('reloads the member list from the server AFTER the room is known to be encrypted', async () => {
    const t = makeRepairAdapter({ localEncryptionEvent: false, serverEncrypted: true });

    await ensureEncryptorForRoom(t.adapter, t.roomId);

    // A load before the injection would reuse the cached (possibly empty)
    // member list — exactly the key-shared-only-with-ourselves failure.
    expect(t.calls).toContain('clearLoadedMembers');
    expect(t.calls).toContain('loadMembers(encrypted)');
    expect(t.calls).not.toContain('loadMembers(plain)');
    expect(t.calls.indexOf('setStateEvents')).toBeLessThan(t.calls.indexOf('clearLoadedMembers'));
  });

  it('repairs local state even when an encryptor is already registered (the plaintext send)', async () => {
    const t = makeRepairAdapter({ localEncryptionEvent: false, serverEncrypted: true, registered: true });

    await ensureEncryptorForRoom(t.adapter, t.roomId);

    expect(t.getStateEvent).toHaveBeenCalled();
    expect(t.setStateEvents).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the room is encrypted but local state cannot be repaired', async () => {
    const t = makeRepairAdapter({ localEncryptionEvent: false, serverEncrypted: true, injectionSticks: false });

    await expect(ensureEncryptorForRoom(t.adapter, t.roomId)).rejects.toThrow(/plaintext/i);
  });

  it('fails closed when the room is encrypted server-side but not loaded in the client', async () => {
    const t = makeRepairAdapter({ localEncryptionEvent: false, serverEncrypted: true, loaded: false });

    await expect(ensureEncryptorForRoom(t.adapter, t.roomId, { roomWaitMs: 20, pollMs: 5 })).rejects.toThrow(
      /plaintext/i,
    );
  });

  it('waits for a room the client has not loaded yet instead of refusing at once', async () => {
    // Live on matrix.org: a fresh initial sync right after a restart did not
    // yet include a room created minutes earlier; it arrived one sync later.
    // Refusing immediately would burn the host's three quick delivery
    // attempts and drop the reply.
    const t = makeRepairAdapter({ localEncryptionEvent: false, serverEncrypted: true, loaded: false });
    const client = (t.adapter as unknown as { client: { getRoom: (id: string) => unknown } }).client;
    const realGetRoom = client.getRoom;
    let lookups = 0;
    const loadedLater = makeRepairAdapter({ localEncryptionEvent: false, serverEncrypted: true });
    const laterRoom = (
      loadedLater.adapter as unknown as { client: { getRoom: (id: string) => unknown } }
    ).client.getRoom(t.roomId);
    client.getRoom = (id: string) => (++lookups >= 3 ? laterRoom : realGetRoom(id));

    await expect(
      ensureEncryptorForRoom(t.adapter, t.roomId, { roomWaitMs: 1_000, pollMs: 1 }),
    ).resolves.toBeUndefined();
    expect(loadedLater.setStateEvents).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the encryption state cannot be determined (non-404 server error)', async () => {
    const t = makeRepairAdapter({
      localEncryptionEvent: false,
      serverEncrypted: true,
      serverError: Object.assign(new Error('fetch failed'), { httpStatus: 502 }),
    });

    await expect(ensureEncryptorForRoom(t.adapter, t.roomId)).rejects.toThrow(/plaintext/i);
  });

  it('leaves a genuinely unencrypted room alone', async () => {
    const t = makeRepairAdapter({ localEncryptionEvent: false, serverEncrypted: false });

    await expect(ensureEncryptorForRoom(t.adapter, t.roomId)).resolves.toBeUndefined();
    expect(t.setStateEvents).not.toHaveBeenCalled();
    expect(t.onCryptoEvent).not.toHaveBeenCalled();
    expect(t.loadMembersIfNeeded).not.toHaveBeenCalled();
  });

  it('takes the free fast path when local state and encryptor are both present', async () => {
    const t = makeRepairAdapter({ localEncryptionEvent: true, serverEncrypted: true, registered: true });

    await ensureEncryptorForRoom(t.adapter, t.roomId);

    expect(t.calls).toEqual([]);
  });
});
