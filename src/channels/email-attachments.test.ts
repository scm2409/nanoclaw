/**
 * Attachment handling in both directions.
 *
 * The asymmetry is deliberate and is what these tests pin down:
 *
 *  - OUTBOUND is all-or-nothing. Sending the text of a mail while silently
 *    dropping the attachment the text refers to is the worst outcome, because
 *    the recipient has no way to notice. So a limit breach throws before
 *    anything is handed to SMTP.
 *  - INBOUND is best-effort. Refusing a whole message because one attachment
 *    is oversized would hide the sender's words too, so oversized parts are
 *    skipped and replaced by a visible note in the message text.
 */
import { describe, expect, it } from 'vitest';

import { buildInboundAttachments, checkOutboundAttachments } from './email-attachments.js';
import { DEFAULT_EMAIL_LIMITS, type EmailLimits } from './email-limits.js';

const LIMITS: EmailLimits = {
  ...DEFAULT_EMAIL_LIMITS,
  outboundFileBytes: 1000,
  outboundTotalBytes: 1500,
  outboundFileCount: 2,
  inboundFileBytes: 1000,
  inboundTotalBytes: 1500,
  inboundFileCount: 2,
};

function file(filename: string, bytes: number) {
  return { filename, data: Buffer.alloc(bytes, 0x41) };
}

describe('checkOutboundAttachments', () => {
  it('returns an empty list when there are no files', () => {
    expect(checkOutboundAttachments(undefined, LIMITS)).toEqual([]);
    expect(checkOutboundAttachments([], LIMITS)).toEqual([]);
  });

  it('passes files through with a content type derived from the extension', () => {
    const out = checkOutboundAttachments([file('report.pdf', 10), file('notes.txt', 10)], LIMITS);
    expect(out).toEqual([
      { filename: 'report.pdf', content: expect.any(Buffer), contentType: 'application/pdf' },
      { filename: 'notes.txt', content: expect.any(Buffer), contentType: 'text/plain' },
    ]);
  });

  it('falls back to application/octet-stream for an unknown extension', () => {
    expect(checkOutboundAttachments([file('blob.zzz', 10)], LIMITS)[0].contentType).toBe('application/octet-stream');
  });

  it('throws when one file exceeds the per-file limit', () => {
    expect(() => checkOutboundAttachments([file('big.bin', 1001)], LIMITS)).toThrow(
      /attachment "big\.bin" is 1001 bytes, limit 1000/,
    );
  });

  it('throws when the total exceeds the total limit even though each file fits', () => {
    expect(() => checkOutboundAttachments([file('a.bin', 900), file('b.bin', 900)], LIMITS)).toThrow(
      /attachments total 1800 bytes, limit 1500/,
    );
  });

  it('throws when there are too many files', () => {
    expect(() => checkOutboundAttachments([file('a', 1), file('b', 1), file('c', 1)], LIMITS)).toThrow(
      /too many attachments \(3 > 2\)/,
    );
  });

  // Off-by-one here means either a rejected mail that should have gone out or
  // an accepted one that the SMTP server will bounce.
  it('accepts a file exactly on the limit and rejects one byte more', () => {
    expect(checkOutboundAttachments([file('exact.bin', 1000)], LIMITS)).toHaveLength(1);
    expect(() => checkOutboundAttachments([file('over.bin', 1001)], LIMITS)).toThrow();
  });

  it('accepts a total exactly on the limit', () => {
    expect(checkOutboundAttachments([file('a.bin', 750), file('b.bin', 750)], LIMITS)).toHaveLength(2);
  });
});

describe('buildInboundAttachments', () => {
  function part(overrides: Partial<Parameters<typeof buildInboundAttachments>[0][number]> = {}) {
    return {
      filename: 'doc.pdf',
      content: Buffer.alloc(10, 0x42),
      contentType: 'application/pdf',
      ...overrides,
    };
  }

  it('maps parts into the shape session-manager stages to the inbox', () => {
    const { attachments, notes } = buildInboundAttachments([part()], LIMITS);
    expect(notes).toEqual([]);
    expect(attachments).toEqual([
      {
        name: 'doc.pdf',
        data: Buffer.alloc(10, 0x42).toString('base64'),
        size: 10,
        mimeType: 'application/pdf',
      },
    ]);
  });

  it('skips an oversized part but keeps the rest and explains the gap', () => {
    const { attachments, notes } = buildInboundAttachments(
      [part({ filename: 'huge.bin', content: Buffer.alloc(1001) }), part({ filename: 'small.txt' })],
      LIMITS,
    );
    expect(attachments.map((a) => a.name)).toEqual(['small.txt']);
    expect(notes).toEqual(['[attachment omitted: huge.bin, 1001 B > 1000 B limit]']);
  });

  it('stops once the total budget is spent', () => {
    const { attachments, notes } = buildInboundAttachments(
      [
        part({ filename: 'a.bin', content: Buffer.alloc(900) }),
        part({ filename: 'b.bin', content: Buffer.alloc(900) }),
      ],
      LIMITS,
    );
    expect(attachments.map((a) => a.name)).toEqual(['a.bin']);
    expect(notes[0]).toContain('b.bin');
    expect(notes[0]).toContain('total');
  });

  it('stops once there are too many parts', () => {
    const { attachments, notes } = buildInboundAttachments(
      [part({ filename: 'a' }), part({ filename: 'b' }), part({ filename: 'c' })],
      LIMITS,
    );
    expect(attachments).toHaveLength(2);
    expect(notes[0]).toContain('c');
  });

  // Every mail from anyone with a logo in their signature would otherwise
  // arrive with an image001.png the agent has to reason about.
  it('skips cid-referenced inline images without a note', () => {
    const { attachments, notes } = buildInboundAttachments(
      [part({ filename: 'logo.png', contentDisposition: 'inline', cid: 'logo@sig', related: true })],
      LIMITS,
    );
    expect(attachments).toEqual([]);
    expect(notes).toEqual([]);
  });

  it('keeps a real inline attachment that nothing references', () => {
    const { attachments } = buildInboundAttachments(
      [part({ filename: 'scan.pdf', contentDisposition: 'inline' })],
      LIMITS,
    );
    expect(attachments.map((a) => a.name)).toEqual(['scan.pdf']);
  });

  it('invents a safe filename when the part has none', () => {
    const { attachments } = buildInboundAttachments([part({ filename: undefined })], LIMITS);
    expect(attachments[0].name).toBe('attachment-1.pdf');
  });

  // session-manager re-checks with isSafeAttachmentName, but a path-shaped
  // name would then be replaced by an opaque `attachment-<timestamp>` there.
  // Sanitising here keeps the extension, which the agent needs.
  it('replaces a path-shaped filename', () => {
    const { attachments } = buildInboundAttachments([part({ filename: '../../etc/passwd' })], LIMITS);
    expect(attachments[0].name).toBe('attachment-1.pdf');
  });

  it('returns nothing for an empty part list', () => {
    expect(buildInboundAttachments([], LIMITS)).toEqual({ attachments: [], notes: [] });
  });
});
