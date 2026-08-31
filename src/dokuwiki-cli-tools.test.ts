/**
 * Dependency guard for the DokuWiki MCP bridge (host/vitest tree).
 *
 * `mcp-remote` is a stdio<->HTTP bridge installed as a global Node CLI via
 * `container/cli-tools.json` (a json-merge, no Dockerfile edit), so no
 * behavior test can drive it and `tsc` never sees it. The only in-tree
 * footprint of this skill is the manifest entry, so the guard is structural:
 * assert it's present and pinned to an exact version. Drop the entry and
 * this goes red.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';

function cliTools(): Array<{ name: string; version: string }> {
  const p = path.resolve(process.cwd(), 'container/cli-tools.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
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

const rangedTools = [
  'plugin_reviewqueue_getPageOutline',
  'plugin_reviewqueue_getSection',
  'plugin_reviewqueue_getLines',
  'plugin_reviewqueue_findInPage',
  'plugin_reviewqueue_searchWithContext',
  'plugin_reviewqueue_replaceSection',
  'plugin_reviewqueue_insertSection',
  'plugin_reviewqueue_deleteSection',
  'plugin_reviewqueue_replaceLines',
  'plugin_reviewqueue_replaceText',
  'plugin_reviewqueue_updatePendingChange',
  'plugin_reviewqueue_withdrawPendingChange',
];

describe('DokuWiki large-page guidance', () => {
  it('documents every ranged read and targeted write tool', () => {
    const skillFiles = [
      'container/skills/dokuwiki-reviewqueue/SKILL.md',
      '.claude/skills/add-dokuwiki-tool/container-skills/dokuwiki-reviewqueue/SKILL.md',
    ];

    for (const file of skillFiles) {
      const content = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
      for (const tool of rangedTools) {
        expect(content, `${file} missing ${tool}`).toContain(tool);
      }
    }

    const agent = fs.readFileSync(path.resolve(process.cwd(), 'groups/main-agent/.claude/agents/dokuwiki.md'), 'utf8');
    for (const tool of rangedTools) {
      expect(agent, `subagent guidance missing ${tool}`).toContain(tool);
    }
  });
});
