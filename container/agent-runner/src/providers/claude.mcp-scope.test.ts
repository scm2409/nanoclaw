import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// An MCP server's tool schemas ride along on EVERY API call of the thread that
// holds it. Nextcloud's 63 tools are ~39k tokens — ~60% of a turn — spent even
// on turns that never touch Nextcloud. So a server can be marked
// `subagentOnly` in container.json and handed to a subagent instead.
//
// Verified empirically against claude-agent-sdk 0.3.197 / claude-code 2.1.197
// by logging the `tools` array actually sent per thread:
//
//   - Top-level `disallowedTools: ['mcp__x__*']` DOES strip the schemas from the
//     main thread's request — but it strips them from the subagent's request
//     too, even when the subagent claims the server. So that route is dead.
//   - Declaring the server ONLY in `AgentDefinition.mcpServers` works: main
//     thread 0 tools, subagent all of them, tool calls execute, and the server
//     process is not spawned until the subagent is invoked.
//   - The Record form is mandatory. A bare string in `AgentDefinition.mcpServers`
//     resolves against the on-disk MCP config, not against the `mcpServers` we
//     pass programmatically, so it silently resolves to nothing.

let capturedOptions: Record<string, unknown> | null = null;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options: Record<string, unknown> }) => {
    capturedOptions = args.options;
    const gen = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
      yield { type: 'result', subtype: 'success', result: null };
    })();
    (gen as unknown as { supportedAgents: () => Promise<unknown> }).supportedAgents = async () => [];
    return gen;
  },
}));

const { ClaudeProvider } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

let tmp: string;
let prevHome: string | undefined;

const NEXTCLOUD = { command: 'nextcloud-mcp-server', args: ['run'], env: { HOST: 'x' }, subagentOnly: true };
const SHARED = { command: 'shared-mcp-server', args: [], env: {} };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-mcp-scope-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
  capturedOptions = null;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeAgentFile(name: string, frontmatter: string): void {
  const dir = path.join(tmp, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), `---\n${frontmatter}\n---\n\nBody.\n`);
}

async function runQuery(mcpServers: Record<string, unknown>): Promise<Record<string, unknown>> {
  const provider = new ClaudeProvider({ mcpServers: mcpServers as never });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = provider.query({ prompt: 'hi', cwd: tmp });
  for await (const _ of q.events) {
    /* drain */
  }
  if (!capturedOptions) throw new Error('SDK query was never called');
  return capturedOptions;
}

describe('subagent-only MCP servers', () => {
  it('withholds a subagentOnly server from the main thread and inlines it into the claiming subagent', async () => {
    writeAgentFile('nextcloud', 'description: Runs Nextcloud operations.\nmcpServers: [nextcloud]');

    const options = await runQuery({ nextcloud: NEXTCLOUD, shared: SHARED });

    // Main thread: shared only. This is where the ~39k tokens are saved.
    expect(Object.keys(options.mcpServers as object)).toEqual(['shared']);

    // Subagent: the withheld server, as a Record (never a bare string).
    const agents = options.agents as Record<string, { mcpServers?: unknown[] }>;
    expect(agents.nextcloud!.mcpServers).toEqual([{ nextcloud: NEXTCLOUD }]);
  });

  it('keeps the allow pattern for a withheld server so the subagent may call it', async () => {
    writeAgentFile('nextcloud', 'description: Runs Nextcloud operations.\nmcpServers: [nextcloud]');

    const options = await runQuery({ nextcloud: NEXTCLOUD, shared: SHARED });

    // An allow pattern does NOT pull the tools back into the main thread — it
    // only keeps the subagent's calls from being permission-blocked.
    expect(options.allowedTools).toContain('mcp__nextcloud__*');
    expect(options.allowedTools).toContain('mcp__shared__*');
  });

  it('leaves unflagged servers top-level and does not hand them to subagents', async () => {
    writeAgentFile('nextcloud', 'description: Runs Nextcloud operations.\nmcpServers: [nextcloud]');

    const options = await runQuery({ nextcloud: { ...NEXTCLOUD, subagentOnly: false }, shared: SHARED });

    expect(Object.keys(options.mcpServers as object).sort()).toEqual(['nextcloud', 'shared']);
    const agents = options.agents as Record<string, { mcpServers?: unknown[] }>;
    expect(agents.nextcloud!.mcpServers).toEqual([{ nextcloud: { ...NEXTCLOUD, subagentOnly: false } }]);
  });

  it('passes the subagent skills preload through to the agent definition', async () => {
    writeAgentFile(
      'nextcloud',
      'description: Runs Nextcloud operations.\nmcpServers: [nextcloud]\nskills: [nextcloud-deck-workflow]',
    );

    const options = await runQuery({ nextcloud: NEXTCLOUD });
    const agents = options.agents as Record<string, { skills?: string[] }>;

    expect(agents.nextcloud!.skills).toEqual(['nextcloud-deck-workflow']);
  });

  it('drops a claim for an unknown server rather than passing an undefined entry', async () => {
    writeAgentFile('nextcloud', 'description: Runs Nextcloud operations.\nmcpServers: [typo-name]');

    const options = await runQuery({ nextcloud: NEXTCLOUD });
    const agents = options.agents as Record<string, { mcpServers?: unknown[] }>;

    expect(agents.nextcloud!.mcpServers).toBeUndefined();
  });

  it('leaves the main thread untouched when no subagent files exist', async () => {
    const options = await runQuery({ shared: SHARED });

    expect(Object.keys(options.mcpServers as object)).toEqual(['shared']);
    expect(options.agents).toBeUndefined();
  });
});
