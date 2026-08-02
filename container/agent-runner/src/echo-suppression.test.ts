/**
 * Echo suppression in chat sessions.
 *
 * `send_message` and a final-response `<message to="…">` block are the same
 * delivery surface, so an agent that calls the tool mid-turn and then repeats
 * the identical text in its final output delivers it twice. Only a verbatim
 * repeat of something already sent this turn is dropped — a genuinely
 * different final message (the "on it" → real answer sequence) still lands.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from './db/connection.js';
import { getUndeliveredMessages, writeMessageOut } from './db/messages-out.js';
import { sendMessage } from './mcp-tools/core.js';
import { dispatchResultText } from './poll-loop.js';
import { markTurnStart } from './turn-sends.js';
import type { RoutingContext } from './formatter.js';

function seedDestination(name: string, channelType: string, platformId: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, name, channelType, platformId);
}

const chatRouting: RoutingContext = {
  platformId: 'matrix:@user:example.org',
  channelType: 'matrix',
  threadId: 'matrix:!room%3Aexample.org',
  inReplyTo: '$event',
  taskRun: false,
};

// The 2026-08-02 19:35 incident text, byte-identical in both deliveries.
const REPLY =
  'Stimmt, du hast recht — mein Fehler, Nextcloud hat keine Mail-App, also kein automatisches Invite von dort.';

beforeEach(() => {
  initTestSessionDb();
  seedDestination('family', 'matrix', 'matrix:@user:example.org');
  markTurnStart();
});

afterEach(() => {
  closeSessionDb();
});

describe('final-text echoes of a send_message call', () => {
  it('drops a final block that repeats what the tool already sent this turn', async () => {
    await sendMessage.handler({ to: 'family', text: REPLY });

    const { sent, suppressed } = dispatchResultText(`<message to="family">${REPLY}</message>`, chatRouting);

    expect(sent).toBe(0);
    expect(suppressed).toBe(1);
    expect(getUndeliveredMessages()).toHaveLength(1);
  });

  it('matches across trivial whitespace differences', async () => {
    await sendMessage.handler({ to: 'family', text: 'Bin dran — melde mich gleich.' });

    const { suppressed } = dispatchResultText(
      '<message to="family">Bin dran —  melde mich\ngleich.</message>',
      chatRouting,
    );

    expect(suppressed).toBe(1);
    expect(getUndeliveredMessages()).toHaveLength(1);
  });

  it('still delivers a final block whose content differs from the tool send', async () => {
    await sendMessage.handler({ to: 'family', text: 'Bin dran.' });

    const { sent, suppressed } = dispatchResultText(`<message to="family">${REPLY}</message>`, chatRouting);

    expect(sent).toBe(1);
    expect(suppressed).toBe(0);
    expect(getUndeliveredMessages()).toHaveLength(2);
  });

  it('still delivers the same text to a destination the tool did not send to', async () => {
    seedDestination('ops', 'slack', 'slack:C123');
    await sendMessage.handler({ to: 'family', text: REPLY });

    const { sent, suppressed } = dispatchResultText(`<message to="ops">${REPLY}</message>`, chatRouting);

    expect(sent).toBe(1);
    expect(suppressed).toBe(0);
    expect(getUndeliveredMessages()).toHaveLength(2);
  });

  it('does not ask the agent to re-wrap when the whole result was a suppressed echo', async () => {
    await sendMessage.handler({ to: 'family', text: REPLY });

    const { hasUnwrapped } = dispatchResultText(`<message to="family">${REPLY}</message>`, chatRouting);

    // Nudging here would tell the agent its response was never delivered and
    // prompt a re-send — recreating the duplicate this suppression removes.
    expect(hasUnwrapped).toBe(false);
  });

  it('forgets the turn once it ends, so the same text sends again next turn', async () => {
    await sendMessage.handler({ to: 'family', text: REPLY });
    expect(dispatchResultText(`<message to="family">${REPLY}</message>`, chatRouting).suppressed).toBe(1);

    markTurnStart();

    expect(dispatchResultText(`<message to="family">${REPLY}</message>`, chatRouting).sent).toBe(1);
    expect(getUndeliveredMessages()).toHaveLength(2);
  });

  it('sees a send written by another process, not just one made in-process', () => {
    // The MCP tools run as a separate `bun run mcp-tools/index.ts` subprocess
    // (index.ts:88), so module state they write is invisible to the poll loop.
    // Suppression must therefore read outbound.db, the only shared channel.
    // Writing the row directly here is what that subprocess effectively does.
    writeMessageOut({
      id: 'msg-from-other-process',
      kind: 'chat',
      channel_type: 'matrix',
      platform_id: 'matrix:@user:example.org',
      thread_id: null,
      content: JSON.stringify({ text: REPLY }),
    });

    const { sent, suppressed } = dispatchResultText(`<message to="family">${REPLY}</message>`, chatRouting);

    expect(sent).toBe(0);
    expect(suppressed).toBe(1);
    expect(getUndeliveredMessages()).toHaveLength(1);
  });

  it('does not match a block against another block in the same final response', () => {
    const { sent, suppressed } = dispatchResultText(
      `<message to="family">${REPLY}</message><message to="family">${REPLY}</message>`,
      chatRouting,
    );

    expect(sent).toBe(2);
    expect(suppressed).toBe(0);
    expect(getUndeliveredMessages()).toHaveLength(2);
  });
});
