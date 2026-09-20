/**
 * Where to reach the human on an agent group's behalf.
 *
 * The room the operator actually reads is the one the agent already posts
 * to — its own wired channel. Resolution walks the group's channel
 * destinations and takes the first one on a channel that carries diagnostic
 * notices (an email correspondent must not get operational chatter, and the
 * local CLI is not a place anyone watches). Falls back to per-user DM
 * resolution at the callers when the group has no such destination.
 *
 * Consumers: run-health alerts and approval requests. Both used to resolve
 * a private DM instead, which parked them in a stale 1:1 room the operator
 * never opened (measured 2026-09-20: three budget-exhaustion alerts across
 * four days, none seen).
 */
import { channelDeliversNotices } from '../channels/channel-registry.js';
import { getDb, hasTable } from '../db/connection.js';
import { getMessagingGroup } from '../db/messaging-groups.js';

export function pickGroupChatDelivery(agentGroupId: string): { channelType: string; platformId: string } | null {
  if (!hasTable(getDb(), 'agent_destinations')) return null;
  const destinations = getDb()
    .prepare('SELECT * FROM agent_destinations WHERE agent_group_id = ?')
    .all(agentGroupId) as Array<{ target_type: string; target_id: string }>;
  for (const dest of destinations) {
    if (dest.target_type !== 'channel') continue;
    const mg = getMessagingGroup(dest.target_id);
    if (!mg || mg.channel_type === 'cli') continue;
    if (!channelDeliversNotices(mg.channel_type)) continue;
    return { channelType: mg.channel_type, platformId: mg.platform_id };
  }
  return null;
}
