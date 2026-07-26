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
import fs from 'fs';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: '/tmp/nanoclaw-test-matrix-dm-resolution' }));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

import { wrapWithDmResolution } from './matrix.js';
import type { createMatrixAdapter } from '@beeper/chat-adapter-matrix';

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

type FakeRoom = {
  id: string;
  joinedCount: number;
  membership: string;
  otherMember: string;
  tombstoneReplacement?: string;
  /**
   * Whether the fake room has an actual m.room.member state event on record
   * for the bot's own user. Defaults to true (a real, confirmed membership —
   * matching how `membership` is normally used in these fixtures). Set to
   * false to simulate matrix-js-sdk's actual lazy-hydration gap: a timeline
   * event (message) has arrived and been processed, but the state event for
   * our own membership in this room hasn't been applied yet, so
   * getMyMembership() falls back to 'leave' with nothing real behind it.
   */
  hasOwnMembershipStateEvent?: boolean;
};

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
        currentState: {
          getStateEvents: (eventType: string, stateKey?: string) => {
            if (eventType === 'm.room.tombstone') {
              return room.tombstoneReplacement
                ? { getContent: () => ({ replacement_room: room.tombstoneReplacement }) }
                : null;
            }
            if (eventType === 'm.room.member' && stateKey === botId) {
              return room.hasOwnMembershipStateEvent === false
                ? null
                : { getContent: () => ({ membership: room.membership }) };
            }
            return null;
          },
        },
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
    // A real, state-backed 'leave' (the fixture's default) is still trusted
    // immediately — see the "reboot" test below for the opposite case, where
    // 'leave' has no backing state event and must NOT be trusted.
    await wrapped.postMessage('matrix:@user2:example.org', { markdown: 'hi' });

    expect(openDM).toHaveBeenCalledWith('@user2:example.org');
  });

  it('a leave/ban reading with no backing state event is distrusted, not the room (2026-07-26 reboot incident)', async () => {
    // Observed live, ~30 min after a host restart: an inbound message from
    // "!current" was correctly cached via __onInboundSender, but resolveThreadId's
    // own membership check read "!current" as leave/ban — matrix-js-sdk's
    // getMyMembership() is `this.selfMembership ?? KnownMembership.Leave`, and
    // selfMembership is only set once recalculate() finds a real m.room.member
    // state event for our own user id. The timeline event (message) had been
    // processed — hence the confirmed inbound — but that state event hadn't
    // been applied to this room yet: two separate pipelines. An OLDER,
    // unrelated (fully-hydrated) room happened to read 'join' and "won" the
    // single-slot-stale fallback, so every reply was silently routed into a
    // room the user had never seen — and that wrong room got persisted to
    // disk, poisoning every later resolution too.
    //
    // A 'leave'/'ban' reading with no actual state event behind it is not
    // evidence of departure — server delivery guarantees a room event can
    // only ever reach an account that's still joined.
    const { adapter, openDM, postMessage } = makeFakeAdapter(
      BOT_ID,
      {
        '!old-unrelated:example.org': {
          id: '!old-unrelated:example.org',
          joinedCount: 2,
          membership: 'join',
          otherMember: '@user13:example.org',
        },
        '!current:example.org': {
          id: '!current:example.org',
          joinedCount: 2,
          membership: 'leave',
          otherMember: '@user13:example.org',
          hasOwnMembershipStateEvent: false,
        },
      },
      '!should-not-be-used:example.org',
    );
    const wrapped = wrapWithDmResolution(adapter);
    const hook = (wrapped as unknown as { __onInboundSender: (t: string, s: string) => void }).__onInboundSender;

    // An older, unrelated room for the same user is already on record...
    hook('!old-unrelated:example.org', '@user13:example.org');
    // ...then the user's live message arrives from their current room.
    hook('!current:example.org', '@user13:example.org');

    // The reply must go to the room we JUST heard from, not the older one —
    // even though its own membership read says 'leave'.
    await wrapped.postMessage('matrix:@user13:example.org', { markdown: 'hi' });

    expect(openDM).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenLastCalledWith('!current:example.org', { markdown: 'hi' });
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

  it('falls back to a DIFFERENT confirmed room instead of openDM when the single-slot pointer goes stale', async () => {
    // The 2026-07-25-reboot incident: userToRoomCache is a single slot. When
    // its current room shows a confirmed departure (leave/ban), the old
    // behavior deleted the slot and fell straight to openDM — even though
    // roomToUserCache (room -> user, populated from every confirmed inbound
    // event and never pruned) still had ANOTHER room for this exact user
    // that is very much still joined. That other room is strictly better
    // evidence than inventing a new one via openDM.
    const { adapter, openDM, postMessage } = makeFakeAdapter(
      BOT_ID,
      {
        '!still-joined:example.org': {
          id: '!still-joined:example.org',
          joinedCount: 2,
          membership: 'join',
          otherMember: '@user8:example.org',
        },
        '!abandoned:example.org': {
          id: '!abandoned:example.org',
          joinedCount: 2,
          membership: 'leave',
          otherMember: '@user8:example.org',
        },
      },
      '!should-not-be-used:example.org',
    );
    const wrapped = wrapWithDmResolution(adapter);
    const hook = (wrapped as unknown as { __onInboundSender: (t: string, s: string) => void }).__onInboundSender;

    // Confirmed inbound from the still-good room first, then (later) from a
    // room that has since been abandoned (a real, state-backed leave — the
    // fixture's default) — so the abandoned one is the current single-slot
    // pointer, but the good one is still on record. See the 2026-07-26
    // reboot test for the opposite case: the same shape, but the 'leave'
    // has no backing state event and must NOT be trusted as a departure.
    hook('!still-joined:example.org', '@user8:example.org');
    hook('!abandoned:example.org', '@user8:example.org');

    await wrapped.postMessage('matrix:@user8:example.org', { markdown: 'hi' });

    expect(openDM).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenLastCalledWith('!still-joined:example.org', { markdown: 'hi' });
  });

  it('follows an m.room.tombstone to its replacement room instead of ever calling openDM', async () => {
    // A room upgrade (m.room.tombstone) is the "expected" way a Matrix room's
    // identity changes — not a failure like the ghost-room departures above.
    // The single-slot cache still points at the old room id; resolveThreadId
    // must follow the tombstone to the successor itself rather than treating
    // the pointer as simply stale and falling to openDM.
    const { adapter, openDM, postMessage } = makeFakeAdapter(
      BOT_ID,
      {
        '!old:example.org': {
          id: '!old:example.org',
          joinedCount: 2,
          membership: 'join',
          otherMember: '@user9:example.org',
          tombstoneReplacement: '!upgraded:example.org',
        },
        '!upgraded:example.org': {
          id: '!upgraded:example.org',
          joinedCount: 2,
          membership: 'join',
          otherMember: '@user9:example.org',
        },
      },
      '!should-not-be-used:example.org',
    );
    const wrapped = wrapWithDmResolution(adapter);
    (wrapped as unknown as { __onInboundSender: (t: string, s: string) => void }).__onInboundSender(
      '!old:example.org',
      '@user9:example.org',
    );

    await wrapped.postMessage('matrix:@user9:example.org', { markdown: 'hi' });

    expect(openDM).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenLastCalledWith('!upgraded:example.org', { markdown: 'hi' });
  });

  it('follows a tombstone even when recovering via the reverse lookup, not just the fast path', async () => {
    const { adapter, openDM, postMessage } = makeFakeAdapter(
      BOT_ID,
      {
        '!abandoned:example.org': {
          id: '!abandoned:example.org',
          joinedCount: 2,
          membership: 'leave',
          otherMember: '@user10:example.org',
        },
        '!old-and-tombstoned:example.org': {
          id: '!old-and-tombstoned:example.org',
          joinedCount: 2,
          membership: 'join',
          otherMember: '@user10:example.org',
          tombstoneReplacement: '!successor:example.org',
        },
        '!successor:example.org': {
          id: '!successor:example.org',
          joinedCount: 2,
          membership: 'join',
          otherMember: '@user10:example.org',
        },
      },
      '!should-not-be-used:example.org',
    );
    const wrapped = wrapWithDmResolution(adapter);
    const hook = (wrapped as unknown as { __onInboundSender: (t: string, s: string) => void }).__onInboundSender;

    hook('!old-and-tombstoned:example.org', '@user10:example.org');
    hook('!abandoned:example.org', '@user10:example.org');

    await wrapped.postMessage('matrix:@user10:example.org', { markdown: 'hi' });

    expect(openDM).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenLastCalledWith('!successor:example.org', { markdown: 'hi' });
  });

  it('self-heals on a send failure: invalidates the cache and re-resolves via openDM exactly once', async () => {
    // A cached room can look locally fine (membership 'join', no tombstone
    // the client knows about) and still be genuinely dead server-side — the
    // local Room object is just as capable of lagging reality as any other
    // client-side state. Rather than trusting the cache forever once a real
    // send fails, that's the moment to invalidate it and let openDM()
    // re-resolve — the one case where openDM is actually the right call,
    // because we've just learned our own history is wrong.
    const { adapter, openDM } = makeFakeAdapter(
      BOT_ID,
      {
        '!looks-fine:example.org': {
          id: '!looks-fine:example.org',
          joinedCount: 2,
          membership: 'join',
          otherMember: '@user11:example.org',
        },
        '!fresh:example.org': {
          id: '!fresh:example.org',
          joinedCount: 2,
          membership: 'join',
          otherMember: '@user11:example.org',
        },
      },
      '!fresh:example.org',
    );
    const postMessage = vi.fn(async (threadId: string, ...args: unknown[]) => {
      if (threadId === '!looks-fine:example.org') throw new Error('M_FORBIDDEN: not a member of this room');
      return { id: 'sent', threadId, args };
    });
    (adapter as unknown as { postMessage: typeof postMessage }).postMessage = postMessage;

    const wrapped = wrapWithDmResolution(adapter);
    (wrapped as unknown as { __onInboundSender: (t: string, s: string) => void }).__onInboundSender(
      '!looks-fine:example.org',
      '@user11:example.org',
    );

    await wrapped.postMessage('matrix:@user11:example.org', { markdown: 'hi' });

    expect(openDM).toHaveBeenCalledTimes(1);
    expect(openDM).toHaveBeenCalledWith('@user11:example.org');
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenNthCalledWith(1, '!looks-fine:example.org', { markdown: 'hi' });
    expect(postMessage).toHaveBeenNthCalledWith(2, '!fresh:example.org', { markdown: 'hi' });

    // The cache must now point at the recovered room — no repeat openDM call.
    await wrapped.postMessage('matrix:@user11:example.org', { markdown: 'again' });
    expect(openDM).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenLastCalledWith('!fresh:example.org', { markdown: 'again' });
  });

  it('a local encryption-config failure retries the SAME room instead of abandoning it via openDM (2026-07-26 incident)', async () => {
    // Answering into a different room than the question arrived in never
    // makes sense — so a send failure must be UNAMBIGUOUS server-side
    // evidence the room is dead before it's allowed to trigger openDM().
    // "Cannot encrypt event in unconfigured room" is a local crypto-setup
    // gap (see matrix-encryptors.test.ts) that throws exactly like a real
    // departure to a generic catch block, but proves nothing about the
    // room. It must retry the room we have confirmed-inbound evidence for,
    // not invent a new one.
    const { adapter, openDM } = makeFakeAdapter(
      BOT_ID,
      {
        '!current:example.org': {
          id: '!current:example.org',
          joinedCount: 2,
          membership: 'join',
          otherMember: '@user14:example.org',
        },
      },
      '!should-not-be-used:example.org',
    );
    let attempt = 0;
    const rawPostMessage = vi.fn(async (threadId: string, ...args: unknown[]) => {
      attempt++;
      if (attempt === 1) throw new Error('Cannot encrypt event in unconfigured room !current:example.org');
      return { id: 'sent', threadId, args };
    });
    (adapter as unknown as { postMessage: typeof rawPostMessage }).postMessage = rawPostMessage;

    const wrapped = wrapWithDmResolution(adapter);
    (wrapped as unknown as { __onInboundSender: (t: string, s: string) => void }).__onInboundSender(
      '!current:example.org',
      '@user14:example.org',
    );

    await wrapped.postMessage('matrix:@user14:example.org', { markdown: 'hi' });

    expect(openDM).not.toHaveBeenCalled();
    expect(rawPostMessage).toHaveBeenCalledTimes(2);
    expect(rawPostMessage).toHaveBeenNthCalledWith(1, '!current:example.org', { markdown: 'hi' });
    expect(rawPostMessage).toHaveBeenNthCalledWith(2, '!current:example.org', { markdown: 'hi' });
  });

  it('propagates a persistent non-death failure without ever calling openDM', async () => {
    const { adapter, openDM } = makeFakeAdapter(
      BOT_ID,
      {
        '!current:example.org': {
          id: '!current:example.org',
          joinedCount: 2,
          membership: 'join',
          otherMember: '@user15:example.org',
        },
      },
      '!should-not-be-used:example.org',
    );
    const rawPostMessage = vi.fn(async () => {
      throw new Error('Cannot encrypt event in unconfigured room !current:example.org');
    });
    (adapter as unknown as { postMessage: typeof rawPostMessage }).postMessage = rawPostMessage;

    const wrapped = wrapWithDmResolution(adapter);
    (wrapped as unknown as { __onInboundSender: (t: string, s: string) => void }).__onInboundSender(
      '!current:example.org',
      '@user15:example.org',
    );

    await expect(wrapped.postMessage('matrix:@user15:example.org', { markdown: 'hi' })).rejects.toThrow(
      'Cannot encrypt event in unconfigured room',
    );
    expect(openDM).not.toHaveBeenCalled();
    expect(rawPostMessage).toHaveBeenCalledTimes(2); // original attempt + one same-room retry, no more
  });

  it('persists the confirmed room across a restart — a fresh instance never calls openDM for an already-known user', async () => {
    // The residual gap the in-memory-only caches leave: they're wiped on
    // every restart, so a proactive/host-initiated send right after one
    // (before any fresh inbound message re-warms the cache) had nothing to
    // fall back on except openDM(). Two separate wrapWithDmResolution calls
    // sharing the same on-disk store simulate exactly that restart.
    const rooms = {
      '!persisted:example.org': {
        id: '!persisted:example.org',
        joinedCount: 2,
        membership: 'join',
        otherMember: '@user12:example.org',
      },
    };

    const instanceA = makeFakeAdapter(BOT_ID, rooms, '!should-not-be-used:example.org');
    const wrappedA = wrapWithDmResolution(instanceA.adapter);
    (wrappedA as unknown as { __onInboundSender: (t: string, s: string) => void }).__onInboundSender(
      '!persisted:example.org',
      '@user12:example.org',
    );

    // "Restart": a brand-new adapter instance and a brand-new
    // wrapWithDmResolution call — fresh in-memory caches — but the same
    // on-disk store (this test's DATA_DIR mock is process-wide, not
    // per-instance).
    const instanceB = makeFakeAdapter(BOT_ID, rooms, '!should-not-be-used:example.org');
    const wrappedB = wrapWithDmResolution(instanceB.adapter);

    await wrappedB.postMessage('matrix:@user12:example.org', { markdown: 'hi' });

    expect(instanceB.openDM).not.toHaveBeenCalled();
    expect(instanceB.postMessage).toHaveBeenCalledWith('!persisted:example.org', { markdown: 'hi' });
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
