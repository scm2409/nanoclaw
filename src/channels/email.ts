/**
 * Email channel adapter (IMAP in, SMTP out) with a local allowlist in both
 * directions. Native adapter — no Chat SDK bridge. Self-registers on import.
 *
 * WHY THIS EXISTS AS A CHANNEL AND NOT AS AN MCP TOOL
 *
 * The requirement is "this mailbox may only correspond with these people".
 * NanoClaw already enforces exactly that shape for chat channels — strict
 * unknown_sender_policy plus agent_group_members on the way in,
 * agent_destinations on the way out (re-validated host-side in delivery.ts).
 * Modelling email as a channel makes the allowlist a wiring question rather
 * than a second, parallel access-control system. See email-allowlist.ts.
 *
 * A second, quieter benefit: IMAP/SMTP credentials stay in the host process.
 * They are not HTTP, so the OneCLI gateway cannot inject them per request, and
 * a mail MCP server inside the container would need the real password. Here
 * the agent reads mail as ordinary chat messages and never holds mailbox
 * access at all.
 *
 * CONVERSATION MODEL
 *
 * One correspondent = one messaging group, platform_id `email:<address>`,
 * always a DM (is_group 0), never threaded (supportsThreads false; RFC 5322
 * threading is reproduced with In-Reply-To/References from email-state.ts, but
 * the router does not treat it as a thread axis).
 */
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';

import { log } from '../log.js';
import { readEnvFile } from '../env.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { buildInboundAttachments, checkOutboundAttachments, type EmailAttachmentPart } from './email-attachments.js';
import { isAllowedRecipient as dbIsAllowedRecipient, isAllowedSender as dbIsAllowedSender } from './email-allowlist.js';
import { DEFAULT_EMAIL_LIMITS, resolveEmailLimits, type EmailLimits } from './email-limits.js';
import { htmlToText, isAutomatedMail, normalizeAddress, parseDisplayName, stripQuotedReply } from './email-parse.js';
import {
  getMailboxCursor as loadMailboxCursor,
  getThreadRef as loadThreadRef,
  saveMailboxCursor as storeMailboxCursor,
  saveThreadRef as storeThreadRef,
  type MailboxCursor,
  type ThreadRef,
} from './email-state.js';

/**
 * A mailbox is a personal identity, not a bot account in a public room: a
 * message from someone who isn't wired is dropped, never escalated into an
 * approval card (same reasoning as the Signal adapter's `strict`). Every mail
 * addressed to us is by definition addressed to us, so DM engagement is the
 * always-on pattern and `mentions` is 'dm-only'.
 */
const EMAIL_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  mentions: 'dm-only',
};

const ENV_KEYS = [
  'EMAIL_ADDRESS',
  'EMAIL_USER',
  'EMAIL_PASSWORD',
  'EMAIL_FROM_NAME',
  'EMAIL_IMAP_HOST',
  'EMAIL_IMAP_PORT',
  'EMAIL_IMAP_SECURE',
  'EMAIL_SMTP_HOST',
  'EMAIL_SMTP_PORT',
  'EMAIL_SMTP_SECURE',
  'EMAIL_MAILBOX',
  'EMAIL_POLL_INTERVAL_MS',
  'EMAIL_MAX_OUTBOUND_FILE_BYTES',
  'EMAIL_MAX_OUTBOUND_TOTAL_BYTES',
  'EMAIL_MAX_OUTBOUND_FILE_COUNT',
  'EMAIL_MAX_INBOUND_FILE_BYTES',
  'EMAIL_MAX_INBOUND_TOTAL_BYTES',
  'EMAIL_MAX_INBOUND_FILE_COUNT',
] as const;

export interface EmailAdapterConfig {
  address: string;
  user: string;
  password: string;
  fromName?: string;
  mailbox: string;
  pollIntervalMs: number;
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  limits: EmailLimits;
}

/** Minimal surface of a nodemailer transport, so tests need no SMTP server. */
export interface MailTransport {
  sendMail(options: Record<string, unknown>): Promise<{ messageId?: string } | unknown>;
  close?(): void;
}

/** Minimal surface of the ImapFlow client this adapter uses. */
export interface ImapClientLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  getMailboxLock(mailbox: string): Promise<{ release(): void }>;
  fetch(range: unknown, query: unknown, options?: unknown): AsyncIterable<Record<string, unknown>>;
  messageFlagsAdd(range: unknown, flags: string[], options?: unknown): Promise<boolean>;
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  mailbox: { uidValidity: bigint | number; uidNext: number } | false;
  /** ImapFlow's own liveness flag — false once the socket is gone. */
  usable?: boolean;
}

