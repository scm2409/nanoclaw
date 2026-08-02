/**
 * Pure inbound-parsing helpers. Two of these are load-bearing for safety:
 *
 *  - normalizeAddress produces the string that BOTH the allowlist lookup and
 *    the platform_id are built from. If it normalized inconsistently, an
 *    address could pass the allowlist under one spelling and be routed under
 *    another.
 *  - isAutomatedMail is the mail-loop brake. Email is the one channel where a
 *    reply can provoke an automatic reply, forever, at the speed of SMTP.
 */
import { describe, expect, it } from 'vitest';

import { isAutomatedMail, normalizeAddress, stripQuotedReply } from './email-parse.js';

describe('normalizeAddress', () => {
  it('lowercases and trims a bare address', () => {
    expect(normalizeAddress('  Martin@Example.ORG ')).toBe('martin@example.org');
  });

  it('extracts the address from a display-name form', () => {
    expect(normalizeAddress('Martin Schoegler <Martin@Example.org>')).toBe('martin@example.org');
    expect(normalizeAddress('"Schoegler, Martin" <m@x.de>')).toBe('m@x.de');
  });

  // Plus-addressing identifies a distinct recipient at most providers. Folding
  // it away would let a+anything@ inherit a's allowlist entry.
  it('preserves plus-addressing', () => {
    expect(normalizeAddress('kail+news@example.org')).toBe('kail+news@example.org');
  });

  it('rejects anything that is not a single address', () => {
    expect(normalizeAddress('')).toBeNull();
    expect(normalizeAddress('not an address')).toBeNull();
    expect(normalizeAddress('a@b.de, c@d.de')).toBeNull();
    expect(normalizeAddress('@example.org')).toBeNull();
    expect(normalizeAddress('a@')).toBeNull();
  });
});

describe('isAutomatedMail', () => {
  it('passes an ordinary human mail', () => {
    expect(isAutomatedMail(new Map([['subject', 'Re: Angebot']]))).toBe(false);
  });

  it.each([
    ['auto-submitted', 'auto-replied'],
    ['auto-submitted', 'auto-generated'],
    ['precedence', 'bulk'],
    ['precedence', 'list'],
    ['precedence', 'junk'],
    ['list-id', '<news.example.org>'],
    ['list-unsubscribe', '<mailto:x@y.de>'],
    ['x-auto-response-suppress', 'OOF'],
    ['x-autoreply', 'yes'],
  ])('flags %s: %s', (header, value) => {
    expect(isAutomatedMail(new Map([[header, value]]))).toBe(true);
  });

  // RFC 3834: `Auto-Submitted: no` is the explicit "I am a real message" value.
  it('does not flag Auto-Submitted: no', () => {
    expect(isAutomatedMail(new Map([['auto-submitted', 'no']]))).toBe(false);
  });

  it('is case-insensitive on header names and values', () => {
    expect(isAutomatedMail(new Map([['Precedence', 'BULK']]))).toBe(true);
  });

  it('accepts a plain record as well as a Map', () => {
    expect(isAutomatedMail({ precedence: 'bulk' })).toBe(true);
    expect(isAutomatedMail({})).toBe(false);
  });
});

describe('stripQuotedReply', () => {
  it('cuts an attribution line and everything after it', () => {
    const body = ['Passt so, danke.', '', 'On Fri, 1 Aug 2026 at 10:00, KaiL01 <k@x.de> wrote:', '> alter text'].join(
      '\n',
    );
    expect(stripQuotedReply(body)).toBe('Passt so, danke.');
  });

  it('cuts the German attribution line', () => {
    const body = 'Ja.\n\nAm 01.08.2026 um 10:00 schrieb KaiL01:\n> alter text';
    expect(stripQuotedReply(body)).toBe('Ja.');
  });

  it('cuts a signature delimiter', () => {
    expect(stripQuotedReply('Kurz und gut.\n\n-- \nMartin\nTel 123')).toBe('Kurz und gut.');
  });

  it('leaves a mail that quotes nothing untouched', () => {
    expect(stripQuotedReply('Eine Zeile.\nNoch eine.')).toBe('Eine Zeile.\nNoch eine.');
  });

  // Never return empty: an agent seeing "" has no idea a message arrived.
  it('keeps the original when stripping would empty the body', () => {
    const quoteOnly = '> nur zitat\n> mehr zitat';
    expect(stripQuotedReply(quoteOnly)).toBe(quoteOnly);
  });
});
