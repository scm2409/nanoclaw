/**
 * Attachment limits are the one thing standing between a runaway agent and a
 * host process that reads an arbitrarily large file into memory and hands it
 * to an SMTP server. These tests pin the defaults, the env-override path, and
 * — most important — that a nonsense override can never *disable* a limit.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_EMAIL_LIMITS, formatBytes, resolveEmailLimits } from './email-limits.js';

describe('resolveEmailLimits', () => {
  it('returns the documented defaults for an empty env', () => {
    expect(resolveEmailLimits({})).toEqual(DEFAULT_EMAIL_LIMITS);
    expect(DEFAULT_EMAIL_LIMITS.outboundFileBytes).toBe(10 * 1024 * 1024);
    expect(DEFAULT_EMAIL_LIMITS.outboundTotalBytes).toBe(20 * 1024 * 1024);
    expect(DEFAULT_EMAIL_LIMITS.outboundFileCount).toBe(10);
    expect(DEFAULT_EMAIL_LIMITS.inboundFileBytes).toBe(10 * 1024 * 1024);
    expect(DEFAULT_EMAIL_LIMITS.inboundTotalBytes).toBe(20 * 1024 * 1024);
    expect(DEFAULT_EMAIL_LIMITS.inboundFileCount).toBe(20);
  });

  it('reads every documented env override', () => {
    const limits = resolveEmailLimits({
      EMAIL_MAX_OUTBOUND_FILE_BYTES: '1024',
      EMAIL_MAX_OUTBOUND_TOTAL_BYTES: '2048',
      EMAIL_MAX_OUTBOUND_FILE_COUNT: '3',
      EMAIL_MAX_INBOUND_FILE_BYTES: '4096',
      EMAIL_MAX_INBOUND_TOTAL_BYTES: '8192',
      EMAIL_MAX_INBOUND_FILE_COUNT: '5',
    });
    expect(limits).toEqual({
      outboundFileBytes: 1024,
      outboundTotalBytes: 2048,
      outboundFileCount: 3,
      inboundFileBytes: 4096,
      inboundTotalBytes: 8192,
      inboundFileCount: 5,
    });
  });

  // A limit that silently becomes Infinity because someone typed `0` or
  // `unlimited` is worse than no limit at all — it looks configured.
  it.each(['0', '-1', 'unlimited', '', '  ', 'NaN', '1e999', '10MB'])(
    'falls back to the default for junk override %j',
    (value) => {
      const limits = resolveEmailLimits({ EMAIL_MAX_OUTBOUND_FILE_BYTES: value });
      expect(limits.outboundFileBytes).toBe(DEFAULT_EMAIL_LIMITS.outboundFileBytes);
    },
  );

  it('accepts a larger override — operators may know their provider', () => {
    expect(resolveEmailLimits({ EMAIL_MAX_OUTBOUND_FILE_BYTES: '52428800' }).outboundFileBytes).toBe(52428800);
  });

  it('truncates a fractional byte count rather than rejecting it', () => {
    expect(resolveEmailLimits({ EMAIL_MAX_OUTBOUND_FILE_COUNT: '3.7' }).outboundFileCount).toBe(3);
  });
});

describe('formatBytes', () => {
  it('renders human-readable sizes for the skip notes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(10 * 1024 * 1024)).toBe('10.0 MB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });
});
