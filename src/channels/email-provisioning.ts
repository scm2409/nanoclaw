/**
 * Provisioning for the email channel's inbound and outbound allowlist.
 *
 * There is no allowlist table: an address is allowed because it is wired like
 * any other chat, so allowing one means creating four rows that would
 * otherwise be four separate `ncl` invocations:
 *
 *   users                  email:<addr>                 (identity)
 *   messaging_groups       email / email:<addr>         (strict, DM)
 *   messaging_group_agents wiring onto the agent group  (+ agent_destinations)
 *   agent_group_members    email:<addr> in that group   (the inbound gate)
 *
 * email-allowlist.ts reads those same rows back. `scripts/email-allow.ts` is
 * the CLI over this module; the logic lives here so tests and other in-tree
 * callers can use it without reaching into scripts/.
 */
import './index.js'; // registration-only: resolves channel defaults, connects nothing
import { resolveUnknownSenderPolicy, resolveWiringDefaults } from './channel-defaults.js';
import { invalidateEmailAllowlistCache } from './email-allowlist.js';
import { normalizeAddress } from './email-parse.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  deleteMessagingGroup,
  deleteMessagingGroupAgent,
  ensureAgentDestinationForWiring,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
} from '../db/messaging-groups.js';
import { getDestinationByTarget, deleteDestination } from '../modules/agent-to-agent/db/agent-destinations.js';
import { addMember, hasMembershipRow, removeMember } from '../modules/permissions/db/agent-group-members.js';
import { getUser, upsertUser } from '../modules/permissions/db/users.js';
import type { AgentGroup } from '../types.js';

/**
 * Which half of the correspondence to open.
 *
 * Asymmetry is the normal case, not an edge case: "this person may write to
 * the agent" and "the agent may write to this person" are different decisions.
 * A monitored address that only ever sends in, or a single reporting address
 * the agent may write to and nobody else, are both ordinary setups.
 */
export type AllowDirection = 'in' | 'out' | 'both';

export interface AllowOptions {
  displayName?: string;
  agentGroupId: string;
  agentGroupName: string;
  /** Defaults to 'both'. */
  direction?: AllowDirection;
  /** Injected so tests don't need a session tree; defaults to the real projection. */
  project?: (agentGroupId: string) => Promise<void>;
}

