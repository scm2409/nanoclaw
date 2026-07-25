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

    // Simulate the inbound message that warms the cache. This mirrors
    // production ordering: chat-sdk-bridge.ts's warmInboundSenderCache runs
    // the __onInboundSender hook FIRST, then calls channelIdFromThreadId.
    // The hook is the only thing that may establish user -> room; see the
    // comment on channelIdFromThreadId for why.
    (wrapped as unknown as { __onInboundSender: (t: string, s: string) => void }).__onInboundSender(
      '!known:example.org',
      '@user1:example.org',
    );
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

    (wrapped as unknown as { __onInboundSender: (t: string, s: string) => void }).__onInboundSender(
      '!left:example.org',
      '@user2:example.org',
    );
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

  it('a confirmed inbound room overrides a room openDM had previously cached', async () => {
    // The 2026-07-25 incident, exactly: after a restart the host sent first
    // with a cold cache, so resolveThreadId fell through to openDM, which
    // picked a WRONG room (a stale/newly-created one) and cached it. The
    // operator then wrote from their real room. Every reply still went to
    // openDM's room, so the operator saw a typing indicator and silence
    // while the agent's answers landed somewhere they never looked.
    //
    // Confirmed-inbound traffic is strictly better evidence than openDM's
    // guess, so it must win — even when it arrives second.
    const { adapter, openDM, postMessage } = makeFakeAdapter(
      BOT_ID,
      {
        '!wrong-room:example.org': {
          id: '!wrong-room:example.org',
          joinedCount: 2,
          membership: 'join',
          otherMember: '@user5:example.org',
        },
        '!real-room:example.org': {
          id: '!real-room:example.org',
          joinedCount: 2,
          membership: 'join',
          otherMember: '@user5:example.org',
        },
      },
      '!wrong-room:example.org',
    );
    const wrapped = wrapWithDmResolution(adapter);

    // 1. Cold cache: host sends first, openDM answers with the wrong room.
    await wrapped.postMessage('matrix:@user5:example.org', { markdown: 'first' });
    expect(openDM).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenLastCalledWith('!wrong-room:example.org', { markdown: 'first' });

    // 2. The user's real message arrives from their actual room.
    (wrapped as unknown as { __onInboundSender: (t: string, s: string) => void }).__onInboundSender(
      '!real-room:example.org',
      '@user5:example.org',
    );

    // 3. The reply must now go to the real room, not openDM's stale guess.
    await wrapped.postMessage('matrix:@user5:example.org', { markdown: 'reply' });
    expect(postMessage).toHaveBeenLastCalledWith('!real-room:example.org', { markdown: 'reply' });
    expect(openDM).toHaveBeenCalledTimes(1); // still only the cold-cache call
  });

  it('a later event in an OLD room must not revert the user to that room', async () => {
    // Root cause of the 2026-07-25 "typing then silence" incident, caught in
    // the host's own debug trace:
    //   14:48:02.800  __onInboundSender  roomID=!new    (cache -> !new)
    //   14:48:02.809  cache lookup       knownRoomId=!new
    //   14:48:06.225  cache lookup       knownRoomId=!old   <- reverted
    //                 sendEvent in !old
    //
    // channelIdFromThreadId wrote userToRoomCache on every event it resolved,
    // including events in rooms the user had moved on from (and the bot's own
    // echoes). So a single stray event in the abandoned room silently
    // redirected every subsequent reply back into it.
    //
    // Mapping a room to its DM partner (roomToUserCache) is safe from any
    // event. Deciding WHICH room a user is currently reachable in is not —
    // that may only come from a confirmed inbound message from that user.
    const { adapter, postMessage } = makeFakeAdapter(
      BOT_ID,
      {
        '!old:example.org': {
          id: '!old:example.org',
          joinedCount: 2,
          membership: 'join',
          otherMember: '@user6:example.org',
        },
        '!new:example.org': {
          id: '!new:example.org',
          joinedCount: 2,
          membership: 'join',
          otherMember: '@user6:example.org',
        },
      },
      '!unused:example.org',
    );
    const wrapped = wrapWithDmResolution(adapter);
    const hook = (wrapped as unknown as { __onInboundSender: (t: string, s: string) => void }).__onInboundSender;

    // The user talks in the old room, then moves to the new one.
    hook('!old:example.org', '@user6:example.org');
    hook('!new:example.org', '@user6:example.org');

    // A stray event resolves against the OLD room — an echo of the bot's own
    // earlier message, or back-filled history during a sync.
    expect(wrapped.channelIdFromThreadId('!old:example.org')).toBe('matrix:@user6:example.org');

    // The next reply must still go to the room the user actually wrote from.
    await wrapped.postMessage('matrix:@user6:example.org', { markdown: 'reply' });
    expect(postMessage).toHaveBeenLastCalledWith('!new:example.org', { markdown: 'reply' });
  });

  it('a slow openDM must not clobber a room confirmed while it was in flight', async () => {
    // The actual root cause of the 2026-07-25 outage, from the host's trace:
    //   15:12:21.109  cacheSize=0                  -> openDM starts (slow)
    //   15:12:45.410  __onInboundSender roomID=!new  (cache -> !new)
    //   15:12:45.420  lookup            !new         correct
    //   15:12:48.598  lookup            !stale        <- openDM landed
    //                 sendEvent in !stale
    //
    // openDM can take tens of seconds (it may create and invite into a room).
    // Its result was written to the cache unconditionally *after* the await,
    // so a confirmed inbound that arrived meanwhile was silently overwritten
    // — and every later reply went to the room openDM had invented.
    //
    // Confirmed inbound traffic outranks openDM's guess, whenever it arrives.
    let releaseOpenDM: (() => void) | undefined;
    const openDMGate = new Promise<void>((r) => {
      releaseOpenDM = r;
    });

    const { adapter, postMessage } = makeFakeAdapter(
      BOT_ID,
      {
        '!stale:example.org': {
          id: '!stale:example.org',
          joinedCount: 2,
          membership: 'join',
          otherMember: '@user7:example.org',
        },
        '!new:example.org': {
          id: '!new:example.org',
          joinedCount: 2,
          membership: 'join',
          otherMember: '@user7:example.org',
        },
      },
      '!stale:example.org',
    );
    // Make openDM hang until we release it, so the inbound lands mid-flight.
    (adapter as unknown as { openDM: (h: string) => Promise<string> }).openDM = async () => {
      await openDMGate;
      return '!stale:example.org';
    };

    const wrapped = wrapWithDmResolution(adapter);
    const hook = (wrapped as unknown as { __onInboundSender: (t: string, s: string) => void }).__onInboundSender;

    // Cold cache: this send falls through to the (slow) openDM.
    const inFlight = wrapped.postMessage('matrix:@user7:example.org', { markdown: 'first' });

    // The user writes from their real room while openDM is still pending.
    hook('!new:example.org', '@user7:example.org');

    releaseOpenDM!();
    await inFlight;

    // Even the in-flight send should land in the confirmed room, not the
    // room openDM resolved to after the fact.
    expect(postMessage).toHaveBeenLastCalledWith('!new:example.org', { markdown: 'first' });

    // And the cache must not have been reverted for subsequent sends.
    await wrapped.postMessage('matrix:@user7:example.org', { markdown: 'second' });
    expect(postMessage).toHaveBeenLastCalledWith('!new:example.org', { markdown: 'second' });
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

    (wrapped as unknown as { __onInboundSender: (t: string, s: string) => void }).__onInboundSender(
      '!known2:example.org',
      '@user3:example.org',
    );
    await wrapped.startTyping('matrix:@user3:example.org');

    expect(openDM).not.toHaveBeenCalled();
  });
});
