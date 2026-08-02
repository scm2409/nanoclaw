/**
 * What the agent already delivered by tool call during the current turn.
 *
 * `send_message` and a final-response `<message to="…">` block write to the
 * same table, so an agent that calls the tool mid-turn and then repeats that
 * text in its final output delivers it twice — the double-delivery class
 * named in poll-loop's dispatchResultText, and the cause of the 2026-08-02
 * duplicate replies. dispatchResultText consults this to drop a final block
 * that only echoes a tool send, while leaving a genuinely different final
 * message (the "on it" → real answer sequence) alone.
 *
 * Read from outbound.db rather than an in-process registry, because the MCP
 * tools do NOT run in the poll loop's process: index.ts starts them as a
 * separate `bun run mcp-tools/index.ts` subprocess, so module state written
 * by the tool is invisible here. The shared session DB is the only channel
 * between them — the same reason the host and container talk through it.
 *
 * The turn is delimited by seq: markTurnStart() records where outbound.db
 * stood when the turn began, so only rows written since then count.
 *
 * Matching is exact after whitespace normalization, deliberately: both
 * observed incidents repeated the text byte for byte, so nothing looser is
 * needed, and anything looser could swallow a real follow-up message.
 *
 * Keyed on channel + platform only, NOT thread: the two paths resolve
 * thread_id differently (the tool keeps the session's thread when the
 * destination matches its channel, sendToDestination re-derives it from the
 * most recent matching inbound), so including it would let real echoes past.
 */
import { getOutboundDb } from './db/connection.js';

let turnStartSeq = 0;

function key(channelType: string, platformId: string, text: string): string {
  return `${channelType} ${platformId} ${text.replace(/\s+/g, ' ').trim()}`;
}

/** Mark where outbound.db stands, so a later lookup sees only this turn's sends. */
export function markTurnStart(): void {
  try {
    const row = getOutboundDb().prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out').get() as { m: number };
    turnStartSeq = row.m;
  } catch {
    // No session DB (unit context) — nothing sent, nothing to suppress.
    turnStartSeq = Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Everything delivered so far in this turn, as normalized destination+text keys.
 *
 * Collected once per final dispatch rather than per block, so a block is only
 * ever matched against sends that predate the dispatch — two identical blocks
 * in one final response still both deliver, as they always did.
 */
export function turnSendKeys(): Set<string> {
  const keys = new Set<string>();
  try {
    const rows = getOutboundDb()
      .prepare(
        `SELECT channel_type, platform_id, content FROM messages_out
         WHERE seq > ? AND kind = 'chat' AND channel_type IS NOT NULL AND platform_id IS NOT NULL`,
      )
      .all(turnStartSeq) as { channel_type: string; platform_id: string; content: string }[];
    for (const row of rows) {
      let text: unknown;
      try {
        text = JSON.parse(row.content).text;
      } catch {
        continue;
      }
      if (typeof text === 'string' && text) keys.add(key(row.channel_type, row.platform_id, text));
    }
  } catch {
    // Unreadable outbound.db — suppress nothing rather than drop a real reply.
  }
  return keys;
}

/** True when this exact text already went to this destination in this turn. */
export function isTurnSend(keys: Set<string>, channelType: string, platformId: string, text: string): boolean {
  return keys.has(key(channelType, platformId, text));
}
