/**
 * Guards for the DokuWiki MCP bridge (host/vitest tree).
 *
 * Two things are guarded here, both structural — there is no way to drive the
 * remote wiki from a unit test:
 *
 * 1. `mcp-remote` is a stdio<->HTTP bridge installed as a global Node CLI via
 *    `container/cli-tools.json` (a json-merge, no Dockerfile edit), so `tsc`
 *    never sees it. Assert the manifest entry is present and pinned.
 * 2. The documentation the subagent actually runs on must name the tools the
 *    reviewqueue plugin's own MCP endpoint exposes, and must not name the ones
 *    it removed. The capability allowlist (ADR-0007) dropped `core.getPage`,
 *    `core.savePage` and `core.appendPage`; guidance still mentioning them
 *    sends the subagent at tools that do not exist.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';

function cliTools(): Array<{ name: string; version: string }> {
  const p = path.resolve(process.cwd(), 'container/cli-tools.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function read(file: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
}

describe('container/cli-tools.json installs mcp-remote', () => {
  it('is present, pinned to an exact semver', () => {
    const tool = cliTools().find((t) => t.name === 'mcp-remote');
    expect(tool).toBeDefined();
    expect(tool!.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('uses a release compatible with the current DokuWiki MCP API', () => {
    const tool = cliTools().find((t) => t.name === 'mcp-remote');
    expect(tool?.version).toBe('0.1.45');
  });
});

/** Every tool the reviewqueue MCP endpoint exposes that guidance must cover. */
const exposedTools = [
  'core_whoAmI',
  'core_listPages',
  'core_searchPages',
  'plugin_reviewqueue_getPageToEdit',
  'plugin_reviewqueue_listMyPending',
  'plugin_reviewqueue_searchMyPending',
  'plugin_reviewqueue_getStatus',
  'plugin_reviewqueue_getPendingText',
  'plugin_reviewqueue_updatePendingChange',
  'plugin_reviewqueue_withdrawPendingChange',
  'plugin_reviewqueue_getPageOutline',
  'plugin_reviewqueue_getSection',
  'plugin_reviewqueue_getLines',
  'plugin_reviewqueue_findInPage',
  'plugin_reviewqueue_searchWithContext',
  'plugin_reviewqueue_createPage',
  'plugin_reviewqueue_deletePage',
  'plugin_reviewqueue_replaceSection',
  'plugin_reviewqueue_insertSection',
  'plugin_reviewqueue_deleteSection',
  'plugin_reviewqueue_replaceLines',
  'plugin_reviewqueue_replaceText',
];

/** Removed by the capability allowlist, plus the obsolete dotted spelling. */
const removedTools = [
  'core.getPage',
  'core_getPage',
  'core.savePage',
  'core_savePage',
  'core.appendPage',
  'core_appendPage',
  'core.searchPages',
  'core.listPages',
  'plugin.reviewqueue.',
];

/**
 * The subset the subagent itself must name. It starts cold on every order and
 * delegates the full contract to the skill, so it does not need to restate the
 * whole inventory — but it must not send the caller at a tool that is gone.
 */
const subagentTools = exposedTools.filter((t) => t !== 'core_whoAmI' && t !== 'core_listPages');

const skillFiles = [
  'container/skills/dokuwiki-reviewqueue/SKILL.md',
  '.claude/skills/add-dokuwiki-tool/container-skills/dokuwiki-reviewqueue/SKILL.md',
];

const guidanceFiles = [...skillFiles, 'groups/main-agent/.claude/agents/dokuwiki.md'];

describe('DokuWiki guidance matches the reviewqueue MCP endpoint', () => {
  it('documents every exposed tool in the container skill', () => {
    for (const file of skillFiles) {
      const content = read(file);
      for (const tool of exposedTools) {
        expect(content, `${file} missing ${tool}`).toContain(tool);
      }
    }
  });

  it('names the read and write tools in the subagent guidance', () => {
    const agent = read('groups/main-agent/.claude/agents/dokuwiki.md');
    for (const tool of subagentTools) {
      expect(agent, `subagent guidance missing ${tool}`).toContain(tool);
    }
  });

  // Only the agent-facing guidance. The install skill legitimately names the
  // removed tools, in the check that they are absent from the endpoint.
  it('names no tool the capability allowlist removed', () => {
    for (const file of guidanceFiles) {
      const content = read(file);
      for (const tool of removedTools) {
        expect(content, `${file} still names removed ${tool}`).not.toContain(tool);
      }
    }
  });

  it('keeps the skill source and the installed container skill identical', () => {
    expect(read('container/skills/dokuwiki-reviewqueue/SKILL.md')).toBe(
      read('.claude/skills/add-dokuwiki-tool/container-skills/dokuwiki-reviewqueue/SKILL.md'),
    );
  });
});

describe('DokuWiki install skill targets the reviewqueue endpoint', () => {
  it('uses the plugin own MCP endpoint, not the removed splitbrain one', () => {
    const content = read('.claude/skills/add-dokuwiki-tool/SKILL.md');
    expect(content).toContain('/lib/plugins/reviewqueue/mcp.php');

    // The old endpoint may still be named, but only where the skill checks that
    // it is gone — never as something the bridge is pointed at.
    const stale = content
      .split('\n')
      .filter((line) => line.includes('/lib/plugins/mcp/mcp.php'))
      .filter((line) => !line.includes('%{http_code}'));
    expect(stale, 'splitbrain endpoint still wired somewhere').toEqual([]);
  });
});
