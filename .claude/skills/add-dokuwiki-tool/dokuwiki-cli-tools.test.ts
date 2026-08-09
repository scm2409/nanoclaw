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
});
