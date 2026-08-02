/**
 * Adapter behaviour, with IMAP and SMTP replaced by injected fakes.
 *
 * The two invariants worth a test each:
 *   - Nothing leaves the process for an address that is not on the outbound
 *     allowlist, and nothing leaves it for a mail whose attachments breach a
 *     limit. In both cases `sendMail` must never be reached — a partially
 *     sent mail is invisible to the recipient.
 *   - Nothing enters the router from an address that is not on the inbound
 *     allowlist, from ourselves, or from an autoresponder.
 */
import { describe, expect, it, beforeEach, vi, type Mock } from 'vitest';

import { createEmailAdapter, handleIncomingMail, type IncomingContext, type IncomingMail } from './email.js';
import { DEFAULT_EMAIL_LIMITS, type EmailLimits } from './email-limits.js';

const LIMITS: EmailLimits = { ...DEFAULT_EMAIL_LIMITS, outboundFileBytes: 1000, outboundTotalBytes: 1500 };

const CONFIG = {
  address: 'kail@example.org',
  user: 'kail@example.org',
  password: 'secret',
  fromName: 'KaiL01',
  mailbox: 'INBOX',
  pollIntervalMs: 60_000,
  imap: { host: 'imap.example.org', port: 993, secure: true },
  smtp: { host: 'smtp.example.org', port: 587, secure: false },
  limits: LIMITS,
};

function makeAdapter(overrides: { allowedRecipients?: string[]; threadRef?: { messageId: string; subject: string } }) {
  const sendMail = vi.fn().mockResolvedValue({ messageId: '<sent@example.org>' });
  const adapter = createEmailAdapter(CONFIG, {
    createTransport: () => ({ sendMail, close: () => {}, verify: async () => true }),
    createImapClient: () => {
      throw new Error('IMAP must not be constructed in this test');
    },
    isAllowedRecipient: (addr: string) => (overrides.allowedRecipients ?? ['freund@example.org']).includes(addr),
    getThreadRef: () => overrides.threadRef,
    saveThreadRef: () => {},
  });
  return { adapter, sendMail };
}

describe('email adapter — identity', () => {
  it('declares the channel contract the router relies on', () => {
    const { adapter } = makeAdapter({});
    expect(adapter.name).toBe('email');
    expect(adapter.channelType).toBe('email');
    expect(adapter.supportsThreads).toBe(false);
    // A mailbox is a personal identity: an unknown sender is dropped, never
    // escalated to an approval card.
    expect(adapter.defaults?.dm.unknownSenderPolicy).toBe('strict');
    expect(adapter.defaults?.group.unknownSenderPolicy).toBe('strict');
    expect(adapter.defaults?.dm.threads).toBe(false);
    expect(adapter.defaults?.mentions).toBe('dm-only');
    // The handle IS the DM address — see the openDM contract in adapter.ts.
    expect(adapter.openDM).toBeUndefined();
  });
});

