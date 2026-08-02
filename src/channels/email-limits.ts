/**
 * Attachment size and count limits for the email channel.
 *
 * The host has none of its own: `readOutboxFiles` (session-manager.ts) reads
 * every declared outbox file into memory and hands the buffers to the adapter,
 * and `extractAttachmentFiles` stages every inbound attachment to disk. On a
 * chat platform the platform itself caps this; on email nothing does until the
 * SMTP server rejects the whole message, so the cap lives here.
 *
 * Defaults sit below the ~25 MB most providers accept, measured AFTER base64
 * encoding (+37%): 20 MiB of raw bytes is already ~27 MB on the wire. Raising
 * them is a deliberate operator decision, not something a bad env value should
 * be able to do by accident — hence the fail-to-default parsing below.
 */

export interface EmailLimits {
  outboundFileBytes: number;
  outboundTotalBytes: number;
  outboundFileCount: number;
  inboundFileBytes: number;
  inboundTotalBytes: number;
  inboundFileCount: number;
}

const MIB = 1024 * 1024;

export const DEFAULT_EMAIL_LIMITS: EmailLimits = {
  outboundFileBytes: 10 * MIB,
  outboundTotalBytes: 20 * MIB,
  outboundFileCount: 10,
  inboundFileBytes: 10 * MIB,
  inboundTotalBytes: 20 * MIB,
  inboundFileCount: 20,
};

/**
 * A limit that silently becomes Infinity because someone wrote `0`,
 * `unlimited`, or `10MB` is worse than no limit at all: it looks configured.
 * Anything that isn't a finite positive number falls back to the default.
 */
function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

export function resolveEmailLimits(env: Record<string, string | undefined>): EmailLimits {
  return {
    outboundFileBytes: positiveInt(env.EMAIL_MAX_OUTBOUND_FILE_BYTES, DEFAULT_EMAIL_LIMITS.outboundFileBytes),
    outboundTotalBytes: positiveInt(env.EMAIL_MAX_OUTBOUND_TOTAL_BYTES, DEFAULT_EMAIL_LIMITS.outboundTotalBytes),
    outboundFileCount: positiveInt(env.EMAIL_MAX_OUTBOUND_FILE_COUNT, DEFAULT_EMAIL_LIMITS.outboundFileCount),
    inboundFileBytes: positiveInt(env.EMAIL_MAX_INBOUND_FILE_BYTES, DEFAULT_EMAIL_LIMITS.inboundFileBytes),
    inboundTotalBytes: positiveInt(env.EMAIL_MAX_INBOUND_TOTAL_BYTES, DEFAULT_EMAIL_LIMITS.inboundTotalBytes),
    inboundFileCount: positiveInt(env.EMAIL_MAX_INBOUND_FILE_COUNT, DEFAULT_EMAIL_LIMITS.inboundFileCount),
  };
}

/** Human-readable size for the skip notes an agent reads in the message text. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / MIB).toFixed(1)} MB`;
}
