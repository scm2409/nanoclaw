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
  function makeSendAdapter(rooms: FakeRoom[], registeredRooms: string[] = []) {
    const onCryptoEvent = vi.fn().mockResolvedValue(undefined);
    const roomEncryptors: Record<string, object> = {};
    for (const id of registeredRooms) roomEncryptors[id] = {};

    const client = {
      getRoom: (roomId: string) => {
        const r = rooms.find((x) => x.roomId === roomId);
        if (!r) return null;
        return {
          roomId: r.roomId,
          currentState: {
            getStateEvents: (type: string, stateKey: string) =>
              type === 'm.room.encryption' && stateKey === '' && r.encrypted ? { getContent: () => ({}) } : null,
          },
        };
      },
      getCrypto: () => ({ onCryptoEvent, roomEncryptors }),
    };
    return { adapter: { client } as unknown as Adapter, onCryptoEvent };
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
});