describe('email adapter — deliver', () => {
  it('sends to exactly one recipient with no cc or bcc', async () => {
    const { adapter, sendMail } = makeAdapter({});
    await adapter.deliver('email:freund@example.org', null, { kind: 'chat', content: { text: 'Moin' } });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0][0];
    expect(mail.to).toBe('freund@example.org');
    expect(mail.cc).toBeUndefined();
    expect(mail.bcc).toBeUndefined();
    expect(mail.from).toBe('"KaiL01" <kail@example.org>');
    expect(mail.text).toBe('Moin');
  });

  it('accepts a bare string content payload', async () => {
    const { adapter, sendMail } = makeAdapter({});
    await adapter.deliver('email:freund@example.org', null, { kind: 'chat', content: 'Kurz' });
    expect(sendMail.mock.calls[0][0].text).toBe('Kurz');
  });

  it('refuses a recipient that is not on the outbound allowlist', async () => {
    const { adapter, sendMail } = makeAdapter({});
    await expect(
      adapter.deliver('email:fremder@example.org', null, { kind: 'chat', content: { text: 'hi' } }),
    ).rejects.toThrow(/recipient not on outbound allowlist: fremder@example\.org/);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('refuses a platform id that is not a parseable address', async () => {
    const { adapter, sendMail } = makeAdapter({});
    await expect(adapter.deliver('email:not-an-address', null, { kind: 'chat', content: 'x' })).rejects.toThrow();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('attaches files that fit', async () => {
    const { adapter, sendMail } = makeAdapter({});
    await adapter.deliver('email:freund@example.org', null, {
      kind: 'chat',
      content: { text: 'Anbei.' },
      files: [{ filename: 'report.pdf', data: Buffer.alloc(100) }],
    });
    expect(sendMail.mock.calls[0][0].attachments).toEqual([
      { filename: 'report.pdf', content: expect.any(Buffer), contentType: 'application/pdf' },
    ]);
  });

  // The whole point of the hard limit: no half-sent mail.
  it('sends nothing at all when an attachment is over the limit', async () => {
    const { adapter, sendMail } = makeAdapter({});
    await expect(
      adapter.deliver('email:freund@example.org', null, {
        kind: 'chat',
        content: { text: 'Anbei.' },
        files: [{ filename: 'huge.bin', data: Buffer.alloc(1001) }],
      }),
    ).rejects.toThrow(/attachment "huge\.bin" is 1001 bytes, limit 1000/);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('sends nothing at all when the attachment total is over the limit', async () => {
    const { adapter, sendMail } = makeAdapter({});
    await expect(
      adapter.deliver('email:freund@example.org', null, {
        kind: 'chat',
        content: { text: 'Anbei.' },
        files: [
          { filename: 'a.bin', data: Buffer.alloc(900) },
          { filename: 'b.bin', data: Buffer.alloc(900) },
        ],
      }),
    ).rejects.toThrow(/attachments total 1800 bytes, limit 1500/);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('threads the reply onto the last mail from that correspondent', async () => {
    const { adapter, sendMail } = makeAdapter({
      threadRef: { messageId: '<abc@example.org>', subject: 'Angebot' },
    });
    await adapter.deliver('email:freund@example.org', null, { kind: 'chat', content: { text: 'Ja' } });
    const mail = sendMail.mock.calls[0][0];
    expect(mail.subject).toBe('Re: Angebot');
    expect(mail.inReplyTo).toBe('<abc@example.org>');
    expect(mail.references).toBe('<abc@example.org>');
  });

  it('does not double the Re: prefix', async () => {
    const { adapter, sendMail } = makeAdapter({
      threadRef: { messageId: '<abc@example.org>', subject: 'Re: Angebot' },
    });
    await adapter.deliver('email:freund@example.org', null, { kind: 'chat', content: { text: 'Ja' } });
    expect(sendMail.mock.calls[0][0].subject).toBe('Re: Angebot');
  });

  it('uses a standalone subject when there is no thread to reply to', async () => {
    const { adapter, sendMail } = makeAdapter({});
    await adapter.deliver('email:freund@example.org', null, { kind: 'chat', content: { text: 'Neue Sache' } });
    const mail = sendMail.mock.calls[0][0];
    expect(mail.subject).toBe('Message from KaiL01');
    expect(mail.inReplyTo).toBeUndefined();
  });
});

describe('handleIncomingMail', () => {
  let onInbound: Mock<IncomingContext['onInbound']>;
  let saveThreadRef: Mock<IncomingContext['saveThreadRef']>;

  function mail(overrides: Partial<IncomingMail> = {}): IncomingMail {
    return {
      id: 'msg-1',
      from: 'Freund <freund@example.org>',
      subject: 'Angebot',
      text: 'Hallo KaiL',
      date: new Date('2026-08-01T10:00:00Z'),
      messageId: '<abc@example.org>',
      headers: new Map(),
      attachments: [],
      ...overrides,
    };
  }

  function ctx(allowed = true): IncomingContext {
    return {
      selfAddress: 'kail@example.org',
      limits: LIMITS,
      isAllowedSender: () => allowed,
      onInbound,
      saveThreadRef,
    };
  }

  beforeEach(() => {
    onInbound = vi.fn<IncomingContext['onInbound']>();
    saveThreadRef = vi.fn<IncomingContext['saveThreadRef']>();
  });

  it('routes an allowed mail as a direct message', async () => {
    expect(await handleIncomingMail(mail(), ctx())).toBe('delivered');
    expect(onInbound).toHaveBeenCalledTimes(1);
    const [platformId, threadId, message] = onInbound.mock.calls[0];
    expect(platformId).toBe('email:freund@example.org');
    expect(threadId).toBeNull();
    expect(message.kind).toBe('chat');
    expect(message.isGroup).toBe(false);
    // A direct mail to the bot's own address is the addressing act itself.
    expect(message.isMention).toBe(true);
    expect(message.content).toMatchObject({
      text: 'Hallo KaiL',
      senderId: 'email:freund@example.org',
      senderName: 'Freund',
      subject: 'Angebot',
      messageId: '<abc@example.org>',
    });
  });

  it('remembers the thread so the reply can be threaded', async () => {
    await handleIncomingMail(mail(), ctx());
    expect(saveThreadRef).toHaveBeenCalledWith('freund@example.org', {
      messageId: '<abc@example.org>',
      subject: 'Angebot',
    });
  });

  it('drops a sender that is not on the inbound allowlist', async () => {
    expect(await handleIncomingMail(mail(), ctx(false))).toBe('ignored-not-allowed');
    expect(onInbound).not.toHaveBeenCalled();
    expect(saveThreadRef).not.toHaveBeenCalled();
  });

  it('drops our own mail so a reply cannot feed itself', async () => {
    expect(await handleIncomingMail(mail({ from: 'KaiL01 <kail@example.org>' }), ctx())).toBe('ignored-self');
    expect(onInbound).not.toHaveBeenCalled();
  });

  // Checked before the allowlist: an allowlisted correspondent's own
  // out-of-office reply is exactly how a loop starts.
  it('drops an autoresponder even from an allowed sender', async () => {
    const headers = new Map([['auto-submitted', 'auto-replied']]);
    expect(await handleIncomingMail(mail({ headers }), ctx())).toBe('ignored-automated');
    expect(onInbound).not.toHaveBeenCalled();
  });

  it('drops a mail with no parseable sender', async () => {
    expect(await handleIncomingMail(mail({ from: undefined }), ctx())).toBe('ignored-no-sender');
    expect(onInbound).not.toHaveBeenCalled();
  });

  it('falls back to the HTML body when there is no plain text part', async () => {
    await handleIncomingMail(mail({ text: undefined, html: '<p>Hallo <b>KaiL</b></p>' }), ctx());
    expect((onInbound.mock.calls[0][2].content as { text: string }).text).toBe('Hallo KaiL');
  });

  it('strips the quoted history from a reply', async () => {
    await handleIncomingMail(mail({ text: 'Passt.\n\nOn Fri, KaiL01 <k@x.de> wrote:\n> alt' }), ctx());
    expect((onInbound.mock.calls[0][2].content as { text: string }).text).toBe('Passt.');
  });

  it('passes attachments through in the shape session-manager stages', async () => {
    await handleIncomingMail(
      mail({ attachments: [{ filename: 'doc.pdf', content: Buffer.alloc(10), contentType: 'application/pdf' }] }),
      ctx(),
    );
    const content = onInbound.mock.calls[0][2].content as { attachments: Array<Record<string, unknown>> };
    expect(content.attachments).toEqual([
      { name: 'doc.pdf', data: Buffer.alloc(10).toString('base64'), size: 10, mimeType: 'application/pdf' },
    ]);
  });

  it('delivers the text and explains a skipped oversized attachment', async () => {
    await handleIncomingMail(
      mail({
        text: 'Siehe Anhang',
        attachments: [{ filename: 'huge.bin', content: Buffer.alloc(DEFAULT_EMAIL_LIMITS.inboundFileBytes + 1) }],
      }),
      ctx(),
    );
    const content = onInbound.mock.calls[0][2].content as { text: string; attachments?: unknown[] };
    expect(content.text).toContain('Siehe Anhang');
    expect(content.text).toContain('[attachment omitted: huge.bin');
    expect(content.attachments ?? []).toEqual([]);
  });

  it('still delivers a mail whose body is empty but carries an attachment', async () => {
    await handleIncomingMail(
      mail({ text: undefined, html: undefined, attachments: [{ filename: 'doc.pdf', content: Buffer.alloc(4) }] }),
      ctx(),
    );
    expect(onInbound).toHaveBeenCalledTimes(1);
  });
});
