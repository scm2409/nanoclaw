/**
 * Build an iMIP calendar invitation (.ics, METHOD:REQUEST) for mailing.
 *
 * The agent has no write access to the recipient's calendar, so an invitation
 * is the handoff: the recipient reviews it in their mail client and accepting
 * is what actually creates the event. That makes the file the whole contract —
 * and the parts of RFC 5545 that decide whether a client accepts it at all
 * (CRLF endings, 75-octet folding, TEXT escaping, an exclusive DTEND for
 * all-day events) are exactly the parts nobody can spot in a preview. Hence a
 * script rather than a prompt telling the agent to write one by hand.
 *
 * Deliberately absent: updating and cancelling (would need a UID journal) and
 * recurrence (RRULE with UTC stamps drifts by an hour across a DST boundary;
 * doing it properly needs TZID plus a VTIMEZONE block).
 *
 * node: stdlib only. It runs under Bun in the container and under Node in the
 * host test suite, and the skill mount is read-only — nothing may be installed
 * or written next to this file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export interface Participant {
  address: string;
  name?: string;
}

export interface InviteInput {
  uid: string;
  summary: string;
  /** Local wall-clock time `YYYY-MM-DDTHH:mm`, or `YYYY-MM-DD` when allDay. */
  start: string;
  /** Same shape as start. For all-day events this is the last day covered. */
  end?: string;
  durationMinutes?: number;
  timeZone: string;
  allDay?: boolean;
  location?: string;
  description?: string;
  /** Minutes before the start, one alarm each. */
  reminderMinutes?: number[];
  organizer: Participant;
  attendees: Participant[];
  /** DTSTAMP source; injectable so the output is reproducible under test. */
  now?: Date;
}

const PRODID = '-//NanoClaw//calendar-invite//EN';
const DEFAULT_TIME_ZONE = 'Europe/Vienna';
const MAX_OCTETS = 75;

// ---------------------------------------------------------------- primitives

/** Escape a TEXT value. Backslash first, or it re-escapes its own output. */
export function escapeText(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r/g, '\\n')
    .replace(/\n/g, '\\n');
}

/**
 * Fold to 75 octets per line, continuations prefixed with a single space.
 *
 * The limit is octets, but the split has to fall on a character boundary —
 * cutting a multi-byte character in half produces a file that is not even
 * valid UTF-8.
 */
export function foldLine(line: string): string {
  const out: string[] = [];
  let current = '';
  let currentBytes = 0;
  let limit = MAX_OCTETS;

  for (const char of line) {
    const size = Buffer.byteLength(char, 'utf8');
    if (currentBytes + size > limit) {
      out.push(current);
      current = '';
      currentBytes = 1; // the leading space of the continuation line
      limit = MAX_OCTETS;
    }
    current += char;
    currentBytes += size;
  }
  out.push(current);

  return out.map((segment, index) => (index === 0 ? segment : ` ${segment}`)).join('\r\n');
}

/**
 * A parameter value is not TEXT: inside DQUOTE a comma or colon is literal and
 * a backslash escape is undefined. Only DQUOTE itself (and control characters)
 * cannot appear, so those are dropped.
 */
function quoteParam(value: string): string {
  return `"${value.replace(/["\r\n]/g, '').trim()}"`;
}

export function parseDuration(raw: string): number {
  const match = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/.exec(raw.trim());
  const minutes = match
    ? Number(match[1] ?? 0) * 1440 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)
    : 0;
  if (!match || minutes <= 0) {
    throw new Error(`Unreadable duration "${raw}" — use a form like 30m, 2h, 1h30m, or 1d.`);
  }
  return minutes;
}

/** Minutes as an RFC 5545 duration, e.g. 1500 → `P1DT1H`. */
export function durationToIcs(minutes: number): string {
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const time = `${hours > 0 ? `${hours}H` : ''}${mins > 0 ? `${mins}M` : ''}`;
  return `P${days > 0 ? `${days}D` : ''}${time ? `T${time}` : ''}`;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function parseWallClock(raw: string, allDay: boolean): WallClock {
  const pattern = allDay ? /^(\d{4})-(\d{2})-(\d{2})$/ : /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/;
  const match = pattern.exec(raw.trim());
  if (!match) {
    throw new Error(
      allDay
        ? `Unreadable date "${raw}" — use YYYY-MM-DD for an all-day event.`
        : `Unreadable date/time "${raw}" — use YYYY-MM-DDTHH:mm in local time.`,
    );
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4] ?? 0),
    minute: Number(match[5] ?? 0),
  };
}

/** Minutes that the zone is ahead of UTC at the given instant. */
function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const field = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const hour = field('hour') % 24; // some engines render midnight as 24
  const asUtc = Date.UTC(field('year'), field('month') - 1, field('day'), hour, field('minute'), field('second'));
  return (asUtc - instant.getTime()) / 60_000;
}

