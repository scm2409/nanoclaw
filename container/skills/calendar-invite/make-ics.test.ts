/**
 * The point of this script is that nobody can eyeball an .ics for correctness:
 * the properties a mail client silently rejects an invitation over — CRLF line
 * endings, 75-octet folding, TEXT escaping, a DTEND that is exclusive for
 * all-day events — are invisible in a rendered preview. So they are pinned
 * here rather than left to whoever writes the file by hand.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildIcs, durationToIcs, escapeText, foldLine, parseDuration, run, toUtcStamp } from './make-ics.js';

const ORGANIZER = { address: 'kail@example.org', name: 'KaiL01' };
const ATTENDEE = { address: 'martin@example.org', name: 'Martin' };

/** Reverse the 75-octet folding, the way a client does before parsing. */
function unfold(ics: string): string {
  return ics.split('\r\n ').join('');
}

function unfoldedLines(ics: string): string[] {
  return unfold(ics).split('\r\n');
}

function invite(overrides: Partial<Parameters<typeof buildIcs>[0]> = {}) {
  return buildIcs({
    uid: 'uid-1',
    summary: 'Zahnarzt',
    start: '2026-08-05T14:00',
    durationMinutes: 30,
    timeZone: 'Europe/Vienna',
    organizer: ORGANIZER,
    attendees: [ATTENDEE],
    now: new Date('2026-08-02T09:15:00Z'),
    ...overrides,
  });
}

