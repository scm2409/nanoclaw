/**
 * The allowlist is not a list — it is a query over the wiring that already
 * governs every other channel. These tests exist to pin that equivalence, so
 * a future refactor of the permissions or destinations tables can't quietly
 * open the mailbox to everyone.
 *
 * Both directions fail CLOSED. Note that this differs from src/delivery.ts,
 * which permits non-origin channel sends when the agent-to-agent module isn't
 * installed at all: for email, "no destinations table" means "no outbound
 * allowlist exists", and sending mail to the world is not an acceptable
 * degradation.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import {
  invalidateEmailAllowlistCache,
  isAllowedRecipient,
  isAllowedSender,
  listAllowedAddresses,
} from './email-allowlist.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../db/index.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../db/messaging-groups.js';
import { addMember } from '../modules/permissions/db/agent-group-members.js';
import { upsertUser } from '../modules/permissions/db/users.js';

const AG = 'ag-email-test';
const ADDR = 'freund@example.org';

function now(): string {
  return new Date().toISOString();
}

/** Everything `scripts/email-allow.ts add` creates, so the test asserts the real shape. */
function wireAddress(address: string, opts: { member?: boolean; wiring?: boolean } = {}): void {
  const { member = true, wiring = true } = opts;
  const platformId = `email:${address}`;
  upsertUser({ id: platformId, kind: 'email', display_name: address, created_at: now() });
  createMessagingGroup({
    id: `mg-${address}`,
    channel_type: 'email',
    platform_id: platformId,
    instance: 'email',
    name: address,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  if (wiring) {
    createMessagingGroupAgent({
      id: `mga-${address}`,
      messaging_group_id: `mg-${address}`,
      agent_group_id: AG,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
  }
  if (member) {
    addMember({ user_id: platformId, agent_group_id: AG, added_by: null, added_at: now() });
  }
}

describe('email allowlist', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
    createAgentGroup({ id: AG, name: 'KaiL01', folder: 'kail', agent_provider: null, created_at: now() });
    invalidateEmailAllowlistCache();
  });

  afterEach(() => {
    closeDb();
    invalidateEmailAllowlistCache();
  });

  describe('isAllowedSender', () => {
    it('accepts a fully wired address', () => {
      wireAddress(ADDR);
      expect(isAllowedSender(ADDR)).toBe(true);
    });

    it('rejects an address nobody wired', () => {
      expect(isAllowedSender('fremder@example.org')).toBe(false);
    });

    // The membership row is the actual gate canAccessAgentGroup checks. A
    // messaging group alone must not be enough, or an operator who created a
    // wiring by hand would silently open the inbox.
    it('rejects a wired address with no membership row', () => {
      wireAddress(ADDR, { member: false });
      expect(isAllowedSender(ADDR)).toBe(false);
    });

    it('rejects a member whose messaging group is not wired to any agent', () => {
      wireAddress(ADDR, { wiring: false });
      expect(isAllowedSender(ADDR)).toBe(false);
    });

    it('normalizes before looking up', () => {
      wireAddress(ADDR);
      expect(isAllowedSender('  Freund@Example.ORG ')).toBe(true);
      expect(isAllowedSender('Freund Name <freund@example.org>')).toBe(true);
    });

    it('rejects an unparseable address', () => {
      expect(isAllowedSender('not an address')).toBe(false);
    });

    it('does not treat a plus-address as the base address', () => {
      wireAddress(ADDR);
      expect(isAllowedSender('freund+spam@example.org')).toBe(false);
    });

    it('ignores messaging groups on other channels with the same handle', () => {
      upsertUser({ id: `email:${ADDR}`, kind: 'email', display_name: null, created_at: now() });
      addMember({ user_id: `email:${ADDR}`, agent_group_id: AG, added_by: null, added_at: now() });
      createMessagingGroup({
        id: 'mg-matrix',
        channel_type: 'matrix',
        platform_id: `email:${ADDR}`,
        instance: 'matrix',
        name: null,
        is_group: 0,
        unknown_sender_policy: 'public',
        created_at: now(),
      });
      createMessagingGroupAgent({
        id: 'mga-matrix',
        messaging_group_id: 'mg-matrix',
        agent_group_id: AG,
        engage_mode: 'pattern',
        engage_pattern: '.',
        sender_scope: 'all',
        ignored_message_policy: 'drop',
        session_mode: 'shared',
        priority: 0,
        created_at: now(),
      });
      expect(isAllowedSender(ADDR)).toBe(false);
    });
  });

  describe('isAllowedRecipient', () => {
    it('accepts an address the wiring created a destination for', () => {
      wireAddress(ADDR);
      expect(isAllowedRecipient(ADDR)).toBe(true);
    });

    it('rejects an address with no destination row', () => {
      wireAddress(ADDR);
      getDb().prepare('DELETE FROM agent_destinations').run();
      invalidateEmailAllowlistCache();
      expect(isAllowedRecipient(ADDR)).toBe(false);
    });

    it('rejects an unknown address', () => {
      expect(isAllowedRecipient('fremder@example.org')).toBe(false);
    });

    it('fails closed when the destinations table does not exist', () => {
      wireAddress(ADDR);
      getDb().exec('DROP TABLE agent_destinations');
      invalidateEmailAllowlistCache();
      expect(isAllowedRecipient(ADDR)).toBe(false);
    });
  });

  describe('cache', () => {
    it('reflects a revocation once the cache is invalidated', () => {
      wireAddress(ADDR);
      expect(isAllowedSender(ADDR)).toBe(true);
      getDb().prepare('DELETE FROM agent_group_members WHERE user_id = ?').run(`email:${ADDR}`);
      invalidateEmailAllowlistCache();
      expect(isAllowedSender(ADDR)).toBe(false);
    });
  });

  describe('listAllowedAddresses', () => {
    it('reports both directions per address', () => {
      wireAddress(ADDR);
      wireAddress('halb@example.org', { member: false });
      expect(listAllowedAddresses()).toEqual([
        { address: ADDR, agentGroupId: AG, inbound: true, outbound: true },
        { address: 'halb@example.org', agentGroupId: AG, inbound: false, outbound: true },
      ]);
    });
  });
});