function wallClockToMs(wall: WallClock, timeZone: string): number {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0);
  // Two passes: the offset that applies is the one at the *resulting* instant,
  // which differs from the naive guess right around a DST transition.
  const firstPass = naive - zoneOffsetMinutes(new Date(naive), timeZone) * 60_000;
  return naive - zoneOffsetMinutes(new Date(firstPass), timeZone) * 60_000;
}

function utcStampFromMs(ms: number): string {
  return `${new Date(ms).toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
}

/** Local wall-clock time in `timeZone` → a UTC `YYYYMMDDTHHMMSSZ` stamp. */
export function toUtcStamp(local: string, timeZone: string): string {
  return utcStampFromMs(wallClockToMs(parseWallClock(local, false), timeZone));
}

function dateStamp(wall: WallClock, addDays = 0): string {
  const ms = Date.UTC(wall.year, wall.month - 1, wall.day + addDays);
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}

// -------------------------------------------------------------------- render

function participantLine(property: string, participant: Participant, extraParams: string[] = []): string {
  const params = participant.name ? [`CN=${quoteParam(participant.name)}`, ...extraParams] : extraParams;
  const prefix = params.length > 0 ? `${property};${params.join(';')}` : property;
  return `${prefix}:mailto:${participant.address}`;
}

export function buildIcs(input: InviteInput): string {
  const allDay = input.allDay === true;
  const timeZone = input.timeZone || DEFAULT_TIME_ZONE;

  if (!input.summary?.trim()) throw new Error('An invitation needs a summary.');
  if (input.attendees.length === 0) throw new Error('An invitation needs at least one attendee.');
  for (const person of [input.organizer, ...input.attendees]) {
    if (!person.address?.includes('@')) {
      throw new Error(`Not an email address: "${person.address}"`);
    }
  }

  const start = parseWallClock(input.start, allDay);
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${input.uid}`,
    `DTSTAMP:${utcStampFromMs((input.now ?? new Date()).getTime())}`,
  ];

  if (allDay) {
    // DTEND is exclusive for VALUE=DATE, and an operator naming an end day
    // means the last day the event covers — so it is always one day on.
    const lastDay = input.end ? parseWallClock(input.end, true) : start;
    if (Date.UTC(lastDay.year, lastDay.month - 1, lastDay.day) < Date.UTC(start.year, start.month - 1, start.day)) {
      throw new Error('The end day is before the start day.');
    }
    lines.push(`DTSTART;VALUE=DATE:${dateStamp(start)}`, `DTEND;VALUE=DATE:${dateStamp(lastDay, 1)}`);
  } else {
    const startMs = wallClockToMs(start, timeZone);
    let endMs: number;
    if (input.end) {
      endMs = wallClockToMs(parseWallClock(input.end, false), timeZone);
      if (endMs <= startMs) throw new Error('The end is before the start.');
    } else if (input.durationMinutes) {
      endMs = startMs + input.durationMinutes * 60_000;
    } else {
      throw new Error('An invitation needs either an end or a duration.');
    }
    lines.push(`DTSTART:${utcStampFromMs(startMs)}`, `DTEND:${utcStampFromMs(endMs)}`);
  }

  lines.push(`SUMMARY:${escapeText(input.summary.trim())}`);
  if (input.location?.trim()) lines.push(`LOCATION:${escapeText(input.location.trim())}`);
  if (input.description?.trim()) lines.push(`DESCRIPTION:${escapeText(input.description.trim())}`);
  lines.push(
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'SEQUENCE:0',
    participantLine('ORGANIZER', input.organizer),
    ...input.attendees.map((attendee) =>
      participantLine('ATTENDEE', attendee, ['ROLE=REQ-PARTICIPANT', 'PARTSTAT=NEEDS-ACTION', 'RSVP=TRUE']),
    ),
    // A DISPLAY alarm must carry a description; some clients drop the whole
    // block without one. Whether the recipient's client honours these at all or
    // substitutes its own defaults on accept is the client's decision.
    ...(input.reminderMinutes ?? []).flatMap((minutes) => [
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeText(input.summary.trim())}`,
      `TRIGGER:-${durationToIcs(minutes)}`,
      'END:VALARM',
    ]),
    'END:VEVENT',
    'END:VCALENDAR',
  );

  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

// ----------------------------------------------------------------------- CLI

interface Config {
  organizer?: string;
  organizerName?: string;
}

/** Where the organizer config lives. Persistent, because it must survive. */
function baseDir(): string {
  return process.env.CALENDAR_INVITE_DIR || '/workspace/agent/calendar';
}

/**
 * Where the .ics is written. Scratch space, deliberately *not* the workspace:
 * the file only has to live until send_file copies it into the outbox, and the
 * workspace is persistent — leaving it there would accumulate one dead file per
 * appointment, forever, with nothing ever reading them again.
 */
function outDir(): string {
  return process.env.CALENDAR_INVITE_OUT_DIR || path.join(os.tmpdir(), 'calendar-invite');
}

function configPath(): string {
  return path.join(baseDir(), 'config.json');
}

function readConfig(): Config {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Config;
  } catch {
    return {};
  }
}

function writeConfig(config: Config): void {
  fs.mkdirSync(baseDir(), { recursive: true });
  fs.writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`);
}

