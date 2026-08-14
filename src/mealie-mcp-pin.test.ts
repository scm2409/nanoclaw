/**
 * Dependency guard for the Mealie MCP server (host/vitest tree).
 *
 * `mcp-mealie` is Martin's fork (github.com/scm2409/mcp-mealie) of a Python
 * stdio CLI, installed into the image via `uv tool install` from a git ref,
 * not an imported module — no behavior test can drive it and `tsc` never
 * sees it. The only in-tree footprint is the Dockerfile edit, so the guard
 * is structural.
 *
 * The one thing worth actually failing the build over: the fork's restricted
 * mode is unreleased (no git tag, `__version__` still 0.3.1), so the ARG
 * must pin a commit — never `main`, `HEAD`, or any other branch name. An
 * unpinned ref would let a routine image rebuild silently pick up whatever
 * `main` has become, including a build that drops or changes restricted
 * mode without anyone deciding that here.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';

function dockerfile(): string {
  const p = path.resolve(process.cwd(), 'container/Dockerfile');
  return fs.readFileSync(p, 'utf8');
}

describe('container/Dockerfile installs the mcp-mealie fork', () => {
  const text = dockerfile();

  it('pins the fork ref via an ARG to a commit SHA, not a branch', () => {
    const match = text.match(/^\s*ARG\s+MEALIE_MCP_REF=(\S+)\s*$/m);
    expect(match).not.toBeNull();
    const ref = match![1];
    // 7+ hex chars (short or full SHA) or a semver-ish tag (v0.3.2, 0.3.2).
    // Explicitly not `main`, `master`, `HEAD`, or any other bare branch name.
    const looksPinned = /^[0-9a-f]{7,40}$/i.test(ref) || /^v?\d+\.\d+\.\d+/.test(ref);
    expect(looksPinned).toBe(true);
    expect(ref).not.toMatch(/^(main|master|HEAD)$/i);
  });

  it('installs from the fork, pinned to that ARG, via uv tool install', () => {
    const installsServer =
      /uv\s+tool\s+install[\s\S]*?git\+https:\/\/github\.com\/scm2409\/mcp-mealie@\$\{MEALIE_MCP_REF\}/.test(text);
    expect(installsServer).toBe(true);
  });

  it('keeps the uv tool tree outside root-only paths so the node user can run it', () => {
    // Same redirect nextcloud-mcp-server needs; must already be in place
    // before this install line for the binary to end up readable.
    expect(text).toMatch(/^\s*ENV\s+UV_TOOL_DIR=\/opt\/uv\//m);
    expect(text).toMatch(/UV_PYTHON_INSTALL_DIR=\/opt\/uv\//);
  });
});
