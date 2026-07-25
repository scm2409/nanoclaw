/**
 * Regression test for the DM-room-resolution incident: openDM()
 * (@beeper/chat-adapter-matrix@0.2.0) can silently create a brand-new,
 * unencrypted room and invite the user into it when its own persisted-cache
 * and m.direct-account-data lookups both come up empty for a room that is
 * completely real and currently in use (observed right after a host
 * restart, before the client's local room list had fully caught up).
 *
 * wrapWithDmResolution's fix: userToRoomCache, populated only from confirmed
 * inbound traffic, is checked before ever calling the underlying openDM() —
 * a user we've demonstrably already exchanged messages with never risks the
 * buggy fallback.
 */
import { describe, it, expect, vi } from 'vitest';

import { wrapWithDmResolution } from './matrix.js';
import type { createMatrixAdapter } from '@beeper/chat-adapter-matrix';

type FakeRoom = { id: string; joinedCount: number; membership: string; otherMember: string };

function makeFakeAdapter(botId: string, rooms: Record<string, FakeRoom>, openDMResult: string) {
  const openDM = vi.fn(async (_userHandle: string) => openDMResult);
  const postMessage = vi.fn(async (_threadId: string, ..._args: unknown[]) => ({ id: 'sent' }));
  const startTyping = vi.fn(async (_threadId: string) => undefined);

  const client = {
    getRoom: (roomID: string) => {
      const room = rooms[roomID];
      if (!room) return undefined;
      return {
        getJoinedMemberCount: () => room.joinedCount,
        getJoinedMembers: () => [{ userId: botId }, { userId: room.otherMember }],
        getMyMembership: () => room.membership,
      };
    },
  };

  const adapter = {
    name: 'matrix',
    userID: botId,
    client,
    decodeThreadId: (threadId: string) => ({ roomID: threadId }),
    encodeThreadId: ({ roomID }: { roomID: string }) => roomID,
    channelIdFromThreadId: (threadId: string) => threadId, // "original" passthrough, pre-wrap
    openDM,
    postMessage,
    startTyping,
  };

  return { adapter: adapter as unknown as ReturnType<typeof createMatrixAdapter>, openDM, postMessage };
}

const BOT_ID = '@bot:example.org';

describe('wrapWithDmResolution — DM room resolution', () => {
  it('reuses a room confirmed via inbound traffic instead of calling openDM', async () => {
    const { adapter, openDM, postMessage } = makeFakeAdapter(
      BOT_ID,
      {
        '!known:example.org': {
          id: '!known:example.org',
          joinedCount: 2,
          membership: 'join',
          otherMember: '@user1:example.org',
        },
      },
      '!should-not-be-used:example.org',
    );
    const wrapped = wrapWithDmResolution(adapter);

    // Simulate the inbound message that warms the cache (chat-sdk-bridge.ts
    // calls this synchronously before dispatching onInbound).
    const channelId = wrapped.channelIdFromThreadId('!known:example.org');
    expect(channelId).toBe('matrix:@user1:example.org');

    // Now the bot replies — must reuse the known room, never touch openDM.
    await wrapped.postMessage('matrix:@user1:example.org', { markdown: 'hi' });

    expect(openDM).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith('!known:example.org', { markdown: 'hi' });
  });

  it('falls back to openDM for a user with no confirmed inbound room', async () => {
    const { adapter, openDM } = makeFakeAdapter(BOT_ID, {}, '!brand-new:example.org');
    const wrapped = wrapWithDmResolution(adapter);

    await wrapped.postMessage('matrix:@stranger:example.org', { markdown: 'hi' });

    expect(openDM).toHaveBeenCalledWith('@stranger:example.org');
  });

  it('falls back to openDM when the cached room is no longer joined (stale)', async () => {
    const { adapter, openDM } = makeFakeAdapter(
      BOT_ID,
      {
        '!left:example.org': {
          id: '!left:example.org',
          joinedCount: 2,
          membership: 'leave',
          otherMember: '@user2:example.org',
        },
      },
      '!recreated:example.org',
    );
    const wrapped = wrapWithDmResolution(adapter);

    wrapped.channelIdFromThreadId('!left:example.org');
    await wrapped.postMessage('matrix:@user2:example.org', { markdown: 'hi' });

    expect(openDM).toHaveBeenCalledWith('@user2:example.org');
  });

  it('warms the cache from the raw sender field even when room-membership enumeration would fail (lazyLoadMembers gap)', async () => {
    // Simulates the actual incident: right after a fresh login/sync, the
    // client's local room-member state can be incomplete (lazyLoadMembers:
    // true) — getJoinedMembers() here returns only the bot, so
    // channelIdFromThreadId's own membership-based detection can't find
    // "the other member" and falls through without caching anything.
    const { adapter, openDM, postMessage } = makeFakeAdapter(
      BOT_ID,
      { '!lazy:example.org': { id: '!lazy:example.org', joinedCount: 2, membership: 'join', otherMember: '' } },
      '!should-not-be-used:example.org',
    );
    (adapter as any).client.getRoom = (roomID: string) =>
      roomID === '!lazy:example.org'
        ? { getJoinedMemberCount: () => 2, getJoinedMembers: () => [{ userId: BOT_ID }], getMyMembership: () => 'join' }
        : undefined;
    const wrapped = wrapWithDmResolution(adapter);

    // Membership-based path fails to cache anything (no "other member" found).
    const channelId = wrapped.channelIdFromThreadId('!lazy:example.org');
    expect(channelId).toBe('!lazy:example.org'); // falls through to the passthrough original

    // The sender-field hook (wired to chat-sdk-bridge.ts's onInboundSender)
    // still reliably caches the mapping, straight from the event's sender.
    (wrapped as unknown as { __onInboundSender: (t: string, s: string) => void }).__onInboundSender(
      '!lazy:example.org',
      '@user4:example.org',
    );

    await wrapped.postMessage('matrix:@user4:example.org', { markdown: 'hi' });

    expect(openDM).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith('!lazy:example.org', { markdown: 'hi' });
  });

  it('startTyping also uses the confirmed-inbound room, bypassing openDM', async () => {
    const { adapter, openDM } = makeFakeAdapter(
      BOT_ID,
      {
        '!known2:example.org': {
          id: '!known2:example.org',
          joinedCount: 2,
          membership: 'join',
          otherMember: '@user3:example.org',
        },
      },
      '!should-not-be-used:example.org',
    );
    const wrapped = wrapWithDmResolution(adapter);

    wrapped.channelIdFromThreadId('!known2:example.org');
    await wrapped.startTyping('matrix:@user3:example.org');

    expect(openDM).not.toHaveBeenCalled();
  });
});
