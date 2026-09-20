/**
 * Where a run-health alert lands. It must be the agent group's own chat —
 * the room the operator already reads — not a stale approvals-style DM
 * (three budget alerts across four days went to a 1:1 room that was never
 * opened). Channel selection: channel destinations of the group, on a
 * channel that carries diagnostic notices; the local CLI and email are
 * never it.
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetMessagingGroup = vi.fn<(id: string) => { channel_type: string; platform_id: string } | undefined>();
const mockDeliversNotices = vi.fn<(channelType: string) => boolean>();

vi.mock('../db/connection.js', () => ({
  getDb: () => db,
  hasTable: (_db: unknown, name: string) => name === 'agent_destinations',
}));
vi.mock('../db/messaging-groups.js', () => ({
  getMessagingGroup: (id: string) => mockGetMessagingGroup(id),
}));
vi.mock('../channels/channel-registry.js', () => ({
  channelDeliversNotices: (channelType: string) => mockDeliversNotices(channelType),
}));

import { pickGroupChatDelivery } from './notification-targets.js';

const db = new Database(':memory:');
db.exec(
  `CREATE TABLE agent_destinations (
     agent_group_id TEXT NOT NULL,
     local_name TEXT NOT NULL,
     target_type TEXT NOT NULL,
     target_id TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
);

function addDestination(targetId: string, targetType = 'channel'): void {
  db.prepare(
    'INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run('ag-1', `dest-${targetId}`, targetType, targetId, new Date().toISOString());
}

function mg(id: string, channelType: string): void {
  mockGetMessagingGroup.mockImplementation((mid: string) =>
    mid === id ? { channel_type: channelType, platform_id: `plat-${mid}` } : undefined,
  );
}

describe('pickGroupChatDelivery', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM agent_destinations').run();
    mockGetMessagingGroup.mockReset();
    mockDeliversNotices.mockReset().mockReturnValue(true);
  });

  it('takes the group chat channel the agent already posts to', () => {
    addDestination('mg-matrix');
    mg('mg-matrix', 'matrix');

    expect(pickGroupChatDelivery('ag-1')).toEqual({ channelType: 'matrix', platformId: 'plat-mg-matrix' });
  });

  it('skips the local CLI and non-notice channels like email', () => {
    addDestination('mg-cli');
    addDestination('mg-mail');
    addDestination('mg-matrix');
    mockDeliversNotices.mockImplementation((channelType: string) => channelType !== 'email');
    mockGetMessagingGroup.mockImplementation((mid: string) => {
      if (mid === 'mg-cli') return { channel_type: 'cli', platform_id: 'local' };
      if (mid === 'mg-mail') return { channel_type: 'email', platform_id: 'mail:x' };
      if (mid === 'mg-matrix') return { channel_type: 'matrix', platform_id: 'plat-mg-matrix' };
      return undefined;
    });

    expect(pickGroupChatDelivery('ag-1')).toEqual({ channelType: 'matrix', platformId: 'plat-mg-matrix' });
  });

  it('returns null when only unusable destinations exist', () => {
    addDestination('mg-mail');
    mockDeliversNotices.mockReturnValue(false);
    mockGetMessagingGroup.mockReturnValue({ channel_type: 'email', platform_id: 'mail:x' });

    expect(pickGroupChatDelivery('ag-1')).toBeNull();
  });

  it('returns null when the group has no destinations at all', () => {
    expect(pickGroupChatDelivery('ag-1')).toBeNull();
  });
});
