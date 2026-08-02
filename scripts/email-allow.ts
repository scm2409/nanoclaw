/**
 * CLI over src/channels/email-provisioning.ts — manage which addresses the
 * email channel may receive from and send to.
 *
 *   pnpm exec tsx scripts/email-allow.ts list
 *   pnpm exec tsx scripts/email-allow.ts add <address> [--direction in|out|both] [--name "…"] [--group <id-or-name>]
 *   pnpm exec tsx scripts/email-allow.ts remove <address> [--direction in|out|both] [--group <id-or-name>]
 *
 * --direction defaults to `both`. `in` = they may write to the agent, `out` =
 * the agent may write to them; the two are separate decisions and an
 * asymmetric setup is normal. Re-running `add` with a narrower direction
 * closes the other half (declarative, not additive).
 *
 * --group may be omitted when the install has exactly one agent group.
 *
 * Safe to run while the service is up (WAL-mode sqlite): destination changes
 * are projected into every live session, so a running container sees a new
 * recipient without waiting for its next wake.
 */
import path from 'path';

import {
  allowAddress,
  resolveAgentGroup,
  revokeAddress,
  type AllowDirection,
} from '../src/channels/email-provisioning.js';
import { listAllowedAddresses } from '../src/channels/email-allowlist.js';
import { DATA_DIR } from '../src/config.js';
import { getAllAgentGroups } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';

const USAGE =
  'Usage: email-allow.ts <list|add|remove> [address] [--direction in|out|both] ' +
  '[--name "Display Name"] [--group <id-or-name>]';

interface Args {
  command: 'list' | 'add' | 'remove';
  address?: string;
  displayName?: string;
  group?: string;
  direction?: AllowDirection;
}

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  if (command !== 'list' && command !== 'add' && command !== 'remove') {
    console.error(USAGE);
    process.exit(2);
  }

  const out: Args = { command };
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (key === '--name') {
      out.displayName = rest[++i];
    } else if (key === '--group') {
      out.group = rest[++i];
    } else if (key === '--direction') {
      const value = rest[++i];
      if (value !== 'in' && value !== 'out' && value !== 'both') {
        console.error(`Invalid --direction: ${value} (expected 'in', 'out' or 'both')`);
        process.exit(2);
      }
      out.direction = value;
    } else if (!key.startsWith('--') && !out.address) {
      out.address = key;
    }
  }

  if ((command === 'add' || command === 'remove') && !out.address) {
    console.error(`email-allow.ts ${command} needs an address`);
    process.exit(2);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  runMigrations(initDb(path.join(DATA_DIR, 'v2.db')));

  if (args.command === 'list') {
    const rows = listAllowedAddresses();
    if (rows.length === 0) {
      console.log('No email addresses are wired.');
      return;
    }
    console.log('receive  send   address');
    for (const row of rows) {
      const flags = `${row.inbound ? '   yes' : '    no'}  ${row.outbound ? ' yes' : '  no'}`;
      console.log(`${flags}   ${row.address}  (${row.agentGroupId ?? 'not wired'})`);
    }
    return;
  }

  const group = resolveAgentGroup(getAllAgentGroups(), args.group);
  const direction = args.direction ?? 'both';
  const label = direction === 'both' ? 'receive + send' : direction === 'in' ? 'receive only' : 'send only';

  if (args.command === 'add') {
    const result = await allowAddress(args.address!, {
      displayName: args.displayName,
      agentGroupId: group.id,
      agentGroupName: group.name,
      direction,
    });
    console.log(`${result.address} for ${group.name}: ${label}.`);
    return;
  }

  const removed = await revokeAddress(args.address!, { agentGroupId: group.id, direction });
  console.log(
    removed
      ? `Revoked ${direction === 'both' ? 'both directions' : label} for ${args.address} (${group.name}).`
      : `${args.address} was not wired; nothing to do.`,
  );
}

// Only run when invoked directly, so the exported functions stay importable.
if (process.argv[1] && process.argv[1].endsWith('email-allow.ts')) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