describe('escapeText', () => {
  it('escapes the four characters that are structural in a TEXT value', () => {
    expect(escapeText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
  });

  it('escapes the backslash before anything else, not after', () => {
    // Getting the order wrong turns a literal backslash into an escaped comma.
    expect(escapeText('\\,')).toBe('\\\\\\,');
  });

  it('normalises CRLF in the input to a single escaped newline', () => {
    expect(escapeText('a\r\nb')).toBe('a\\nb');
  });
});

describe('foldLine', () => {
  it('leaves a line of exactly 75 octets alone', () => {
    const line = 'X'.repeat(75);
    expect(foldLine(line)).toBe(line);
  });

  it('folds a longer line with a leading space on the continuation', () => {
    const folded = foldLine('X'.repeat(80));
    expect(folded).toBe(`${'X'.repeat(75)}\r\n ${'X'.repeat(5)}`);
  });

  // Folding counts octets, but a split inside a multi-byte character produces
  // a file that is no longer valid UTF-8 at all.
  it('never splits a multi-byte character', () => {
    const folded = foldLine(`SUMMARY:${'ä'.repeat(60)}`);
    for (const segment of folded.split('\r\n')) {
      expect(Buffer.byteLength(segment, 'utf8')).toBeLessThanOrEqual(75);
    }
    // Unfolding is "drop CRLF plus the one following space" — the result has to
    // be the original line back, byte for byte.
    expect(folded.split('\r\n ').join('')).toBe(`SUMMARY:${'ä'.repeat(60)}`);
  });
});

describe('toUtcStamp', () => {
  it('converts summer wall-clock time in Vienna (UTC+2)', () => {
    expect(toUtcStamp('2026-08-05T14:00', 'Europe/Vienna')).toBe('20260805T120000Z');
  });

  it('converts winter wall-clock time in Vienna (UTC+1)', () => {
    expect(toUtcStamp('2026-01-15T14:00', 'Europe/Vienna')).toBe('20260115T130000Z');
  });

  it('handles a time on the far side of the spring-forward boundary', () => {
    // 2026-03-29 02:00 local is when Vienna jumps to +2.
    expect(toUtcStamp('2026-03-29T03:30', 'Europe/Vienna')).toBe('20260329T013000Z');
  });

  it('treats UTC as itself', () => {
    expect(toUtcStamp('2026-08-05T14:00', 'UTC')).toBe('20260805T140000Z');
  });
});

describe('parseDuration', () => {
  it('reads minutes, hours, and both together', () => {
    expect(parseDuration('30m')).toBe(30);
    expect(parseDuration('2h')).toBe(120);
    expect(parseDuration('1h30m')).toBe(90);
  });

  // Days matter for reminders ("the day before"), not for appointment lengths.
  it('reads days, alone and combined', () => {
    expect(parseDuration('1d')).toBe(1440);
    expect(parseDuration('1d2h')).toBe(1560);
  });

  it('rejects anything it cannot read rather than guessing', () => {
    expect(() => parseDuration('halbe Stunde')).toThrow(/duration/i);
    expect(() => parseDuration('0m')).toThrow(/duration/i);
  });
});

describe('durationToIcs', () => {
  it('writes the shortest form the spec allows for each unit', () => {
    expect(durationToIcs(15)).toBe('PT15M');
    expect(durationToIcs(60)).toBe('PT1H');
    expect(durationToIcs(90)).toBe('PT1H30M');
    expect(durationToIcs(1440)).toBe('P1D');
    expect(durationToIcs(1500)).toBe('P1DT1H');
  });
});

describe('buildIcs', () => {
  it('ends every line with CRLF, including the last', () => {
    const ics = invite();
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.split('\r\n').join('')).not.toContain('\n');
  });

  it('carries the properties a client needs to treat this as an invitation', () => {
    const lines = unfoldedLines(invite());
    expect(lines).toContain('METHOD:REQUEST');
    expect(lines).toContain('VERSION:2.0');
    expect(lines).toContain('CALSCALE:GREGORIAN');
    expect(lines).toContain('UID:uid-1');
    expect(lines).toContain('SEQUENCE:0');
    expect(lines).toContain('STATUS:CONFIRMED');
    expect(lines).toContain('TRANSP:OPAQUE');
    expect(lines).toContain('DTSTAMP:20260802T091500Z');
    expect(lines).toContain('ORGANIZER;CN="KaiL01":mailto:kail@example.org');
    expect(lines).toContain(
      'ATTENDEE;CN="Martin";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:martin@example.org',
    );
  });

  it('derives DTEND from the duration', () => {
    const lines = unfoldedLines(invite());
    expect(lines).toContain('DTSTART:20260805T120000Z');
    expect(lines).toContain('DTEND:20260805T123000Z');
  });

  it('takes an explicit end over a duration', () => {
    const lines = unfoldedLines(invite({ end: '2026-08-05T16:00', durationMinutes: undefined }));
    expect(lines).toContain('DTEND:20260805T140000Z');
  });

  it('rejects an event with neither an end nor a duration', () => {
    expect(() => invite({ durationMinutes: undefined })).toThrow(/end|duration/i);
  });

  it('rejects an end before its start', () => {
    expect(() => invite({ end: '2026-08-05T13:00', durationMinutes: undefined })).toThrow(/before/i);
  });

  // DTEND is exclusive for VALUE=DATE: a one-day event on the 5th ends on the
  // 6th. Off by one here and every all-day invitation is a day too short.
  it('writes an exclusive DTEND for an all-day event', () => {
    const lines = unfoldedLines(invite({ allDay: true, start: '2026-08-05', durationMinutes: undefined }));
    expect(lines).toContain('DTSTART;VALUE=DATE:20260805');
    expect(lines).toContain('DTEND;VALUE=DATE:20260806');
  });

  it('treats an all-day end as the last day the event covers', () => {
    const lines = unfoldedLines(
      invite({ allDay: true, start: '2026-08-05', end: '2026-08-07', durationMinutes: undefined }),
    );
    expect(lines).toContain('DTEND;VALUE=DATE:20260808');
  });

  it('escapes and folds the text properties', () => {
    const ics = invite({ description: 'Erstens, zweitens; drittens\nviertens' });
    expect(ics).toContain('DESCRIPTION:Erstens\\, zweitens\\; drittens\\nviertens');
    for (const line of ics.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    }
  });

  it('omits optional properties instead of writing them empty', () => {
    const ics = invite();
    expect(ics).not.toContain('LOCATION');
    expect(ics).not.toContain('DESCRIPTION');
  });

  // Parameter values are not TEXT: a comma inside DQUOTE is literal, and a
  // backslash escape there is not defined at all. Only DQUOTE itself has to go.
  it('quotes a common name containing a structural character rather than escaping it', () => {
    const ics = invite({ attendees: [{ address: 'm@example.org', name: 'Schögler, Martin' }] });
    expect(ics).toContain('CN="Schögler, Martin"');
  });

  it('strips a double quote from a common name', () => {
    const ics = invite({ attendees: [{ address: 'm@example.org', name: 'Martin "Schögi"' }] });
    expect(ics).toContain('CN="Martin Schögi"');
  });

  it('requires at least one attendee — an invitation with nobody to invite is a bug', () => {
    expect(() => invite({ attendees: [] })).toThrow(/attendee/i);
  });

  // Whether the recipient's client honours the organizer's alarm or replaces it
  // with its own default is the client's call — but an invitation carrying no
  // VALARM at all can never produce a reminder, so the block has to be right.
  describe('reminders', () => {
    it('writes no VALARM when none was asked for', () => {
      expect(invite()).not.toContain('VALARM');
    });

    it('writes a display alarm triggered before the start', () => {
      const lines = unfoldedLines(invite({ reminderMinutes: [15] }));
      expect(lines).toContain('BEGIN:VALARM');
      expect(lines).toContain('ACTION:DISPLAY');
      expect(lines).toContain('TRIGGER:-PT15M');
      // DISPLAY alarms are required to carry a description; without one some
      // clients drop the whole block.
      expect(lines).toContain('DESCRIPTION:Zahnarzt');
      expect(lines).toContain('END:VALARM');
    });

    it('writes one block per reminder', () => {
      const ics = invite({ reminderMinutes: [15, 1440] });
      expect(ics.match(/BEGIN:VALARM/g)).toHaveLength(2);
      const lines = unfoldedLines(ics);
      expect(lines).toContain('TRIGGER:-PT15M');
      expect(lines).toContain('TRIGGER:-P1D');
    });

    it('keeps the alarms inside the event', () => {
      const lines = unfoldedLines(invite({ reminderMinutes: [15] }));
      expect(lines.indexOf('BEGIN:VALARM')).toBeGreaterThan(lines.indexOf('BEGIN:VEVENT'));
      expect(lines.indexOf('END:VALARM')).toBeLessThan(lines.indexOf('END:VEVENT'));
    });
  });
});

