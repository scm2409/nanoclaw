/**
 * Who may write to the mailbox, and who the agent may write to.
 *
 * There is no allowlist table. The allowlist IS the wiring every other channel
 * already goes through, queried from the adapter so a disallowed sender never
 * becomes a NanoClaw message at all:
 *
 *   inbound  — a messaging_groups row for `email:<addr>`, wired to an agent
 *              group, plus an agent_group_members row for `email:<addr>` on
 *              that same agent group. The membership row is the gate
 *              canAccessAgentGroup checks; without it the router would drop
 *              the message anyway, so checking it here only means the drop
 *              happens before a messaging group or an unregistered_senders
 *              row is created for what is usually spam.
 *   outbound — additionally an agent_destinations row pointing at that
 *              messaging group. src/delivery.ts re-checks the same row
 *              against the central DB and is authoritative; this check exists
 *              so nothing reaches SMTP even if that path is ever bypassed.
 *
 * Both directions fail CLOSED. This differs deliberately from delivery.ts,
 * which permits non-origin channel sends when the agent-to-agent module isn't
 * installed: for email, "no destinations table" means "no outbound allowlist
 * exists", and mailing the world is not an acceptable degradation.
 *
 * Results are cached briefly because the IMAP loop asks per message. Any
 * mutation path (scripts/email-allow.ts) calls invalidateEmailAllowlistCache.
 */
import { getDb, hasTable } from '../db/connection.js';
import { normalizeAddress } from './email-parse.js';

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  inbound: boolean;
  outbound: boolean;
  at: number;
}

const cache = new Map<string, CacheEntry>();

export function invalidateEmailAllowlistCache(): void {
  cache.clear();
}

function lookup(address: string): CacheEntry {
  const cached = cache.get(address);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached;

  const platformId = `email:${address}`;
  const db = getDb();

  const inbound =
    db
      .prepare(
        `SELECT 1 FROM messaging_groups mg
           JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
           JOIN agent_group_members m
             ON m.agent_group_id = mga.agent_group_id AND m.user_id = ?
          WHERE mg.channel_type = 'email' AND mg.platform_id = ?
          LIMIT 1`,
      )
      .get(platformId, platformId) !== undefined;

  const outbound = hasTable(db, 'agent_destinations')
    ? db
        .prepare(
          `SELECT 1 FROM messaging_groups mg
             JOIN agent_destinations d ON d.target_type = 'channel' AND d.target_id = mg.id
            WHERE mg.channel_type = 'email' AND mg.platform_id = ?
            LIMIT 1`,
        )
        .get(platformId) !== undefined
    : false;

  const entry: CacheEntry = { inbound, outbound, at: Date.now() };
  cache.set(address, entry);
  return entry;
}

/** May this address send mail to the agent? */
export function isAllowedSender(rawAddress: string): boolean {
  const address = normalizeAddress(rawAddress);
  if (!address) return false;
  return lookup(address).inbound;
}

/** May the agent send mail to this address? */
export function isAllowedRecipient(rawAddress: string): boolean {
  const address = normalizeAddress(rawAddress);
  if (!address) return false;
  return lookup(address).outbound;
}

export interface AllowedAddress {
  address: string;
  agentGroupId: string | null;
  inbound: boolean;
  outbound: boolean;
}

/** Every email messaging group with its effective permissions, for `email-allow list`. */
export function listAllowedAddresses(): AllowedAddress[] {
  const db = getDb();
  const destinationsExist = hasTable(db, 'agent_destinations');

  const rows = db
    .prepare(
      `SELECT mg.platform_id AS platform_id,
              mga.agent_group_id AS agent_group_id,
              EXISTS (
                SELECT 1 FROM agent_group_members m
                 WHERE m.agent_group_id = mga.agent_group_id AND m.user_id = mg.platform_id
              ) AS is_member
         FROM messaging_groups mg
         LEFT JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
        WHERE mg.channel_type = 'email'
        ORDER BY mg.created_at, mg.platform_id`,
    )
    .all() as Array<{ platform_id: string; agent_group_id: string | null; is_member: number }>;

  return rows.map((row) => {
    const address = row.platform_id.replace(/^email:/, '');
    const outbound = destinationsExist
      ? db
          .prepare(
            `SELECT 1 FROM messaging_groups mg
               JOIN agent_destinations d ON d.target_type = 'channel' AND d.target_id = mg.id
              WHERE mg.platform_id = ? AND mg.channel_type = 'email'
              LIMIT 1`,
          )
          .get(row.platform_id) !== undefined
      : false;
    return {
      address,
      agentGroupId: row.agent_group_id,
      inbound: row.agent_group_id !== null && row.is_member === 1,
      outbound,
    };
  });
}
