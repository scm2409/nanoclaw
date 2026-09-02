/**
 * Persisted per-container stderr logs.
 *
 * Containers run with `--rm`, so everything a container printed is gone the
 * moment it exits. The only survivor was `stderrTail` — the last ten lines,
 * logged once on a non-zero exit. That is enough to see *that* a container
 * died and almost never enough to see *why*.
 *
 * The failure that motivated this: a subagent failed for two days with
 * `API Error: 400 Provider returned error`. The decisive detail — the
 * provider's own `error.metadata.raw`, naming the exact tool schema field it
 * rejected — was printed by the container and then discarded, because it was
 * neither in the last ten lines nor short enough to survive a tail. The
 * diagnosis took four live probes that would have been one `grep` against
 * these files.
 *
 * Design: append-only, one file per container instance, byte-capped so a
 * runaway container can't fill the disk, pruned per session so a task series
 * waking hourly doesn't accumulate forever. Diagnostics must never break a
 * spawn, so every function here swallows its own errors and degrades to
 * "no log written".
 */
import fs from 'fs';
import path from 'path';

import { LOGS_DIR } from './config.js';
import { log } from './log.js';

/** Per-file cap. A container that loops on output can't fill the disk. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
/** Files kept per session, newest first. An hourly task series rolls over in ~a day. */
const DEFAULT_KEEP = 24;
/** Age cutoff, applied on top of the keep count. */
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const CONTAINER_LOGS_ENABLED = process.env.CONTAINER_LOGS !== 'off';

export interface ContainerLogOptions {
  /** Root under which `containers/<sessionId>/` is created. Defaults to `logs/`. */
  baseDir?: string;
  maxBytes?: number;
}

export interface PruneOptions {
  baseDir?: string;
  keep?: number;
  /** `Infinity` disables the age rule and prunes by count only. */
  maxAgeMs?: number;
}

export interface ContainerLogWriter {
  /** Absolute path of the file being written. */
  path: string;
  /** Append one line. No-op after `close`, or once the byte cap is hit. */
  write(line: string): void;
  /** Append an optional final line and release the handle. Idempotent. */
  close(footer?: string): void;
}

/**
 * Session ids are generated (`sess-<ms>-<rand>`) but reach us through the DB,
 * so treat them as untrusted for path building: a charset guard is the
 * boundary, exactly as `appendRunLog` does for task ids.
 */
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && id !== '..';
}

/** Directory holding one session's container logs. */
export function containerLogDir(sessionId: string, baseDir: string = LOGS_DIR): string {
  return path.join(baseDir, 'containers', sessionId);
}

/** Filesystem-safe, sortable stamp: 2026-09-01T14-32-05-118Z. */
function fileStamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * Open a log file for one container instance. Returns `null` — never throws —
 * when logging is disabled, the id is unsafe, or the file can't be created;
 * the caller carries on without a log rather than failing the spawn.
 */
export function openContainerLog(
  sessionId: string,
  containerName: string,
  opts: ContainerLogOptions = {},
): ContainerLogWriter | null {
  if (!CONTAINER_LOGS_ENABLED) return null;
  if (!isSafeId(sessionId)) {
    log.warn('Refusing to write a container log for an unsafe session id', { sessionId });
    return null;
  }

  const maxBytes = opts.maxBytes ?? envInt('CONTAINER_LOG_MAX_BYTES', DEFAULT_MAX_BYTES);
  const dir = containerLogDir(sessionId, opts.baseDir ?? LOGS_DIR);
  const safeContainer = containerName.replace(/[^A-Za-z0-9._-]/g, '_');
  const file = path.join(dir, `${fileStamp(new Date())}-${safeContainer}.log`);

  let fd: number;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fd = fs.openSync(file, 'a');
  } catch (err) {
    log.warn('Could not open container log', { sessionId, file, err });
    return null;
  }

  let written = 0;
  let closed = false;
  let truncated = false;

  function append(text: string): void {
    try {
      fs.writeSync(fd, text);
      written += Buffer.byteLength(text);
    } catch {
      // A failed write means this log is unusable. Give up on it silently —
      // logging here would fire once per stderr line.
      closed = true;
    }
  }

  append(`# container ${containerName}\n# session ${sessionId}\n# started ${new Date().toISOString()}\n`);

  return {
    path: file,
    write(line: string): void {
      if (closed || truncated) return;
      if (written >= maxBytes) {
        truncated = true;
        append(`# log truncated at ${maxBytes} bytes — raise CONTAINER_LOG_MAX_BYTES to keep more\n`);
        return;
      }
      append(`${line}\n`);
    },
    close(footer?: string): void {
      if (closed) return;
      if (footer && !truncated) append(`# ${footer}\n`);
      closed = true;
      try {
        fs.closeSync(fd);
      } catch {
        /* already gone */
      }
    },
  };
}

/**
 * Drop old container logs for one session: keep the newest `keep` files, then
 * drop anything older than `maxAgeMs`. Called on spawn, so the cost is one
 * `readdir` per container start and no separate timer.
 */
export function pruneContainerLogs(sessionId: string, opts: PruneOptions = {}): void {
  if (!isSafeId(sessionId)) return;
  const dir = containerLogDir(sessionId, opts.baseDir ?? LOGS_DIR);
  const keep = opts.keep ?? envInt('CONTAINER_LOG_KEEP_PER_SESSION', DEFAULT_KEEP);
  const maxAgeMs = opts.maxAgeMs ?? envInt('CONTAINER_LOG_MAX_AGE_DAYS', DEFAULT_MAX_AGE_MS / 86_400_000) * 86_400_000;

  let entries: { name: string; mtimeMs: number }[];
  try {
    entries = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.log'))
      .map((name) => {
        try {
          return { name, mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs };
        } catch {
          return { name, mtimeMs: 0 };
        }
      });
  } catch {
    return; // no directory yet — nothing to prune
  }

  entries.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
  const cutoff = Number.isFinite(maxAgeMs) ? Date.now() - maxAgeMs : -Infinity;

  for (const [i, e] of entries.entries()) {
    if (i < keep && e.mtimeMs >= cutoff) continue;
    try {
      fs.rmSync(path.join(dir, e.name), { force: true });
    } catch {
      /* best effort */
    }
  }
}
