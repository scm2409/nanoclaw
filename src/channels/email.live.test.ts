/**
 * End-to-end email suite against a REAL mail server (GreenMail, local, in
 * memory). NOT part of `pnpm test` (excluded in vitest.config.ts) — run it
 * explicitly:
 *
 *     scripts/greenmail.sh up
 *     pnpm test:email-live
 *     scripts/greenmail.sh down
 *
 * What this proves that the unit tests cannot, because they stub the
 * transports away:
 *   1. imapflow actually connects, selects the mailbox, and hands us decoded
 *      messages — including MIME attachments.
 *   2. The UID watermark works against a real server's uidValidity/uidNext,
 *      including the "first scan processes nothing" rule.
 *   3. A refused sender is refused after the message genuinely arrived in the
 *      mailbox, not because it never got there.
 *   4. nodemailer's output is a real, parseable message with the right
 *      envelope, threading headers and attachment — verified by reading the
 *      recipient's own IMAP mailbox, not by inspecting a mock's arguments.
 *   5. An over-limit attachment aborts the send before SMTP sees anything, so
 *      the recipient's mailbox stays empty rather than gaining a mail whose
 *      attachment is missing.
 *
 * Mailtrap and similar SaaS sandboxes cannot stand in here: their captured
 * mail is not readable over IMAP, so they can only exercise the outbound half
 * — and the inbound half is where the allowlist lives.
 *
 * Addresses carry a per-run suffix because GreenMail keeps state for the
 * lifetime of its container; a fresh suffix means every run starts with
 * genuinely empty mailboxes.
 */
import fs from 'fs';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEmailAdapter, type EmailAdapterConfig } from './email.js';
import { DEFAULT_EMAIL_LIMITS } from './email-limits.js';
import { invalidateEmailAllowlistCache } from './email-allowlist.js';
import type { ChannelAdapter, InboundMessage } from './adapter.js';
import { allowAddress } from './email-provisioning.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../db/index.js';

const SMTP_PORT = 3025;
const IMAP_PORT = 3143;
const HOST = '127.0.0.1';

const RUN = Date.now().toString(36);
const SELF = `kail-${RUN}@example.org`;
const FRIEND = `freund-${RUN}@example.org`;
const STRANGER = `fremder-${RUN}@example.org`;

const AG = 'ag-email-live';

// Small on purpose: the default 10 MiB limits are covered by the unit tests,
// and pushing 10 MiB through SMTP on every run buys nothing.
const LIMITS = {
  ...DEFAULT_EMAIL_LIMITS,
  outboundFileBytes: 2000,
  outboundTotalBytes: 3000,
  inboundFileBytes: 2000,
  inboundTotalBytes: 3000,
};

const CONFIG: EmailAdapterConfig = {
  address: SELF,
  user: SELF,
  password: 'greenmail',
  fromName: 'KaiL01',
  mailbox: 'INBOX',
  pollIntervalMs: 1000,
  imap: { host: HOST, port: IMAP_PORT, secure: false },
  smtp: { host: HOST, port: SMTP_PORT, secure: false },
  limits: LIMITS,
};

interface Received {
  platformId: string;
  threadId: string | null;
  message: InboundMessage;
}

const received: Received[] = [];
let adapter: ChannelAdapter;

/** Inject a message into GreenMail as if some third party had sent it. */
async function sendAs(
  from: string,
  to: string,
  options: {
    subject?: string;
    text?: string;
    headers?: Record<string, string>;
    attachments?: Array<{ filename: string; content: Buffer }>;
  } = {},
): Promise<void> {
  const transport = nodemailer.createTransport({ host: HOST, port: SMTP_PORT, secure: false, ignoreTLS: true });
  await transport.sendMail({
    from,
    to,
    subject: options.subject ?? 'Test',
    text: options.text ?? 'Test body',
    headers: options.headers,
    attachments: options.attachments,
  });
  transport.close();
}