/** Backoff for IMAP reconnects; the last value repeats forever. */
const RECONNECT_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

/** How long a connection must hold before the backoff counter resets. */
const STABLE_CONNECTION_MS = 60_000;

/**
 * How many messages one scan drains before yielding. Bounds peak memory on a
 * backlog (each entry holds a full RFC822 source) — the scan re-queues itself
 * when it hits the cap, so nothing is skipped.
 */
const MAX_MESSAGES_PER_SCAN = 25;

export interface EmailAdapterDeps {
  createTransport?: () => MailTransport;
  createImapClient?: () => ImapClientLike;
  isAllowedSender?: (address: string) => boolean;
  isAllowedRecipient?: (address: string) => boolean;
  getThreadRef?: (address: string) => ThreadRef | undefined;
  saveThreadRef?: (address: string, ref: ThreadRef) => void;
  /** Overridable so tests never touch the install's real UID watermark. */
  getMailboxCursor?: (mailbox: string) => MailboxCursor | undefined;
  saveMailboxCursor?: (mailbox: string, cursor: MailboxCursor) => void;
}

/** One received mail, already MIME-decoded. Structural subset of ParsedMail. */
export interface IncomingMail {
  /** Stable, filesystem-safe id — becomes the inbox directory name host-side. */
  id: string;
  /** Raw From header value, e.g. `Name <addr@example.org>`. */
  from: string | undefined;
  subject?: string;
  text?: string;
  html?: string | false;
  date?: Date;
  messageId?: string;
  inReplyTo?: string;
  headers: Map<string, unknown> | Record<string, unknown>;
  attachments: EmailAttachmentPart[];
}

export type IncomingOutcome =
  | 'delivered'
  | 'ignored-self'
  | 'ignored-automated'
  | 'ignored-not-allowed'
  | 'ignored-no-sender';

export interface IncomingContext {
  selfAddress: string;
  limits: EmailLimits;
  isAllowedSender(address: string): boolean;
  onInbound(platformId: string, threadId: string | null, message: InboundMessage): void | Promise<void>;
  saveThreadRef(address: string, ref: ThreadRef): void;
}

/**
 * Decide what happens to one received mail, and hand it to the router if it
 * survives every gate.
 *
 * The order of the gates is load-bearing:
 *   1. no parseable sender — nothing to check anything against.
 *   2. our own address — the cheapest possible loop, a reply to ourselves.
 *   3. automated mail — checked BEFORE the allowlist on purpose, because the
 *      loop risk comes precisely from an allowlisted correspondent's own
 *      out-of-office responder.
 *   4. allowlist — a stranger's mail never becomes a NanoClaw message, so no
 *      messaging group and no unregistered_senders row is created for spam.
 */
export async function handleIncomingMail(mail: IncomingMail, ctx: IncomingContext): Promise<IncomingOutcome> {
  const address = normalizeAddress(mail.from);
  if (!address) {
    log.debug('Email: mail with no parseable sender, ignoring', { id: mail.id });
    return 'ignored-no-sender';
  }
  if (address === normalizeAddress(ctx.selfAddress)) {
    log.debug('Email: mail from our own address, ignoring', { id: mail.id });
    return 'ignored-self';
  }
  if (isAutomatedMail(mail.headers)) {
    log.info('Email: automated mail ignored (loop guard)', { id: mail.id, address });
    return 'ignored-automated';
  }
  if (!ctx.isAllowedSender(address)) {
    log.info('Email: sender not on inbound allowlist, dropped', { id: mail.id, address });
    return 'ignored-not-allowed';
  }

  const rawBody = mail.text ?? (typeof mail.html === 'string' ? htmlToText(mail.html) : '');
  const body = rawBody ? stripQuotedReply(rawBody) : '';
  const { attachments, notes } = buildInboundAttachments(mail.attachments ?? [], ctx.limits);
  const text = [body, ...notes].filter((part) => part.length > 0).join('\n\n') || '(no text content)';

  const content: Record<string, unknown> = {
    text,
    senderId: `email:${address}`,
    senderName: parseDisplayName(mail.from) ?? address,
    subject: mail.subject ?? '',
    messageId: mail.messageId,
    inReplyTo: mail.inReplyTo,
  };
  if (attachments.length > 0) content.attachments = attachments;

  await ctx.onInbound(`email:${address}`, null, {
    id: mail.id,
    kind: 'chat',
    content,
    timestamp: (mail.date ?? new Date()).toISOString(),
    // A mail addressed to the bot's own mailbox IS the act of addressing it.
    isMention: true,
    isGroup: false,
  });

  if (mail.messageId) {
    ctx.saveThreadRef(address, { messageId: mail.messageId, subject: mail.subject ?? '' });
  }
  return 'delivered';
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
  }
  return '';
}

