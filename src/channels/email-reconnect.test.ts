/**
 * IMAP reconnect behaviour.
 *
 * This is the one failure mode a mail channel is guaranteed to meet: it runs
 * for months, and servers time out IDLE sessions, restart, and sit behind
 * flaky networks. Before the reconnect path existed, a single dropped socket
 * left the adapter logging "Connection not available" once per poll forever,
 * receiving nothing, while `isConnected()` still claimed the channel was
 * healthy — found by the GreenMail live suite, pinned here because the live
 * suite never severs the connection itself.
 *
 * Uses a fake IMAP client so the drop can be provoked deterministically.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { createEmailAdapter, type EmailAdapterConfig, type ImapClientLike } from './email.js';
import { DEFAULT_EMAIL_LIMITS } from './email-limits.js';
import type { ChannelSetup } from './adapter.js';

const CONFIG: EmailAdapterConfig = {
  address: 'kail@example.org',
  user: 'kail@example.org',
  password: 'secret',
  mailbox: 'INBOX',
  pollIntervalMs: 60_000,
  imap: { host: 'imap.example.org', port: 993, secure: true },
  smtp: { host: 'smtp.example.org', port: 587, secure: false },
  limits: DEFAULT_EMAIL_LIMITS,
};

interface FakeClient extends ImapClientLike {
  emit(event: string): void;
  connectCalls: number;
  failConnect: boolean;
}

function fakeImapClient(): FakeClient {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    connectCalls: 0,
    failConnect: false,
    usable: true,
    mailbox: { uidValidity: 42, uidNext: 1 },
    async connect() {
      this.connectCalls++;
      if (this.failConnect) throw new Error('connect refused');
    },
    async logout() {},
    async getMailboxLock() {
      return { release() {} };
    },
    fetch() {
      return (async function* () {})();
    },
    async messageFlagsAdd() {
      return true;
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      handlers.set(event, handler);
      return this;
    },
    emit(event: string) {
      handlers.get(event)?.();
    },
  };
}

const NO_OP_SETUP: ChannelSetup = {
  onInbound: () => {},
  onInboundEvent: () => {},
  onMetadata: () => {},
  onAction: () => {},
};

function makeAdapter() {
  const clients: FakeClient[] = [];
  // In-memory watermark: the real one is a file under DATA_DIR, and a unit
  // test must not touch the install's own state.
  const cursors = new Map<string, { uidValidity: string; lastUid: number }>();
  const adapter = createEmailAdapter(CONFIG, {
    createImapClient: () => {
      const client = fakeImapClient();
      clients.push(client);
      return client;
    },
    createTransport: () => ({ sendMail: async () => ({}) }),
    getMailboxCursor: (mailbox) => cursors.get(mailbox),
    saveMailboxCursor: (mailbox, cursor) => void cursors.set(mailbox, cursor),
  });
  return { adapter, clients };
}

describe('email adapter — IMAP reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reconnects after the connection closes', async () => {
    const { adapter, clients } = makeAdapter();
    await adapter.setup(NO_OP_SETUP);
    expect(clients).toHaveLength(1);
    expect(adapter.isConnected()).toBe(true);

    clients[0].usable = false;
    clients[0].emit('close');
    // Reported as disconnected immediately, so the host isn't told a dead
    // channel is fine.
    expect(adapter.isConnected()).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(clients).toHaveLength(2);
    expect(adapter.isConnected()).toBe(true);

    await adapter.teardown();
  });

  // A server that accepts the socket and drops it immediately would otherwise
  // be retried every 2s forever, because each attempt technically "connected".
  it('backs off through a flapping connection instead of hammering', async () => {
    const { adapter, clients } = makeAdapter();
    await adapter.setup(NO_OP_SETUP);

    clients[0].usable = false;
    clients[0].emit('close');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(clients).toHaveLength(2);

    // Dropped again right away — the next wait must be longer than 2s.
    clients[1].usable = false;
    clients[1].emit('close');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(clients).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(clients).toHaveLength(3);

    await adapter.teardown();
  });

  it('resets the backoff after a connection that actually held', async () => {
    const { adapter, clients } = makeAdapter();
    await adapter.setup(NO_OP_SETUP);

    clients[0].usable = false;
    clients[0].emit('close');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(clients).toHaveLength(2);

    // This one stays up long enough to count as recovered, so the next drop
    // starts over at the shortest delay rather than continuing to grow.
    await vi.advanceTimersByTimeAsync(120_000);
    clients[1].usable = false;
    clients[1].emit('close');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(clients).toHaveLength(3);

    await adapter.teardown();
  });

  it('retries when the reconnect itself throws', async () => {
    const { adapter, clients } = makeAdapter();
    await adapter.setup(NO_OP_SETUP);

    clients[0].usable = false;
    clients[0].emit('close');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(clients).toHaveLength(2);
    // The replacement client was constructed but refuses to connect on the
    // next attempt, which must schedule another one rather than give up.
    clients[1].failConnect = true;
    clients[1].usable = false;
    clients[1].emit('close');

    await vi.advanceTimersByTimeAsync(5_000);
    expect(clients.length).toBeGreaterThanOrEqual(3);

    await adapter.teardown();
  });

  it('does not reconnect after teardown', async () => {
    const { adapter, clients } = makeAdapter();
    await adapter.setup(NO_OP_SETUP);
    await adapter.teardown();

    clients[0].usable = false;
    clients[0].emit('close');
    await vi.advanceTimersByTimeAsync(120_000);

    expect(clients).toHaveLength(1);
    expect(adapter.isConnected()).toBe(false);
  });

  it('cancels a pending reconnect on teardown', async () => {
    const { adapter, clients } = makeAdapter();
    await adapter.setup(NO_OP_SETUP);

    clients[0].usable = false;
    clients[0].emit('close');
    await adapter.teardown();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(clients).toHaveLength(1);
  });

  // The poll timer keeps firing while the socket is dead; each tick must
  // notice and route into the (self-deduplicating) reconnect path rather than
  // trying to fetch on a dead connection.
  it('triggers a reconnect from the poll timer when the socket died silently', async () => {
    const { adapter, clients } = makeAdapter();
    await adapter.setup(NO_OP_SETUP);

    // No 'close' event — the socket is simply unusable.
    clients[0].usable = false;

    await vi.advanceTimersByTimeAsync(CONFIG.pollIntervalMs);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(clients).toHaveLength(2);

    await adapter.teardown();
  });
});
