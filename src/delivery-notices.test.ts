/**
 * Diagnostic notices ("📊 Tokens: …", "🔎 Subagent: …") are operator-facing
 * chatter, and chat channels are the right place for them: one more line in a
 * conversation costs nothing.
 *
 * Email is not that. Every notice would be a separate mail sitting in an inbox
 * forever — and, worse, a mail to a correspondent who is not the operator would
 * carry the install's model choice and USD cost. That is a disclosure, not just
 * noise, so it is a hard rule rather than a setting: a channel either declares
 * that it carries notices or it does not, and the default is the pre-existing
 * behaviour (it does).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-notices', GROUPS_DIR: '/tmp/nanoclaw-test-notices/groups' };
});

const TEST_DIR = '/tmp/nanoclaw-test-notices';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { getDeliveredIds } from './db/session-db.js';
import { channelDeliversNotices, registerChannelAdapter } from './channels/channel-registry.js';
import { deliverSessionMessages, setDeliveryAdapter } from './delivery.js';
import { outboundDbPath, resolveSession } from './session-manager.js';

function now(): string {
  return new Date().toISOString();
}

function seed(channelType: string): void {
  createAgentGroup({ id: 'ag-1', name: 'Test Agent', folder: 'test-agent', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: channelType,
    platform_id: `${channelType}:123`,
    name: 'Test Chat',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
}

function insertOutbound(sessionId: string, msgId: string, kind: string, channelType: string): void {
  const db = new Database(outboundDbPath('ag-1', sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
     VALUES (?, datetime('now'), ?, ?, ?, ?)`,
  ).run(msgId, kind, `${channelType}:123`, channelType, JSON.stringify({ text: '📊 Tokens: model: 1 ($0.01)' }));
  db.close();
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('channelDeliversNotices', () => {
  it('defaults to true for a channel that declares nothing', () => {
    registerChannelAdapter('legacy', { factory: () => null });
    expect(channelDeliversNotices('legacy')).toBe(true);
  });

  it('defaults to true for a channel that is not registered at all', () => {
    expect(channelDeliversNotices('never-heard-of-it')).toBe(true);
  });

  it('honours an explicit opt-out', () => {
    registerChannelAdapter('quiet', { factory: () => null, deliversNotices: false });
    expect(channelDeliversNotices('quiet')).toBe(false);
  });
});

describe('notice delivery', () => {
  it('delivers a notice on a channel that carries them', async () => {
    registerChannelAdapter('telegram', { factory: () => null });
    seed('telegram');
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound(session.id, 'out-1', 'notice', 'telegram');

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        calls.push(content);
        return 'plat-1';
      },
    });

    await deliverSessionMessages(session);
    expect(calls).toHaveLength(1);
  });

  it('does not send a notice on a channel that opted out', async () => {
    registerChannelAdapter('email', { factory: () => null, deliversNotices: false });
    seed('email');
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound(session.id, 'out-1', 'notice', 'email');

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        calls.push(content);
        return 'plat-1';
      },
    });

    await deliverSessionMessages(session);
    expect(calls).toHaveLength(0);
  });

  // Suppressed is not failed: the row must be marked delivered, or the poll
  // retries it forever and eventually parks it as a permanent failure.
  it('marks a suppressed notice delivered rather than retrying it', async () => {
    registerChannelAdapter('email', { factory: () => null, deliversNotices: false });
    seed('email');
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound(session.id, 'out-1', 'notice', 'email');

    setDeliveryAdapter({
      async deliver() {
        throw new Error('must not be called');
      },
    });

    await deliverSessionMessages(session);
    await deliverSessionMessages(session);

    const inDb = new Database(outboundDbPath('ag-1', session.id).replace('outbound.db', 'inbound.db'));
    expect(getDeliveredIds(inDb)).toContain('out-1');
    inDb.close();
  });

  // The opt-out is about notices only — the actual answer still has to arrive.
  it('still delivers ordinary chat on a channel that opted out of notices', async () => {
    registerChannelAdapter('email', { factory: () => null, deliversNotices: false });
    seed('email');
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound(session.id, 'out-1', 'chat', 'email');

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        calls.push(content);
        return 'plat-1';
      },
    });

    await deliverSessionMessages(session);
    expect(calls).toHaveLength(1);
  });
});
