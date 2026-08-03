import fs from 'fs';
import path from 'path';

import { log } from './log.js';

/** Per-group standing instructions prepended to every provider's project document. */
export const PERSONA_PREPEND_FILE = 'instructions.prepend.md';

/**
 * Per-group install-specific facts (board names, mailboxes, calendars — anything
 * naming this particular install). Composed into the project document like the
 * persona, but gitignored by default: `groups/*` in `.gitignore` only re-includes
 * `instructions.prepend.md`. This is what lets a tracked, shareable skill stay
 * free of personal names and refer to "your local facts" instead.
 */
export const LOCAL_FACTS_FILE = 'instructions.local.md';

/**
 * Create a group's standing instructions without following or replacing an
 * existing path. Returns false when the content is empty or the path exists.
 */
export function stageGroupPersona(groupDir: string, instructions: string): boolean {
  const content = instructions.trimEnd();
  if (!content.trim()) return false;

  fs.mkdirSync(groupDir, { recursive: true });
  try {
    fs.writeFileSync(path.join(groupDir, PERSONA_PREPEND_FILE), `${content}\n`, { flag: 'wx' });
    return true;
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'EEXIST') return false;
    throw err;
  }
}

/** Read a group document without following symlinks. */
function readGroupDoc(groupDir: string, fileName: string, warning: string): string | null {
  const file = path.join(groupDir, fileName);
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(fd).isFile()) return null;
    const content = fs.readFileSync(fd, 'utf-8').trim();
    return content || null;
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') return null;
    log.warn(warning, {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Read a group's standing instructions without following symlinks. */
export function readGroupPersona(groupDir: string): string | null {
  return readGroupDoc(groupDir, PERSONA_PREPEND_FILE, 'Could not read group standing instructions; omitting persona');
}

/** Read a group's install-specific facts without following symlinks. */
export function readGroupLocalFacts(groupDir: string): string | null {
  return readGroupDoc(groupDir, LOCAL_FACTS_FILE, 'Could not read group local facts; omitting them');
}