function now(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function defaultProject(agentGroupId: string): Promise<void> {
  const { projectDestinationsToSessions } = await import('../cli/resources/destinations.js');
  await projectDestinationsToSessions(agentGroupId);
}

export interface AllowResult {
  address: string;
  messagingGroupId: string;
  created: boolean;
}

/**
 * Allow an address in the requested direction(s).
 *
 * Declarative rather than additive: the rows are made to match the direction
 * asked for, so re-running with a narrower direction CLOSES the other half.
 * The alternative — only ever adding — would mean a mistake could not be
 * corrected without a full remove/re-add cycle, on exactly the surface where
 * mistakes matter most.
 *
 * Idempotent either way, so it doubles as a repair for a half-configured
 * address (e.g. a wiring created by hand with no membership row).
 */
export async function allowAddress(rawAddress: string, opts: AllowOptions): Promise<AllowResult> {
  const direction = opts.direction ?? 'both';
  const wantInbound = direction === 'in' || direction === 'both';
  const wantOutbound = direction === 'out' || direction === 'both';
  const address = normalizeAddress(rawAddress);
  if (!address) throw new Error(`Not a usable email address: ${rawAddress}`);

  const platformId = `email:${address}`;
  const timestamp = now();

  upsertUser({
    id: platformId,
    kind: 'email',
    display_name: opts.displayName ?? getUser(platformId)?.display_name ?? address,
    created_at: timestamp,
  });

  let mg = getMessagingGroupByPlatform('email', platformId, 'email');
  const created = mg === undefined;
  if (!mg) {
    const id = newId('mg');
    createMessagingGroup({
      id,
      channel_type: 'email',
      platform_id: platformId,
      instance: 'email',
      name: opts.displayName ?? address,
      is_group: 0,
      // 'strict' by the adapter's declaration — an unknown mail sender is
      // dropped, never escalated into an approval card.
      unknown_sender_policy: resolveUnknownSenderPolicy('email', false),
      created_at: timestamp,
    });
    mg = getMessagingGroupByPlatform('email', platformId, 'email')!;
  }

  // The wiring is created for either direction: outbound needs it to hang the
  // destination off, and for an outbound-only address it is harmless — the
  // missing membership row below is what keeps inbound shut (the router's
  // access gate and the adapter's own prefilter both require it).
  let wiring = getMessagingGroupAgents(mg.id).find((w) => w.agent_group_id === opts.agentGroupId);
  if (!wiring) {
    const wiringDefaults = resolveWiringDefaults('email', false, opts.agentGroupName);
    // Also writes the companion agent_destinations row — the outbound half of
    // the allowlist (ensureAgentDestinationForWiring in db/messaging-groups.ts).
    createMessagingGroupAgent({
      id: newId('mga'),
      messaging_group_id: mg.id,
      agent_group_id: opts.agentGroupId,
      engage_mode: wiringDefaults.engage_mode,
      engage_pattern: wiringDefaults.engage_pattern,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: timestamp,
    });
    wiring = getMessagingGroupAgents(mg.id).find((w) => w.agent_group_id === opts.agentGroupId);
  }

  // Inbound gate: the membership row canAccessAgentGroup checks.
  if (wantInbound) {
    if (!hasMembershipRow(platformId, opts.agentGroupId)) {
      addMember({ user_id: platformId, agent_group_id: opts.agentGroupId, added_by: null, added_at: timestamp });
    }
  } else {
    removeMember(platformId, opts.agentGroupId);
  }

  // Outbound gate: the destination row delivery.ts validates against.
  const destination = getDestinationByTarget(opts.agentGroupId, 'channel', mg.id);
  if (wantOutbound) {
    if (!destination && wiring) ensureAgentDestinationForWiring(wiring);
  } else if (destination) {
    deleteDestination(opts.agentGroupId, destination.local_name);
  }

  invalidateEmailAllowlistCache();
  await (opts.project ?? defaultProject)(opts.agentGroupId);

  return { address, messagingGroupId: mg.id, created };
}

/**
 * Revoke a direction (default both). Idempotent: an unknown address is not an
 * error. Revoking one direction leaves the other intact; revoking both removes
 * every row this module created.
 */
export async function revokeAddress(
  rawAddress: string,
  opts: Pick<AllowOptions, 'agentGroupId' | 'project' | 'direction'>,
): Promise<boolean> {
  const address = normalizeAddress(rawAddress);
  if (!address) throw new Error(`Not a usable email address: ${rawAddress}`);
  const direction = opts.direction ?? 'both';

  const platformId = `email:${address}`;
  const mg = getMessagingGroupByPlatform('email', platformId, 'email');
  if (!mg) {
    invalidateEmailAllowlistCache();
    return false;
  }

  // Destination first: it references the messaging group, and leaving an
  // orphan row behind would keep the outbound half of the allowlist open.
  if (direction === 'out' || direction === 'both') {
    const destination = getDestinationByTarget(opts.agentGroupId, 'channel', mg.id);
    if (destination) deleteDestination(opts.agentGroupId, destination.local_name);
  }

  if (direction === 'in' || direction === 'both') {
    removeMember(platformId, opts.agentGroupId);
  }

  if (direction !== 'both') {
    invalidateEmailAllowlistCache();
    await (opts.project ?? defaultProject)(opts.agentGroupId);
    return true;
  }

  for (const wiring of getMessagingGroupAgents(mg.id)) {
    if (wiring.agent_group_id === opts.agentGroupId) deleteMessagingGroupAgent(wiring.id);
  }

  // Only drop the messaging group once no agent is wired to it any more —
  // another agent group may legitimately still correspond with this address.
  if (getMessagingGroupAgents(mg.id).length === 0) deleteMessagingGroup(mg.id);

  invalidateEmailAllowlistCache();
  await (opts.project ?? defaultProject)(opts.agentGroupId);
  return true;
}

/** Resolve `--group` by id or name; fall back to the sole agent group. */
export function resolveAgentGroup(groups: AgentGroup[], wanted: string | undefined): AgentGroup {
  if (wanted) {
    const match = groups.find((g) => g.id === wanted || g.name.toLowerCase() === wanted.toLowerCase());
    if (!match) {
      throw new Error(`No agent group matches "${wanted}". Known: ${groups.map((g) => g.name).join(', ')}`);
    }
    return match;
  }
  if (groups.length === 1) return groups[0];
  throw new Error(
    `--group is required when the install has ${groups.length} agent groups: ${groups.map((g) => g.name).join(', ')}`,
  );
}
