import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { probeMcpServer, probeMcpServers } from './mcp-health.js';

let dir: string;

/** A minimal stdio MCP server that answers initialize + tools/list. */
const HEALTHY = `
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1' } },
      }) + '\\n');
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: { tools: [{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }] },
      }) + '\\n');
    }
  }
});
`;

/** Dies at import the way nextcloud-mcp-server did with a missing backport. */
const CRASHER = `
process.stderr.write("ModuleNotFoundError: No module named 'importlib_metadata'\\n");
process.exit(1);
`;

/** Starts, handshakes, then never answers tools/list. */
const HANGER = `
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
    }
  }
});
setTimeout(() => {}, 60_000);
`;

function server(file: string) {
  return { command: process.execPath, args: [path.join(dir, file)], env: {} };
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-health-'));
  fs.writeFileSync(path.join(dir, 'healthy.js'), HEALTHY);
  fs.writeFileSync(path.join(dir, 'crasher.js'), CRASHER);
  fs.writeFileSync(path.join(dir, 'hanger.js'), HANGER);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('probeMcpServer', () => {
  it('reports the tool count for a server that handshakes', async () => {
    const r = await probeMcpServer('healthy', server('healthy.js'), { timeoutMs: 10_000 });
    expect(r.ok).toBe(true);
    expect(r.toolCount).toBe(3);
    expect(r.name).toBe('healthy');
  });

  it('reports a server that dies at startup, carrying its stderr', async () => {
    const r = await probeMcpServer('crasher', server('crasher.js'), { timeoutMs: 10_000 });
    expect(r.ok).toBe(false);
    // The decisive line has to survive into the result, or the operator is
    // left guessing exactly the way this bug went unnoticed for hours.
    expect(r.error).toContain('importlib_metadata');
  });

  it('reports a server that never answers as a timeout rather than hanging', async () => {
    const r = await probeMcpServer('hanger', server('hanger.js'), { timeoutMs: 1_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out/i);
  });

  it('reports a command that does not exist', async () => {
    const r = await probeMcpServer(
      'missing',
      { command: '/nonexistent/definitely-not-here', args: [], env: {} },
      { timeoutMs: 5_000 },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

describe('probeMcpServers', () => {
  it('probes every server and keeps one failure from masking the others', async () => {
    const results = await probeMcpServers(
      { healthy: server('healthy.js'), crasher: server('crasher.js') },
      { timeoutMs: 10_000 },
    );
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));
    expect(byName.healthy.ok).toBe(true);
    expect(byName.crasher.ok).toBe(false);
    expect(results).toHaveLength(2);
  });
});