/** Read a mailbox straight off the server — used to check what the adapter sent. */
async function readMailbox(address: string): Promise<Array<Awaited<ReturnType<typeof simpleParser>>>> {
  const client = new ImapFlow({
    host: HOST,
    port: IMAP_PORT,
    secure: false,
    auth: { user: address, pass: 'greenmail' },
    logger: false,
  });
  await client.connect();
  const out: Array<Awaited<ReturnType<typeof simpleParser>>> = [];
  const lock = await client.getMailboxLock('INBOX');
  try {
    for await (const message of client.fetch('1:*', { source: true })) {
      out.push(await simpleParser(message.source as Buffer));
    }
  } finally {
    lock.release();
    await client.logout();
  }
  return out;
}

async function waitFor<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  what: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function inboundFrom(address: string): Received | undefined {
  return received.find((r) => r.platformId === `email:${address}`);
}

beforeAll(async () => {
  fs.rmSync('/tmp/nanoclaw-email-live-state', { recursive: true, force: true });

  runMigrations(initTestDb());
  createAgentGroup({
    id: AG,
    name: 'KaiL01',
    folder: 'kail',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await allowAddress(FRIEND, {
    agentGroupId: AG,
    agentGroupName: 'KaiL01',
    project: async () => {},
  });
  invalidateEmailAllowlistCache();

  adapter = createEmailAdapter(CONFIG);
  await adapter.setup({
    onInbound: (platformId, threadId, message) => {
      received.push({ platformId, threadId, message });
    },
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  });
}, 60_000);

afterAll(async () => {
  await adapter?.teardown();
  closeDb();
});

describe('email channel against a real IMAP/SMTP server', () => {
  it('connects', () => {
    expect(adapter.isConnected()).toBe(true);
  });

  it('routes a mail from an allowed sender, with its attachment', async () => {
    await sendAs(`Der Freund <${FRIEND}>`, SELF, {
      subject: 'Angebot',
      text: 'Hallo KaiL, hier der Text.',
      attachments: [{ filename: 'doc.txt', content: Buffer.from('inhalt') }],
    });

    const hit = await waitFor(() => inboundFrom(FRIEND), 'the allowed mail to be routed');
    expect(hit.threadId).toBeNull();
    expect(hit.message.isGroup).toBe(false);
    expect(hit.message.isMention).toBe(true);

    const content = hit.message.content as Record<string, unknown>;
    expect(content.senderId).toBe(`email:${FRIEND}`);
    expect(content.senderName).toBe('Der Freund');
    expect(content.subject).toBe('Angebot');
    expect(content.text).toBe('Hallo KaiL, hier der Text.');
    expect(content.attachments).toEqual([
      { name: 'doc.txt', data: Buffer.from('inhalt').toString('base64'), size: 6, mimeType: 'text/plain' },
    ]);
  });

  // The barrier matters: assert the refused mail was skipped only after a
  // LATER mail has been routed, so this can't pass just because the scan
  // hadn't run yet.
  it('drops a mail from a sender that is not on the allowlist', async () => {
    await sendAs(STRANGER, SELF, { subject: 'Spam', text: 'Kaufen Sie jetzt' });
    await sendAs(FRIEND, SELF, { subject: 'Danach', text: 'Zweite Mail' });

    await waitFor(
      () => received.find((r) => (r.message.content as { subject?: string }).subject === 'Danach'),
      'the follow-up mail',
    );
    expect(inboundFrom(STRANGER)).toBeUndefined();
  });

  it('drops an autoresponder from an allowed sender', async () => {
    await sendAs(FRIEND, SELF, {
      subject: 'Abwesenheitsnotiz',
      text: 'Ich bin im Urlaub',
      headers: { 'Auto-Submitted': 'auto-replied' },
    });
    await sendAs(FRIEND, SELF, { subject: 'Barriere 1', text: 'x' });

    await waitFor(
      () => received.find((r) => (r.message.content as { subject?: string }).subject === 'Barriere 1'),
      'the barrier mail',
    );
    expect(received.some((r) => (r.message.content as { subject?: string }).subject === 'Abwesenheitsnotiz')).toBe(
      false,
    );
  });

  it('drops a mail from its own address', async () => {
    await sendAs(SELF, SELF, { subject: 'Selbstgespräch', text: 'echo' });
    await sendAs(FRIEND, SELF, { subject: 'Barriere 2', text: 'x' });

    await waitFor(
      () => received.find((r) => (r.message.content as { subject?: string }).subject === 'Barriere 2'),
      'the barrier mail',
    );
    expect(received.some((r) => (r.message.content as { subject?: string }).subject === 'Selbstgespräch')).toBe(false);
  });

  it('delivers the text but skips an oversized inbound attachment', async () => {
    await sendAs(FRIEND, SELF, {
      subject: 'Zu gross',
      text: 'Siehe Anhang',
      attachments: [{ filename: 'huge.bin', content: Buffer.alloc(LIMITS.inboundFileBytes + 1, 0x41) }],
    });

    const hit = await waitFor(
      () => received.find((r) => (r.message.content as { subject?: string }).subject === 'Zu gross'),
      'the oversized-attachment mail',
    );
    const content = hit.message.content as { text: string; attachments?: unknown[] };
    expect(content.text).toContain('Siehe Anhang');
    expect(content.text).toContain('[attachment omitted: huge.bin');
    expect(content.attachments ?? []).toEqual([]);
  });

  it('sends a threaded reply to an allowed recipient', async () => {
    await adapter.deliver(`email:${FRIEND}`, null, { kind: 'chat', content: { text: 'Antwort vom Agenten' } });

    const mail = await waitFor(
      async () => (await readMailbox(FRIEND)).find((m) => m.text?.includes('Antwort vom Agenten')),
      'the reply to arrive',
    );

    const from = mail.from as { value: Array<{ address?: string; name?: string }> };
    expect(from.value[0].address).toBe(SELF);
    expect(from.value[0].name).toBe('KaiL01');
    const to = mail.to as { value: Array<{ address?: string }> };
    expect(to.value.map((v) => v.address)).toEqual([FRIEND]);
    expect(mail.cc).toBeUndefined();
    expect(mail.bcc).toBeUndefined();
    // Threaded onto the most recent mail we received from this correspondent.
    expect(mail.subject?.startsWith('Re:')).toBe(true);
    expect(mail.inReplyTo).toBeTruthy();
  });

  it('sends an attachment that fits', async () => {
    await adapter.deliver(`email:${FRIEND}`, null, {
      kind: 'chat',
      content: { text: 'Mit Anhang' },
      files: [{ filename: 'bericht.txt', data: Buffer.from('kurzer bericht') }],
    });

    const mail = await waitFor(
      async () => (await readMailbox(FRIEND)).find((m) => m.text?.includes('Mit Anhang')),
      'the mail with attachment',
    );
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments[0].filename).toBe('bericht.txt');
    expect(mail.attachments[0].content.toString()).toBe('kurzer bericht');
  });

  it('refuses to send to an address that is not on the allowlist', async () => {
    await expect(
      adapter.deliver(`email:${STRANGER}`, null, { kind: 'chat', content: { text: 'darf nicht raus' } }),
    ).rejects.toThrow(/not on outbound allowlist/);

    const box = await readMailbox(STRANGER);
    expect(box).toHaveLength(0);
  });

  // The important half of "hard limit": not just an error, but nothing sent.
  it('sends nothing at all when an attachment is over the limit', async () => {
    const before = (await readMailbox(FRIEND)).length;

    await expect(
      adapter.deliver(`email:${FRIEND}`, null, {
        kind: 'chat',
        content: { text: 'Anbei etwas Grosses' },
        files: [{ filename: 'huge.bin', data: Buffer.alloc(LIMITS.outboundFileBytes + 1) }],
      }),
    ).rejects.toThrow(/is \d+ bytes, limit/);

    const after = await readMailbox(FRIEND);
    expect(after).toHaveLength(before);
    expect(after.some((m) => m.text?.includes('Anbei etwas Grosses'))).toBe(false);
  });
});