describe('run', () => {
  let dir: string;
  let outDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-invite-'));
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-invite-out-'));
    process.env.CALENDAR_INVITE_DIR = dir;
    process.env.CALENDAR_INVITE_OUT_DIR = outDir;
  });

  afterEach(() => {
    delete process.env.CALENDAR_INVITE_DIR;
    delete process.env.CALENDAR_INVITE_OUT_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  function create(extra: string[] = []) {
    return JSON.parse(
      run(['create', '--summary', 'Zahnarzt', '--start', '2026-08-05T14:00', '--duration', '30m', ...extra]),
    );
  }

  // The script cannot know the host's mailbox address, and a wrong ORGANIZER
  // sends every RSVP into the void — so it refuses rather than guesses.
  it('refuses to create anything before the organizer is configured', () => {
    expect(() => create()).toThrow(/config set --organizer/);
  });

  it('reports the configured organizer back', () => {
    run(['config', 'set', '--organizer', 'kail@example.org', '--organizer-name', 'KaiL01']);
    expect(JSON.parse(run(['config', 'show']))).toMatchObject({
      organizer: 'kail@example.org',
      organizerName: 'KaiL01',
    });
  });

  it('writes a file the send_file tool can pick up', () => {
    run(['config', 'set', '--organizer', 'kail@example.org', '--organizer-name', 'KaiL01']);
    const out = create(['--attendee', 'martin@example.org:Martin', '--location', 'Ordination']);

    expect(out.filename).toMatch(/^invite-.+\.ics$/);
    expect(out.path).toBe(path.join(outDir, out.filename));
    expect(out.summary).toBe('Zahnarzt');
    expect(out.humanSummary).toContain('Zahnarzt');

    const ics = unfold(fs.readFileSync(out.path, 'utf8'));
    expect(ics).toContain(`UID:${out.uid}`);
    expect(ics).toContain('METHOD:REQUEST');
    expect(ics).toContain('LOCATION:Ordination');
    expect(ics).toContain('mailto:martin@example.org');
  });

  it('gives every invitation its own UID and file', () => {
    run(['config', 'set', '--organizer', 'kail@example.org']);
    const first = create(['--attendee', 'martin@example.org']);
    const second = create(['--attendee', 'martin@example.org']);
    expect(second.uid).not.toBe(first.uid);
    expect(second.path).not.toBe(first.path);
  });

  it('names the missing flag when a required one is absent', () => {
    run(['config', 'set', '--organizer', 'kail@example.org']);
    expect(() => run(['create', '--start', '2026-08-05T14:00', '--duration', '30m'])).toThrow(/--summary/);
    expect(() => run(['create', '--summary', 'X', '--duration', '30m'])).toThrow(/--start/);
  });

  it('passes reminders through to the file', () => {
    run(['config', 'set', '--organizer', 'kail@example.org']);
    const out = create(['--attendee', 'martin@example.org', '--reminder', '15m', '--reminder', '1d']);
    const ics = unfold(fs.readFileSync(out.path, 'utf8'));
    expect(ics).toContain('TRIGGER:-PT15M');
    expect(ics).toContain('TRIGGER:-P1D');
  });

  it('rejects an unknown flag instead of silently ignoring it', () => {
    run(['config', 'set', '--organizer', 'kail@example.org']);
    expect(() => create(['--recurring', 'weekly'])).toThrow(/--recurring/);
  });

  it('rejects an unknown command', () => {
    expect(() => run(['delete', '--uid', 'x'])).toThrow(/delete/);
  });

  // The .ics only has to survive until send_file copies it into the outbox.
  // Left in the workspace it would accumulate one dead file per appointment
  // forever, so it goes to the container's scratch space, which the workspace
  // is not — while the organizer config, which must survive, stays put.
  it('keeps the invitation out of the persistent workspace directory', () => {
    run(['config', 'set', '--organizer', 'kail@example.org']);
    const out = create(['--attendee', 'martin@example.org']);

    expect(out.path.startsWith(outDir)).toBe(true);
    expect(out.path.startsWith(dir)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual(['config.json']);
  });

  it('defaults the output to the system scratch directory, not the workspace', () => {
    delete process.env.CALENDAR_INVITE_OUT_DIR;
    run(['config', 'set', '--organizer', 'kail@example.org']);
    const out = create(['--attendee', 'martin@example.org']);

    expect(out.path.startsWith(os.tmpdir())).toBe(true);
    expect(out.path.startsWith(dir)).toBe(false);
    fs.rmSync(out.path, { force: true });
  });
});
