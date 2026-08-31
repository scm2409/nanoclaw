/**
 * Dependency guard for the Nextcloud MCP server (host/vitest tree).
 *
 * `nextcloud-mcp-server` is a Python stdio CLI installed into the image via
 * `uv tool install`, not an imported module, so no behavior test can drive it
 * and `tsc` never sees it. The only in-tree footprint of this skill is the
 * Dockerfile edit, so the guard is structural: assert the pinned ARGs, the uv
 * binary copy, and the pinned `uv tool install` line all exist. Drop any of
 * the Phase 3 Dockerfile edits and this goes red.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';

function dockerfile(): string {
  const p = path.resolve(process.cwd(), 'container/Dockerfile');
  return fs.readFileSync(p, 'utf8');
}

describe('container/Dockerfile installs nextcloud-mcp-server', () => {
  const text = dockerfile();

  it('pins the server version via an ARG', () => {
    expect(text).toMatch(/^\s*ARG\s+NEXTCLOUD_MCP_VERSION=\d+\.\d+\.\d+\s*$/m);
  });

  it('pins the uv version via an ARG', () => {
    expect(text).toMatch(/^\s*ARG\s+UV_VERSION=\d+\.\d+\.\d+\s*$/m);
  });

  it('pulls the pinned uv image in as a stage and copies the binary out of it', () => {
    expect(text).toMatch(/^FROM\s+ghcr\.io\/astral-sh\/uv:\$\{UV_VERSION\}\s+AS\s+uvbin\s*$/m);
    expect(text).toMatch(/COPY\s+--from=uvbin\s+\/uv\s/);
  });

  it('installs the package pinned to that ARG via uv tool install', () => {
    // Tolerate line continuations between `uv tool install` and the package spec.
    const installsServer = /uv\s+tool\s+install[\s\S]*?nextcloud-mcp-server==\$\{NEXTCLOUD_MCP_VERSION\}/.test(text);
    expect(installsServer).toBe(true);
  });

  it('pins importlib_metadata alongside the server', () => {
    // nextcloud-mcp-server imports the `importlib_metadata` backport in
    // observability/tracing.py without declaring it as a dependency — it used
    // to arrive transitively via opentelemetry-api. opentelemetry-api 1.44.0
    // dropped it (py3.12 has importlib.metadata in the stdlib), so a rebuild
    // re-resolved the floating transitive deps without it and every server
    // spawn died at import with ModuleNotFoundError. The ARG pin only covers
    // the top-level package, so the backport needs its own pin.
    expect(text).toMatch(/^\s*ARG\s+IMPORTLIB_METADATA_VERSION=\d+\.\d+\.\d+\s*$/m);
    const withBackport =
      /uv\s+tool\s+install[\s\S]*?--with\s+"importlib_metadata==\$\{IMPORTLIB_METADATA_VERSION\}"/.test(text);
    expect(withBackport).toBe(true);
  });

  it('installs the httpx env-proxy shim into the server venv', () => {
    // Without it, the server's explicitly-built httpx transport bypasses
    // HTTPS_PROXY, so those calls never reach the OneCLI gateway and arrive
    // upstream holding the credential placeholder.
    expect(text).toMatch(/COPY\s+httpx-env-proxy-shim\.py\s/);
    expect(text).toMatch(/site-packages\)\/sitecustomize\.py/);
    expect(fs.existsSync(path.resolve(process.cwd(), 'container/httpx-env-proxy-shim.py'))).toBe(true);
  });

  it('keeps the uv tool tree outside root-only paths so the node user can run it', () => {
    // uv defaults to ~/.local/share/uv (i.e. /root/... at build time), which the
    // non-root runtime user cannot read. Both dirs must be redirected.
    expect(text).toMatch(/^\s*ENV\s+UV_TOOL_DIR=\/opt\/uv\//m);
    expect(text).toMatch(/UV_PYTHON_INSTALL_DIR=\/opt\/uv\//);
  });
});
