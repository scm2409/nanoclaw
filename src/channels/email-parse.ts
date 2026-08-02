/**
 * Pure parsing helpers for the email channel. No IMAP, no DB, no env — kept
 * separate so the two safety-critical ones can be tested exhaustively.
 */

/** Case-insensitive header lookup across mailparser's Map and a plain record. */
function header(headers: Map<string, unknown> | Record<string, unknown>, name: string): string | undefined {
  const key = name.toLowerCase();
  if (headers instanceof Map) {
    for (const [k, v] of headers) {
      if (k.toLowerCase() === key) return v === undefined || v === null ? undefined : String(v);
    }
    return undefined;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === key) return v === undefined || v === null ? undefined : String(v);
  }
  return undefined;
}

// Deliberately conservative: no whitespace, no comma or semicolon (which would
// mean several addresses), and a dotted domain. The result of this function is
// used BOTH as the allowlist key and as the platform_id, so any spelling it
// lets through in one place it must let through in the other.
const ADDRESS_RE = /^[^\s@,;<>]+@[^\s@,;<>.]+(\.[^\s@,;<>.]+)+$/;

/**
 * Reduce a From/To header value to the bare, lowercased address, or null when
 * it isn't exactly one address.
 *
 * Plus-addressing is preserved: `kail+news@x.de` is a different recipient from
 * `kail@x.de` at every provider that supports it, and folding it away would
 * let an arbitrary suffix inherit an allowlist entry.
 */
export function normalizeAddress(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const angled = trimmed.match(/<([^<>]+)>\s*$/);
  const candidate = (angled ? angled[1] : trimmed).trim().toLowerCase();
  return ADDRESS_RE.test(candidate) ? candidate : null;
}

/** Display name from a `Name <addr>` header, or null. */
export function parseDisplayName(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  const angled = raw.trim().match(/^(.*)<[^<>]+>\s*$/);
  if (!angled) return null;
  const name = angled[1]
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .trim();
  return name || null;
}

/**
 * Is this machine-generated mail we must never answer?
 *
 * Email is the one channel where a reply can provoke an automatic reply, and
 * that pair will happily run forever at the speed of SMTP. This is checked
 * before the allowlist on purpose: the loop risk comes precisely from an
 * allowlisted correspondent's own out-of-office responder.
 */
export function isAutomatedMail(headers: Map<string, unknown> | Record<string, unknown>): boolean {
  // RFC 3834: any value other than the explicit "no" means auto-generated.
  const autoSubmitted = header(headers, 'auto-submitted');
  if (autoSubmitted && autoSubmitted.trim().toLowerCase() !== 'no') return true;

  const precedence = header(headers, 'precedence');
  if (precedence && /^(bulk|list|junk)$/i.test(precedence.trim())) return true;

  for (const name of ['list-id', 'list-unsubscribe', 'x-auto-response-suppress', 'x-autoreply', 'x-autorespond']) {
    if (header(headers, name) !== undefined) return true;
  }
  return false;
}

const ATTRIBUTION_RE =
  /^\s*(on\s.+\bwrote:|am\s.+\bschrieb.*:|le\s.+\ba écrit\s*:|-{2,}\s*(original message|urspr[üu]ngliche nachricht)\s*-{2,})\s*$/i;
const SIGNATURE_RE = /^--\s?$/;

/**
 * Drop the quoted history and signature from a reply.
 *
 * Without this the agent re-reads the entire thread on every turn — the same
 * text it already has in its own session history, at a growing token cost.
 *
 * Never returns an empty string: a mail that is nothing but a quote is handed
 * back untouched, because an agent shown "" has no idea anything arrived.
 */
export function stripQuotedReply(text: string): string {
  const lines = text.split(/\r?\n/);

  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (ATTRIBUTION_RE.test(lines[i]) || SIGNATURE_RE.test(lines[i])) {
      cut = i;
      break;
    }
  }

  // Trailing quote blocks (a bottom-quoted reply with no attribution line).
  let end = cut;
  while (end > 0 && (lines[end - 1].trim() === '' || lines[end - 1].startsWith('>'))) end--;

  const result = lines.slice(0, end).join('\n').trimEnd();
  return result.trim() ? result : text;
}

/** Crude HTML-to-text for mails with no plain-text part. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