function replySubject(ref: ThreadRef | undefined, fromName: string): string {
  if (!ref || !ref.subject) return `Message from ${fromName}`;
  return /^re:\s/i.test(ref.subject) ? ref.subject : `Re: ${ref.subject}`;
}

export function createEmailAdapter(config: EmailAdapterConfig, deps: EmailAdapterDeps = {}): ChannelAdapter {
  const isAllowedSender = deps.isAllowedSender ?? dbIsAllowedSender;
  const isAllowedRecipient = deps.isAllowedRecipient ?? dbIsAllowedRecipient;
  const getThreadRef = deps.getThreadRef ?? loadThreadRef;
  const saveThreadRef = deps.saveThreadRef ?? storeThreadRef;
  const getMailboxCursor = deps.getMailboxCursor ?? loadMailboxCursor;
  const saveMailboxCursor = deps.saveMailboxCursor ?? storeMailboxCursor;

  const createTransport =
    deps.createTransport ??
    (() =>
      nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        auth: { user: config.user, pass: config.password },
      }) as unknown as MailTransport);

  const createImapClient =
    deps.createImapClient ??
    (() =>
      new ImapFlow({
        host: config.imap.host,
        port: config.imap.port,
        secure: config.imap.secure,
        auth: { user: config.user, pass: config.password },
        logger: false,
      }) as unknown as ImapClientLike);

  const fromName = config.fromName ?? config.address;
  const fromHeader = config.fromName ? `"${config.fromName}" <${config.address}>` : config.address;

  let setup: ChannelSetup | null = null;
  let transport: MailTransport | null = null;
  let client: ImapClientLike | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectAttempt = 0;
  let connectedAt: number | null = null;
  let stopped = false;
  let connected = false;
  let scanning = false;
  let rescanQueued = false;

  function mailTransport(): MailTransport {
    if (!transport) transport = createTransport();
    return transport;
  }

  /**
   * Open the IMAP connection and wire its event handlers.
   *
   * Used for the initial connect AND every reconnect, so there is exactly one
   * definition of what a live connection looks like.
   */
  async function connectClient(): Promise<void> {
    const next = createImapClient();
    // ImapFlow idles whenever it is otherwise unoccupied and emits 'exists'
    // when the server announces new mail. The poll timer is the fallback for
    // servers that drop IDLE silently.
    next.on('exists', () => void scanMailbox());
    next.on('close', () => {
      if (!stopped) scheduleReconnect();
    });
    next.on('error', (err) => log.debug('Email: IMAP client error', { err }));
    await next.connect();
    client = next;
    connected = true;
    connectedAt = Date.now();
  }

  /**
   * Reconnect after the connection drops.
   *
   * Without this the channel dies silently on the first blip: every poll logs
   * "Connection not available" and no mail is ever received again, while
   * isConnected() keeps claiming the channel is fine. A mail channel runs for
   * months at a time, so a dropped connection is a when, not an if — servers
   * time out IDLE sessions, restart, and get in front of network hiccups.
   *
   * Backs off so a server that is down for an hour doesn't get hammered, and
   * scans immediately on success because mail almost certainly arrived while
   * we were away.
   */
  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return;
    // Only a connection that actually held for a while counts as recovery.
    // Resetting on connect alone would let a flapping server — one that
    // accepts the socket and drops it immediately — be retried every 2s
    // forever, which is the hammering the backoff exists to prevent.
    if (connectedAt !== null && Date.now() - connectedAt >= STABLE_CONNECTION_MS) reconnectAttempt = 0;
    connectedAt = null;
    connected = false;
    const delayMs = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    reconnectAttempt++;
    log.warn('Email: IMAP connection lost, reconnecting', { delayMs, attempt: reconnectAttempt });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (stopped) return;
      void connectClient()
        .then(() => {
          log.info('Email: IMAP reconnected');
          return scanMailbox();
        })
        .catch((err) => {
          log.warn('Email: IMAP reconnect failed', { err });
          scheduleReconnect();
        });
    }, delayMs);
  }

  /**
   * Fetch and dispatch everything newer than the stored watermark.
   *
   * The watermark, not the \Seen flag, is the primary marker. \Seen is also
   * set by any human mail client that opens the mailbox, so selecting on it
   * would make the agent skip messages the operator happened to read first.
   * \Seen is still set afterwards, as a courtesy to whoever looks at the
   * mailbox.
   *
   * On a first run (or after the server renumbers the mailbox and uidValidity
   * changes) the watermark is set to the current end of the mailbox WITHOUT
   * processing anything: nobody wants a fresh install to answer five years of
   * archived mail.
   */
  /** ImapFlow reports `usable === false` once the socket is gone. */
  function connectionLost(): boolean {
    return client?.usable === false;
  }

  async function scanMailbox(): Promise<void> {
    if (!client || !setup || stopped) return;
    if (connectionLost()) {
      scheduleReconnect();
      return;
    }
    if (scanning) {
      rescanQueued = true;
      return;
    }
    scanning = true;
    let hitBatchCap = false;
    try {
      const active = client;
      const lock = await active.getMailboxLock(config.mailbox);
      try {
        const status = active.mailbox;
        if (!status) return;
        const uidValidity = String(status.uidValidity);
        const cursor = getMailboxCursor(config.mailbox);

        if (!cursor || cursor.uidValidity !== uidValidity) {
          const lastUid = Math.max(0, Number(status.uidNext) - 1);
          saveMailboxCursor(config.mailbox, { uidValidity, lastUid });
          log.info('Email: mailbox watermark initialised, existing mail will not be processed', {
            mailbox: config.mailbox,
            uidValidity,
            lastUid,
          });
          return;
        }

        // Drain the FETCH fully before touching the connection again. Issuing
        // another command (the \Seen store, below) while the fetch generator
        // is still open kills the connection — the live suite caught exactly
        // that: the first message went through, then every later scan failed
        // with "Connection not available". Batching also bounds how much mail
        // is held in memory at once on a backlog.
        const batch: Array<{ uid: number; source: Buffer }> = [];
        for await (const message of active.fetch(
          `${cursor.lastUid + 1}:*`,
          { uid: true, source: true },
          { uid: true },
        )) {
          const uid = Number(message.uid);
          // An empty range still yields the last existing message on many
          // servers ("*" is clamped), so re-check the watermark per message.
          if (!Number.isFinite(uid) || uid <= cursor.lastUid) continue;
          batch.push({ uid, source: message.source as Buffer });
          if (batch.length >= MAX_MESSAGES_PER_SCAN) {
            hitBatchCap = true;
            break;
          }
        }

        batch.sort((a, b) => a.uid - b.uid);
        let lastUid = cursor.lastUid;
        for (const { uid, source } of batch) {
          try {
            await dispatchSource(source, uid, uidValidity);
          } catch (err) {
            log.error('Email: failed to process message', { uid, err });
          }

          lastUid = Math.max(lastUid, uid);
          saveMailboxCursor(config.mailbox, { uidValidity, lastUid });
          try {
            await active.messageFlagsAdd({ uid: String(uid) }, ['\\Seen'], { uid: true });
          } catch (err) {
            log.debug('Email: could not set \\Seen', { uid, err });
          }
        }
      } finally {
        lock.release();
      }
    } catch (err) {
      log.warn('Email: mailbox scan failed', { err });
      if (connectionLost()) scheduleReconnect();
    } finally {
      scanning = false;
      if (rescanQueued || hitBatchCap) {
        rescanQueued = false;
        void scanMailbox();
      }
    }
  }

  async function dispatchSource(source: Buffer, uid: number, uidValidity: string): Promise<void> {
    const parsed = await simpleParser(source);
    const mail: IncomingMail = {
      // Digits and dashes only — this becomes the inbox directory name and is
      // re-checked with isSafeAttachmentName host-side. A raw Message-ID could
      // contain a path separator.
      id: `email-${uidValidity}-${uid}`,
      from: parsed.from?.text,
      subject: parsed.subject,
      text: parsed.text,
      html: parsed.html,
      date: parsed.date,
      messageId: parsed.messageId,
      inReplyTo: parsed.inReplyTo,
      headers: parsed.headers as unknown as Map<string, unknown>,
      attachments: (parsed.attachments ?? []) as unknown as EmailAttachmentPart[],
    };

    const outcome = await handleIncomingMail(mail, {
      selfAddress: config.address,
      limits: config.limits,
      isAllowedSender,
      onInbound: (platformId, threadId, message) => setup!.onInbound(platformId, threadId, message),
      saveThreadRef,
    });
    log.debug('Email: message processed', { uid, outcome });
  }

  const adapter: ChannelAdapter = {
    name: 'email',
    channelType: 'email',
    supportsThreads: false,
    defaults: EMAIL_DEFAULTS,
    // Token-usage and subagent notices stay out of the mail. Each one would
    // be its own message sitting in someone's inbox, and a correspondent who
    // isn't the operator has no business receiving this install's model
    // choice and running cost.
    deliversNotices: false,

    async setup(cfg: ChannelSetup): Promise<void> {
      setup = cfg;
      stopped = false;

      try {
        await connectClient();
      } catch (err) {
        // Mark transient so initChannelAdapters retries instead of dropping
        // the channel for the lifetime of the process.
        const error = err instanceof Error ? err : new Error(String(err));
        error.name = 'NetworkError';
        client = null;
        throw error;
      }

      pollTimer = setInterval(() => void scanMailbox(), config.pollIntervalMs);
      await scanMailbox();
    },

    async teardown(): Promise<void> {
      stopped = true;
      connected = false;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      try {
        await client?.logout();
      } catch (err) {
        log.debug('Email: IMAP logout failed', { err });
      }
      client = null;
      transport?.close?.();
      transport = null;
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      const to = normalizeAddress(platformId.replace(/^email:/, ''));
      if (!to) throw new Error(`email: unusable recipient address in platform id "${platformId}"`);

      // Belt and braces. src/delivery.ts already validated this against
      // agent_destinations and is authoritative; this check means nothing
      // reaches SMTP even if that path is ever bypassed or the projection in
      // the container is stale.
      if (!isAllowedRecipient(to)) {
        throw new Error(`email: recipient not on outbound allowlist: ${to}`);
      }

      // Before anything is handed to SMTP: a limit breach must not produce a
      // half-sent mail (text delivered, attachment silently missing).
      const attachments = checkOutboundAttachments(message.files, config.limits);

      const ref = getThreadRef(to);
      const mail: Record<string, unknown> = {
        from: fromHeader,
        to,
        subject: replySubject(ref, fromName),
        text: extractText(message.content),
      };
      if (ref) {
        mail.inReplyTo = ref.messageId;
        mail.references = ref.messageId;
      }
      if (attachments.length > 0) mail.attachments = attachments;

      const info = (await mailTransport().sendMail(mail)) as { messageId?: string } | undefined;
      log.info('Email: message sent', { to, attachments: attachments.length, messageId: info?.messageId });
      return info?.messageId;
    },
  };

  return adapter;
}

function boolFromEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function intFromEnv(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

registerChannelAdapter('email', {
  factory: () => {
    const env = readEnvFile([...ENV_KEYS]);
    const pick = (key: (typeof ENV_KEYS)[number]): string | undefined => process.env[key] || env[key];

    const address = pick('EMAIL_ADDRESS');
    const password = pick('EMAIL_PASSWORD');
    const imapHost = pick('EMAIL_IMAP_HOST');
    const smtpHost = pick('EMAIL_SMTP_HOST');
    if (!address || !password || !imapHost || !smtpHost) {
      log.debug('Email: credentials incomplete, skipping channel');
      return null;
    }

    return createEmailAdapter({
      address,
      user: pick('EMAIL_USER') || address,
      password,
      fromName: pick('EMAIL_FROM_NAME'),
      mailbox: pick('EMAIL_MAILBOX') || 'INBOX',
      pollIntervalMs: intFromEnv(pick('EMAIL_POLL_INTERVAL_MS'), 60_000),
      imap: {
        host: imapHost,
        port: intFromEnv(pick('EMAIL_IMAP_PORT'), 993),
        secure: boolFromEnv(pick('EMAIL_IMAP_SECURE'), true),
      },
      smtp: {
        host: smtpHost,
        port: intFromEnv(pick('EMAIL_SMTP_PORT'), 587),
        secure: boolFromEnv(pick('EMAIL_SMTP_SECURE'), false),
      },
      limits: resolveEmailLimits({
        EMAIL_MAX_OUTBOUND_FILE_BYTES: pick('EMAIL_MAX_OUTBOUND_FILE_BYTES'),
        EMAIL_MAX_OUTBOUND_TOTAL_BYTES: pick('EMAIL_MAX_OUTBOUND_TOTAL_BYTES'),
        EMAIL_MAX_OUTBOUND_FILE_COUNT: pick('EMAIL_MAX_OUTBOUND_FILE_COUNT'),
        EMAIL_MAX_INBOUND_FILE_BYTES: pick('EMAIL_MAX_INBOUND_FILE_BYTES'),
        EMAIL_MAX_INBOUND_TOTAL_BYTES: pick('EMAIL_MAX_INBOUND_TOTAL_BYTES'),
        EMAIL_MAX_INBOUND_FILE_COUNT: pick('EMAIL_MAX_INBOUND_FILE_COUNT'),
      }),
    });
  },
  defaults: EMAIL_DEFAULTS,
  deliversNotices: false,
});

export { DEFAULT_EMAIL_LIMITS, EMAIL_DEFAULTS };
