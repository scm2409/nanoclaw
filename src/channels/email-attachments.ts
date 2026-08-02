/**
 * Attachment handling in both directions, with the asymmetry spelled out:
 *
 *  - OUTBOUND is all-or-nothing. Sending the text of a mail while silently
 *    dropping the attachment that text refers to is the worst outcome —
 *    the recipient cannot notice. A limit breach throws before anything
 *    reaches SMTP; delivery.ts turns that into status='failed' with the exact
 *    message in the error log.
 *  - INBOUND is best-effort. Refusing the whole message because one part is
 *    oversized would hide the sender's words too, so the part is skipped and a
 *    note is appended to the message text where the agent will see it.
 */
import { isSafeAttachmentName } from '../attachment-safety.js';
import { formatBytes, type EmailLimits } from './email-limits.js';
import type { OutboundFile } from './adapter.js';

/** One decoded MIME part, structurally compatible with mailparser's Attachment. */
export interface EmailAttachmentPart {
  filename?: string;
  content: Buffer;
  contentType?: string;
  contentDisposition?: string;
  cid?: string;
  /** mailparser sets this when the part is referenced by cid from the HTML body. */
  related?: boolean;
  size?: number;
}

/** The shape session-manager.ts's extractAttachmentFiles stages into the inbox. */
export interface StagedAttachment {
  name: string;
  data: string; // base64
  size: number;
  mimeType: string;
}

export interface InboundAttachmentResult {
  attachments: StagedAttachment[];
  /** Human-readable lines to append to the message text for what was skipped. */
  notes: string[];
}

export interface OutboundAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  bin: 'application/octet-stream',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  eml: 'message/rfc822',
  gif: 'image/gif',
  htm: 'text/html',
  html: 'text/html',
  ics: 'text/calendar',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json',
  log: 'text/plain',
  md: 'text/markdown',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  odp: 'application/vnd.oasis.opendocument.presentation',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odt: 'application/vnd.oasis.opendocument.text',
  pdf: 'application/pdf',
  png: 'image/png',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  wav: 'audio/wav',
  webp: 'image/webp',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  zip: 'application/zip',
};

const EXTENSION_BY_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_BY_EXTENSION).map(([ext, mime]) => [mime, ext]),
);

function mimeForFilename(filename: string): string {
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

function extensionForMime(mimeType: string | undefined): string {
  if (!mimeType) return 'bin';
  return EXTENSION_BY_MIME[mimeType.split(';')[0].trim().toLowerCase()] ?? 'bin';
}

/**
 * Validate the outbox files the host loaded for this message and convert them
 * to nodemailer attachments. Throws on the first breach — see the file header
 * for why this is not a filter.
 */
export function checkOutboundAttachments(files: OutboundFile[] | undefined, limits: EmailLimits): OutboundAttachment[] {
  if (!files || files.length === 0) return [];

  if (files.length > limits.outboundFileCount) {
    throw new Error(`email: too many attachments (${files.length} > ${limits.outboundFileCount})`);
  }

  let total = 0;
  for (const file of files) {
    const size = file.data.byteLength;
    if (size > limits.outboundFileBytes) {
      throw new Error(
        `email: attachment "${file.filename}" is ${size} bytes, limit ${limits.outboundFileBytes} ` +
          `(${formatBytes(size)} > ${formatBytes(limits.outboundFileBytes)})`,
      );
    }
    total += size;
  }
  if (total > limits.outboundTotalBytes) {
    throw new Error(
      `email: attachments total ${total} bytes, limit ${limits.outboundTotalBytes} ` +
        `(${formatBytes(total)} > ${formatBytes(limits.outboundTotalBytes)})`,
    );
  }

  return files.map((file) => ({
    filename: file.filename,
    content: file.data,
    contentType: mimeForFilename(file.filename),
  }));
}

/**
 * Convert decoded MIME parts into the inbox-staging shape, skipping what does
 * not fit and reporting each skip.
 *
 * cid-referenced inline parts are dropped silently and on purpose: otherwise
 * every mail from anyone with a logo in their signature arrives with an
 * `image001.png` the agent has to reason about.
 */
export function buildInboundAttachments(parts: EmailAttachmentPart[], limits: EmailLimits): InboundAttachmentResult {
  const attachments: StagedAttachment[] = [];
  const notes: string[] = [];
  let total = 0;

  for (const [index, part] of parts.entries()) {
    if (part.related === true || (part.contentDisposition === 'inline' && part.cid)) continue;

    const mimeType = part.contentType ?? 'application/octet-stream';
    const rawName = part.filename;
    const name =
      typeof rawName === 'string' && isSafeAttachmentName(rawName)
        ? rawName
        : `attachment-${index + 1}.${extensionForMime(part.contentType)}`;

    if (attachments.length >= limits.inboundFileCount) {
      notes.push(`[attachment omitted: ${name}, more than ${limits.inboundFileCount} attachments]`);
      continue;
    }

    const size = part.content.byteLength;
    if (size > limits.inboundFileBytes) {
      notes.push(`[attachment omitted: ${name}, ${formatBytes(size)} > ${formatBytes(limits.inboundFileBytes)} limit]`);
      continue;
    }
    if (total + size > limits.inboundTotalBytes) {
      notes.push(
        `[attachment omitted: ${name}, total attachment limit ${formatBytes(limits.inboundTotalBytes)} reached]`,
      );
      continue;
    }

    total += size;
    attachments.push({ name, data: part.content.toString('base64'), size, mimeType });
  }

  return { attachments, notes };
}
