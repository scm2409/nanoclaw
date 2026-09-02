import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { openContainerLog, pruneContainerLogs, containerLogDir } from './container-logs.js';

let baseDir: string;

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-container-logs-'));
});

afterEach(() => {
  fs.rmSync(baseDir, { recursive: true, force: true });
});

function filesFor(sessionId: string): string[] {
  const dir = containerLogDir(sessionId, baseDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort();
}

describe('openContainerLog', () => {
  it('persists every written line to a file under the session directory', () => {
    const w = openContainerLog('sess-1', 'nanoclaw-v2-main-agent-1', { baseDir });
    expect(w).not.toBeNull();
    w!.write('[agent-runner] Additional MCP server: dokuwiki (mcp-remote)');
    w!.write('[poll-loop] Error: API Error: 400 Provider returned error');
    w!.close('exit code 137');

    const files = filesFor('sess-1');
    expect(files).toHaveLength(1);
    const body = fs.readFileSync(path.join(containerLogDir('sess-1', baseDir), files[0]), 'utf8');
    expect(body).toContain('Additional MCP server: dokuwiki');
    expect(body).toContain('API Error: 400 Provider returned error');
    expect(body).toContain('exit code 137');
  });

  it('writes a header naming the session and the container', () => {
    const w = openContainerLog('sess-1', 'nanoclaw-v2-main-agent-42', { baseDir });
    w!.close();
    const body = fs.readFileSync(w!.path, 'utf8');
    expect(body).toContain('sess-1');
    expect(body).toContain('nanoclaw-v2-main-agent-42');
  });

  it('keeps the whole line — long provider error bodies are not truncated', () => {
    // The failure this exists for: `error.metadata.raw` carries the decisive
    // detail and is far longer than any tail-line budget.
    const long = 'API Error: 400 ' + 'x'.repeat(20_000);
    const w = openContainerLog('sess-1', 'c1', { baseDir });
    w!.write(long);
    w!.close();
    expect(fs.readFileSync(w!.path, 'utf8')).toContain(long);
  });

  it('stops at the byte cap and records that it truncated, exactly once', () => {
    const w = openContainerLog('sess-1', 'c1', { baseDir, maxBytes: 200 });
    for (let i = 0; i < 50; i++) w!.write(`line ${i} ${'y'.repeat(50)}`);
    w!.close();

    const body = fs.readFileSync(w!.path, 'utf8');
    expect(body.length).toBeLessThan(2000);
    expect(body.match(/log truncated/g)).toHaveLength(1);
  });

  it('refuses a session id that would escape the log directory', () => {
    expect(openContainerLog('../../etc', 'c1', { baseDir })).toBeNull();
    expect(openContainerLog('a/b', 'c1', { baseDir })).toBeNull();
    expect(fs.readdirSync(baseDir)).toHaveLength(0);
  });

  it('returns null instead of throwing when the directory cannot be created', () => {
    const blocked = path.join(baseDir, 'blocked');
    fs.writeFileSync(blocked, 'not a directory');
    expect(openContainerLog('sess-1', 'c1', { baseDir: blocked })).toBeNull();
  });

  it('writing after close does not throw', () => {
    const w = openContainerLog('sess-1', 'c1', { baseDir });
    w!.close();
    expect(() => w!.write('late line')).not.toThrow();
  });
});

describe('pruneContainerLogs', () => {
  function seed(sessionId: string, names: string[], ageMs = 0): void {
    const dir = containerLogDir(sessionId, baseDir);
    fs.mkdirSync(dir, { recursive: true });
    for (const n of names) {
      const p = path.join(dir, n);
      fs.writeFileSync(p, 'x');
      if (ageMs) {
        const t = new Date(Date.now() - ageMs);
        fs.utimesSync(p, t, t);
      }
    }
  }

  it('keeps the newest N files and deletes the rest', () => {
    seed('sess-1', ['a.log', 'b.log', 'c.log', 'd.log', 'e.log']);
    // Distinct mtimes so "newest" is well defined.
    const dir = containerLogDir('sess-1', baseDir);
    ['a.log', 'b.log', 'c.log', 'd.log', 'e.log'].forEach((n, i) => {
      const t = new Date(Date.now() - (5 - i) * 60_000);
      fs.utimesSync(path.join(dir, n), t, t);
    });

    pruneContainerLogs('sess-1', { baseDir, keep: 2, maxAgeMs: Infinity });
    expect(filesFor('sess-1')).toEqual(['d.log', 'e.log']);
  });

  it('deletes files older than the age limit even when under the keep count', () => {
    seed('sess-1', ['old.log'], 10 * 24 * 60 * 60 * 1000);
    seed('sess-1', ['fresh.log']);
    pruneContainerLogs('sess-1', { baseDir, keep: 50, maxAgeMs: 7 * 24 * 60 * 60 * 1000 });
    expect(filesFor('sess-1')).toEqual(['fresh.log']);
  });

  it('leaves other sessions alone', () => {
    seed('sess-1', ['a.log', 'b.log']);
    seed('sess-2', ['a.log', 'b.log']);
    pruneContainerLogs('sess-1', { baseDir, keep: 1, maxAgeMs: Infinity });
    expect(filesFor('sess-2')).toHaveLength(2);
  });

  it('does not throw on a session that has no log directory yet', () => {
    expect(() => pruneContainerLogs('never-ran', { baseDir })).not.toThrow();
  });
});
