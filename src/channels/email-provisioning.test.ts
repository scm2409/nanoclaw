/**
 * Provisioning is the only place the four allowlist rows are created together,
 * so these tests assert against the reader (`isAllowedSender` /
 * `isAllowedRecipient`) rather than against row counts: if the two ever drift
 * apart, that is exactly the bug worth catching.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { allowAddress, resolveAgentGroup, revokeAddress } from './email-provisioning.js';
import {
  invalidateEmailAllowlistCache,
  isAllowedRecipient,
  isAllowedSender,
  listAllowedAddresses,
} from './email-allowlist.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../db/index.js';
import { getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import { getUser } from '../modules/permissions/db/users.js';
import type { AgentGroup } from '../types.js';

const AG = 'ag-kail';
const ADDR = 'freund@example.org';

function opts(project = vi.fn().mockResolvedValue(undefined)) {
  return { agentGroupId: AG, agentGroupName: 'KaiL01', project };
}

describe('email-allow', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
    createAgentGroup({
      id: AG,
      name: 'KaiL01',
      folder: 'kail',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    invalidateEmailAllowlistCache();
  });

  afterEach(() => {
    closeDb();
    invalidateEmailAllowlistCache();
  });

  describe('allowAddress', () => {
    it('opens both directions in one call', async () => {
      await allowAddress(ADDR, opts());
      expect(isAllowedSender(ADDR)).toBe(true);
      expect(isAllowedRecipient(ADDR)).toBe(true);
    });

    it('creates the user, a strict DM messaging group, and the membership row', async () => {
      await allowAddress(ADDR, { ...opts(), displayName: 'Der Freund' });
      const user = getUser(`email:${ADDR}`);
      expect(user).toMatchObject({ kind: 'email', display_name: 'Der Freund' });

      const mg = getMessagingGroupByPlatform('email', `email:${ADDR}`, 'email');
      expect(mg).toMatchObject({ channel_type: 'email', is_group: 0, unknown_sender_policy: 'strict' });
    });

    it('normalizes the address before wiring it', async () => {
      await allowAddress('  Freund Name <Freund@Example.ORG> ', opts());
      expect(getMessagingGroupByPlatform('email', `email:${ADDR}`, 'email')).toBeDefined();
      expect(isAllowedSender(ADDR)).toBe(true);
    });

    it('rejects an unusable address instead of wiring something odd', async () => {
      await expect(allowAddress('not an address', opts())).rejects.toThrow(/Not a usable email address/);
    });

    it('is idempotent', async () => {
      await allowAddress(ADDR, opts());
      const first = getMessagingGroupByPlatform('email', `email:${ADDR}`, 'email')!.id;
      const second = await allowAddress(ADDR, opts());
      expect(second.created).toBe(false);
      expect(second.messagingGroupId).toBe(first);
      expect(countRows('messaging_group_agents')).toBe(1);
      expect(countRows('agent_group_members')).toBe(1);
      expect(countRows('agent_destinations')).toBe(1);
    });

    // Half-configured addresses are the realistic failure mode: someone ran
    // `ncl wirings create` by hand and never added the membership row.
    it('repairs a missing membership row', async () => {
      await allowAddress(ADDR, opts());
      getDb().prepare('DELETE FROM agent_group_members').run();
      invalidateEmailAllowlistCache();
      expect(isAllowedSender(ADDR)).toBe(false);

      await allowAddress(ADDR, opts());
      expect(isAllowedSender(ADDR)).toBe(true);
    });

    // Without this the agent keeps serving a stale destinations projection and
    // a freshly allowed recipient silently fails until its next wake.
    it('projects destinations into live sessions', async () => {
      const project = vi.fn().mockResolvedValue(undefined);
      await allowAddress(ADDR, opts(project));
      expect(project).toHaveBeenCalledWith(AG);
    });
  });

  // The real-world shape is asymmetric: a correspondent who may write to the
  // agent is not automatically someone the agent may write to.
  describe('direction', () => {
    it('opens inbound only', async () => {
      await allowAddress(ADDR, { ...opts(), direction: 'in' });
      expect(isAllowedSender(ADDR)).toBe(true);
      expect(isAllowedRecipient(ADDR)).toBe(false);
      expect(countRows('agent_destinations')).toBe(0);
    });

    it('opens outbound only', async () => {
      await allowAddress(ADDR, { ...opts(), direction: 'out' });
      expect(isAllowedSender(ADDR)).toBe(false);
      expect(isAllowedRecipient(ADDR)).toBe(true);
    });

    it('defaults to both', async () => {
      await allowAddress(ADDR, opts());
      expect(isAllowedSender(ADDR)).toBe(true);
      expect(isAllowedRecipient(ADDR)).toBe(true);
    });

    // Declarative, not additive: re-running with a narrower direction has to
    // close the other one, or a typo could never be corrected without a full
    // remove/re-add cycle.
    it('closes outbound when narrowed from both to inbound', async () => {
      await allowAddress(ADDR, opts());
      await allowAddress(ADDR, { ...opts(), direction: 'in' });
      expect(isAllowedSender(ADDR)).toBe(true);
      expect(isAllowedRecipient(ADDR)).toBe(false);
    });

    it('closes inbound when narrowed from both to outbound', async () => {
      await allowAddress(ADDR, opts());
      await allowAddress(ADDR, { ...opts(), direction: 'out' });
      expect(isAllowedSender(ADDR)).toBe(false);
      expect(isAllowedRecipient(ADDR)).toBe(true);
    });

    it('widens back to both', async () => {
      await allowAddress(ADDR, { ...opts(), direction: 'in' });
      await allowAddress(ADDR, opts());
      expect(isAllowedSender(ADDR)).toBe(true);
      expect(isAllowedRecipient(ADDR)).toBe(true);
    });

    it('reports the asymmetry in the listing', async () => {
      await allowAddress('nur-rein@example.org', { ...opts(), direction: 'in' });
      await allowAddress('nur-raus@example.org', { ...opts(), direction: 'out' });
      const rows = listAllowedAddresses();
      expect(rows).toContainEqual({
        address: 'nur-rein@example.org',
        agentGroupId: AG,
        inbound: true,
        outbound: false,
      });
      expect(rows).toContainEqual({
        address: 'nur-raus@example.org',
        agentGroupId: AG,
        inbound: false,
        outbound: true,
      });
    });
  });

  describe('revokeAddress', () => {
    it('closes both directions', async () => {
      await allowAddress(ADDR, opts());
      expect(await revokeAddress(ADDR, opts())).toBe(true);
      expect(isAllowedSender(ADDR)).toBe(false);
      expect(isAllowedRecipient(ADDR)).toBe(false);
    });

    it('leaves no rows behind', async () => {
      await allowAddress(ADDR, opts());
      await revokeAddress(ADDR, opts());
      expect(countRows('messaging_groups')).toBe(0);
      expect(countRows('messaging_group_agents')).toBe(0);
      expect(countRows('agent_group_members')).toBe(0);
      expect(countRows('agent_destinations')).toBe(0);
    });

    it('is a no-op for an address that was never wired', async () => {
      expect(await revokeAddress('niemand@example.org', opts())).toBe(false);
    });

    it('can close just one direction', async () => {
      await allowAddress(ADDR, opts());
      await revokeAddress(ADDR, { ...opts(), direction: 'out' });
      expect(isAllowedSender(ADDR)).toBe(true);
      expect(isAllowedRecipient(ADDR)).toBe(false);
    });

    it('projects destinations into live sessions', async () => {
      await allowAddress(ADDR, opts());
      const project = vi.fn().mockResolvedValue(undefined);
      await revokeAddress(ADDR, opts(project));
      expect(project).toHaveBeenCalledWith(AG);
    });
  });

  describe('listAllowedAddresses after provisioning', () => {
    it('reports what add created', async () => {
      await allowAddress(ADDR, opts());
      expect(listAllowedAddresses()).toEqual([{ address: ADDR, agentGroupId: AG, inbound: true, outbound: true }]);
    });
  });
});

describe('resolveAgentGroup', () => {
  const groups: AgentGroup[] = [
    { id: 'ag-1', name: 'KaiL01', folder: 'kail', agent_provider: null, created_at: 'x' },
    { id: 'ag-2', name: 'Other', folder: 'other', agent_provider: null, created_at: 'x' },
  ];

  it('matches by id and by name, case-insensitively', () => {
    expect(resolveAgentGroup(groups, 'ag-2').id).toBe('ag-2');
    expect(resolveAgentGroup(groups, 'kail01').id).toBe('ag-1');
  });

  it('falls back to the only group when there is exactly one', () => {
    expect(resolveAgentGroup([groups[0]], undefined).id).toBe('ag-1');
  });

  it('refuses to guess between several groups', () => {
    expect(() => resolveAgentGroup(groups, undefined)).toThrow(/--group is required/);
  });

  it('names the known groups when the argument matches nothing', () => {
    expect(() => resolveAgentGroup(groups, 'nope')).toThrow(/KaiL01, Other/);
  });
});

function countRows(table: string): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}
