/**
 * Flag-level SDK options that Claude Code 2.1.267+ needs from us.
 *
 * - The system-prompt append (agent name + destinations) is rebuilt at every
 *   container start. Since 2.1.267 Claude Code records a session's system
 *   prompt on its first request and resends that record on every resume, so
 *   without `snapshot: false` a resumed session keeps its old name and
 *   destination list until compaction.
 * - Since 2.1.275 Claude Code syncs the skills and plugins enabled on a
 *   signed-in claude.ai account into terminal sessions. An agent gets the
 *   skills NanoClaw mounts, never the operator's own, so both syncs are off.
 *
 * Ported from upstream nanocoai/nanoclaw ee0f0adf.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lastOptions: any;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: (args: any) => {
    lastOptions = args.options;
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-sp' };
      yield { type: 'result', subtype: 'success', result: 'ok' };
    })();
  },
}));

const { ClaudeProvider } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  lastOptions = undefined;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sysprompt-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function drive(instructions: string, continuation?: string): Promise<void> {
  const provider = new ClaudeProvider({});
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = provider.query({ prompt: 'hi', cwd: tmp, continuation, systemContext: { instructions } });
  for await (const _ of q.events) {
    // drain
  }
}

describe('system prompt append', () => {
  it('is never recorded, so a resume renders the current append', async () => {
    const append = '# You are Ada\n\n## Sending messages\n\n- ops-log';
    await drive(append, 'sess-earlier');
    expect(lastOptions?.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append,
      snapshot: false,
    });
  });
});

describe('claude.ai skill and plugin sync', () => {
  it('is switched off for every session', async () => {
    await drive('# You are Ada');
    expect(lastOptions?.settings).toEqual({ syncClaudeAiSkills: false, syncClaudeAiPlugins: false });
  });
});
