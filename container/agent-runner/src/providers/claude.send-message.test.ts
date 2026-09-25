import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from '../db/connection.js';
import { misdirectedSendMessage, preToolUseHook } from './claude.js';

// `SendMessage` reaches subagents. Messages for a person go through the MCP
// `send_message` tool, whose targets are the rows in `destinations`. Confusing
// the two loses the message: on 2026-09-15 KaiL sent Martin a decisive r74
// finding via SendMessage, got back "No agent named 'matrix-mg-17844' is
// currently addressable", never retried, and the finding was simply gone.

const isDestination = (name: string) => name === 'matrix-mg-17844';

describe('misdirectedSendMessage', () => {
  it('catches a delivery destination in `to`', () => {
    const reason = misdirectedSendMessage('SendMessage', { to: 'matrix-mg-17844', message: 'hi' }, isDestination);
    expect(reason).toContain('matrix-mg-17844');
    expect(reason).toContain('send_message');
  });

  it('catches it in `recipient` too', () => {
    // The CLI fills both fields; either one can carry the mistake.
    expect(misdirectedSendMessage('SendMessage', { recipient: 'matrix-mg-17844' }, isDestination)).not.toBeNull();
  });

  it('leaves a real agent target alone', () => {
    expect(misdirectedSendMessage('SendMessage', { to: 'aa9f51dd4b3e46475' }, isDestination)).toBeNull();
  });

  it('ignores other tools and empty input', () => {
    expect(misdirectedSendMessage('Bash', { to: 'matrix-mg-17844' }, isDestination)).toBeNull();
    expect(misdirectedSendMessage('SendMessage', undefined, isDestination)).toBeNull();
    expect(misdirectedSendMessage('SendMessage', { message: 'no target' }, isDestination)).toBeNull();
  });
});

describe('preToolUseHook — misdirected SendMessage', () => {
  beforeEach(() => {
    initTestSessionDb();
    getInboundDb()
      .prepare('INSERT INTO destinations (name, display_name, type, channel_type, platform_id) VALUES (?,?,?,?,?)')
      .run('matrix-mg-17844', 'Martin', 'user', 'matrix', '!room:example.org');
  });
  afterEach(() => {
    closeSessionDb();
  });

  it('blocks the call and names the tool that would have worked', async () => {
    const out = (await preToolUseHook(
      { tool_name: 'SendMessage', tool_input: { to: 'matrix-mg-17844', message: 'decisive finding' } },
      undefined as never,
      { signal: new AbortController().signal },
    )) as {
      hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string; permissionDecisionReason?: string };
    };

    // permissionDecisionReason is the field the model sees; stopReason never
    // reached it, so the agent only got "Hook PreToolUse:SendMessage denied this tool".
    expect(out.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('send_message');
  });

  it('lets a subagent message through', async () => {
    const out = (await preToolUseHook(
      { tool_name: 'SendMessage', tool_input: { to: 'aa9f51dd4b3e46475', message: 'carry on' } },
      undefined as never,
      { signal: new AbortController().signal },
    )) as { decision?: string; continue?: boolean };

    expect(out.decision).toBeUndefined();
    expect(out.continue).toBe(true);
  });
});