type Flags = Record<string, string | string[]>;

function parseFlags(argv: string[], known: string[], repeatable: string[] = []): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument "${token}".`);
    const name = token.slice(2);
    if (!known.includes(name)) {
      throw new Error(`Unknown flag "--${name}". Known flags: ${known.map((k) => `--${k}`).join(', ')}`);
    }
    if (name === 'all-day') {
      flags[name] = 'true';
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Flag --${name} needs a value.`);
    i += 1;
    if (repeatable.includes(name)) {
      flags[name] = [...((flags[name] as string[]) ?? []), value];
    } else {
      flags[name] = value;
    }
  }
  return flags;
}

function one(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return Array.isArray(value) ? value[0] : value;
}

function parseParticipant(raw: string): Participant {
  const separator = raw.indexOf(':');
  if (separator === -1) return { address: raw.trim() };
  return { address: raw.slice(0, separator).trim(), name: raw.slice(separator + 1).trim() || undefined };
}

const CREATE_FLAGS = [
  'summary',
  'start',
  'end',
  'duration',
  'all-day',
  'tz',
  'location',
  'description',
  'attendee',
  'reminder',
];

/**
 * Run one command and return the JSON line the agent reads. Throws on any
 * problem — the CLI wrapper turns that into a message on stderr and exit 1,
 * so a half-built invitation never reaches a mailbox.
 */
export function run(argv: string[]): string {
  const [command, ...rest] = argv;

  if (command === 'config') {
    const [sub, ...subArgs] = rest;
    if (sub === 'show') return JSON.stringify(readConfig());
    if (sub === 'set') {
      const flags = parseFlags(subArgs, ['organizer', 'organizer-name']);
      const config = readConfig();
      const organizer = one(flags, 'organizer');
      if (organizer) {
        if (!organizer.includes('@')) throw new Error(`Not an email address: "${organizer}"`);
        config.organizer = organizer;
      }
      const organizerName = one(flags, 'organizer-name');
      if (organizerName) config.organizerName = organizerName;
      writeConfig(config);
      return JSON.stringify(config);
    }
    throw new Error(`Unknown config command "${sub ?? ''}". Use: config show | config set`);
  }

  if (command !== 'create') {
    throw new Error(`Unknown command "${command ?? ''}". Use: create | config set | config show`);
  }

  const flags = parseFlags(rest, CREATE_FLAGS, ['attendee', 'reminder']);
  const config = readConfig();
  if (!config.organizer) {
    throw new Error(
      'No organizer configured. The organizer must be the mailbox the invitation is sent from — ' +
        'ask the user which address that is, then run: ' +
        'make-ics.ts config set --organizer <address> [--organizer-name <name>]',
    );
  }

  const summary = one(flags, 'summary');
  if (!summary) throw new Error('--summary is required.');
  const start = one(flags, 'start');
  if (!start) throw new Error('--start is required.');

  const attendees = ((flags.attendee as string[]) ?? []).map(parseParticipant);
  if (attendees.length === 0) {
    throw new Error('--attendee is required — an invitation needs someone to invite.');
  }

  const durationRaw = one(flags, 'duration');
  const uid = randomUUID();
  const ics = buildIcs({
    uid,
    summary,
    start,
    end: one(flags, 'end'),
    durationMinutes: durationRaw ? parseDuration(durationRaw) : undefined,
    timeZone: one(flags, 'tz') || process.env.TZ || DEFAULT_TIME_ZONE,
    allDay: one(flags, 'all-day') === 'true',
    location: one(flags, 'location'),
    description: one(flags, 'description'),
    reminderMinutes: ((flags.reminder as string[]) ?? []).map(parseDuration),
    organizer: { address: config.organizer, name: config.organizerName },
    attendees,
  });

  const target = outDir();
  fs.mkdirSync(target, { recursive: true });
  const filename = `invite-${uid}.ics`;
  const outPath = path.join(target, filename);
  fs.writeFileSync(outPath, ics);

  const when = one(flags, 'all-day') === 'true' ? start : `${start}${durationRaw ? ` (${durationRaw})` : ''}`;
  return JSON.stringify({
    uid,
    path: outPath,
    filename,
    summary,
    humanSummary: `${summary} — ${when}, ${attendees.map((a) => a.address).join(', ')}`,
  });
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    console.log(run(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
