/**
 * Durable state for the email channel: where the IMAP scan left off, and what
 * to thread a reply onto.
 *
 * Two things a restart must not lose:
 *   - the last processed UID per mailbox. The \Seen flag is the primary
 *     marker, but a mail the operator opens in a normal mail client is also
 *     \Seen — the UID watermark is what keeps a human reading the inbox from
 *     making the agent skip messages, and what makes a re-scan cheap.
 *   - the last Message-ID and Subject per correspondent. Without them every
 *     reply starts a brand-new thread in the other side's mail client, which
 *     is how a conversation turns into 40 unrelated messages.
 *
 * Same small-flat-JSON approach as matrix-dm-room-store.ts, and the same
 * never-throw policy: a missing or corrupt file degrades to "nothing known"
 * rather than turning a working start into a broken one.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { log } from '../log.js';

const STORE_DIR = process.env.EMAIL_STATE_DIR ? path.resolve(process.env.EMAIL_STATE_DIR) : DATA_DIR;
const STORE_PATH = path.join(STORE_DIR, 'email-state.json');
const STORE_TMP_PATH = `${STORE_PATH}.tmp`;

export interface MailboxCursor {
  uidValidity: string;
  lastUid: number;
}

export interface ThreadRef {
  messageId: string;
  subject: string;
}

interface EmailState {
  cursors: Record<string, MailboxCursor>;
  threads: Record<string, ThreadRef>;
}

const EMPTY: EmailState = { cursors: {}, threads: {} };

function readStore(): EmailState {
  let raw: string;
  try {
    raw = fs.readFileSync(STORE_PATH, 'utf8');
  } catch {
    return { ...EMPTY, cursors: {}, threads: {} };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<EmailState>;
    if (!parsed || typeof parsed !== 'object') return { cursors: {}, threads: {} };
    return { cursors: parsed.cursors ?? {}, threads: parsed.threads ?? {} };
  } catch (err) {
    log.warn('Email state store is corrupt, starting fresh', { err });
    return { cursors: {}, threads: {} };
  }
}

function writeStore(state: EmailState): void {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    // Atomic: a crash mid-write can't corrupt the last good state.
    fs.writeFileSync(STORE_TMP_PATH, JSON.stringify(state));
    fs.renameSync(STORE_TMP_PATH, STORE_PATH);
  } catch (err) {
    log.warn('Failed to save email state store', { err });
  }
}

/** Where the last scan of this mailbox stopped. */
export function getMailboxCursor(mailbox: string): MailboxCursor | undefined {
  return readStore().cursors[mailbox];
}

/**
 * Record the scan watermark. A changed uidValidity means the server
 * renumbered the mailbox: the caller must treat the old lastUid as
 * meaningless rather than skipping everything below it.
 */
export function saveMailboxCursor(mailbox: string, cursor: MailboxCursor): void {
  const state = readStore();
  state.cursors[mailbox] = cursor;
  writeStore(state);
}

/** The mail to thread the next reply to this address onto. */
export function getThreadRef(address: string): ThreadRef | undefined {
  return readStore().threads[address];
}

export function saveThreadRef(address: string, ref: ThreadRef): void {
  const state = readStore();
  state.threads[address] = ref;
  writeStore(state);
}
