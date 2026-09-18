import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getPendingMessages, markCompleted, markProcessing } from './db/messages-in.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { formatMessages, extractRouting } from './formatter.js';
import {
  isCorruptionError,
  processQuery,
  reloadTokenUsageBaselineForTests,
  resetTokenUsageBaseline,
  setSettleCoalesceMsForTesting,
} from './poll-loop.js';
import { MockProvider } from './providers/mock.js';
import { sendMessage } from './mcp-tools/core.js';
import { setCurrentInReplyTo } from './db/session-state.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

beforeEach(() => {
  initTestSessionDb();
  resetTokenUsageBaseline();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(
  id: string,
  kind: string,
  content: object,
  opts?: { processAfter?: string; trigger?: 0 | 1; onWake?: 0 | 1 },
) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, process_after, trigger, on_wake, content)
     VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?, ?)`,
    )
    .run(id, kind, opts?.processAfter ?? null, opts?.trigger ?? 1, opts?.onWake ?? 0, JSON.stringify(content));
}

describe('formatter', () => {
  it('should format a single chat message', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello world' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('Hello world');
  });

  it('should format multiple chat messages as distinct <message> blocks', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'chat', { sender: 'Jane', text: 'Hi there' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    // The <messages> envelope was dropped in fe2e881b (#2556) so the SDK calls
    // the API; each message is now its own self-contained <message> block.
    expect(prompt).not.toContain('<messages>');
    expect(prompt.match(/<message /g) ?? []).toHaveLength(2);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('sender="Jane"');
  });

  it('should format task messages', () => {
    insertMessage('m1', 'task', { prompt: 'Review open PRs' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<task');
    expect(prompt).toContain('Review open PRs');
  });

  it('should format webhook messages', () => {
    insertMessage('m1', 'webhook', { source: 'github', event: 'push', payload: { ref: 'main' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('source="github"');
    expect(prompt).toContain('event="push"');
  });

  it('should format system messages', () => {
    insertMessage('m1', 'system', { action: 'register_group', status: 'success', result: { id: 'ag-1' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('action="register_group"');
  });

  it('should handle mixed kinds', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'system', { action: 'test', status: 'ok', result: null });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('<system_response');
  });

  it('should escape XML in content', () => {
    insertMessage('m1', 'chat', { sender: 'A<B', text: 'x > y && z' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('A&lt;B');
    expect(prompt).toContain('x &gt; y &amp;&amp; z');
  });
});

describe('accumulate gate (trigger column)', () => {
  it('getPendingMessages returns both trigger=0 and trigger=1 rows', () => {
    // trigger=0 rides along as context, trigger=1 is the wake-eligible row.
    // The poll loop's gate depends on this data contract.
    insertMessage('m1', 'chat', { sender: 'A', text: 'chit chat' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'actual mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages).toHaveLength(2);
    const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
    expect(byId.m1.trigger).toBe(0);
    expect(byId.m2.trigger).toBe(1);
  });

  it('trigger=0-only batch: gate predicate `some(trigger===1)` is false', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'noise' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'more noise' }, { trigger: 0 });
    const messages = getPendingMessages();
    // This is the exact predicate the poll loop uses to skip accumulate-only
    // batches — gate should be false, so the loop sleeps without waking the agent.
    expect(messages.some((m) => m.trigger === 1)).toBe(false);
  });

  it('mixed batch: gate is true → loop proceeds, accumulated rows ride along', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'earlier chatter' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'the real mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages.some((m) => m.trigger === 1)).toBe(true);
    // Both messages are present for the formatter → agent sees the prior context.
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('trigger column defaults to 1 for legacy inserts without explicit value', () => {
    // The schema default is 1 (see src/db/schema.ts INBOUND_SCHEMA) — existing
    // rows / tests without the column set are effectively wake-eligible.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    const [msg] = getPendingMessages();
    expect(msg.trigger).toBe(1);
  });
});

describe('on_wake filtering', () => {
  it('first poll returns on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('subsequent polls skip on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(0);
  });

  it('normal messages returned regardless of isFirstPoll', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'hello' });
    expect(getPendingMessages(true)).toHaveLength(1);

    // Reset: mark completed so we can re-test with a fresh message
    markCompleted(['m1']);
    insertMessage('m2', 'chat', { sender: 'A', text: 'hello again' });
    expect(getPendingMessages(false)).toHaveLength(1);
  });

  it('mixed batch: first poll returns both normal and on_wake messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('mixed batch: subsequent poll returns only normal messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('on_wake defaults to 0 for inserts without explicit value', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    // Should be returned even on non-first poll (on_wake=0)
    expect(getPendingMessages(false)).toHaveLength(1);
  });
});

describe('routing', () => {
  it('should extract routing from messages', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-123', 'discord', 'thread-456', '{"text":"hi"}')`,
      )
      .run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.platformId).toBe('chan-123');
    expect(routing.channelType).toBe('discord');
    expect(routing.threadId).toBe('thread-456');
    expect(routing.inReplyTo).toBe('m1');
  });

  it('carries a recurring task\'s cron so a retry can be weighed against it', () => {
    // A retry that lands after the series would have fired again is not a
    // retry, it is a second run of work the schedule already covers.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, recurrence, series_id, content)
       VALUES ('t1', 'task', datetime('now'), 'pending', '*/15 * * * *', 'ser-1', '{"prompt":"sweep"}')`,
      )
      .run();

    const routing = extractRouting(getPendingMessages());
    expect(routing.taskRun).toBe(true);
    expect(routing.taskRecurrence).toBe('*/15 * * * *');
  });

  it('reports no cron for a one-off task', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, series_id, content)
       VALUES ('t2', 'task', datetime('now'), 'pending', 'ser-2', '{"prompt":"once"}')`,
      )
      .run();

    expect(extractRouting(getPendingMessages()).taskRecurrence).toBeNull();
  });
});

describe('origin metadata (from= attribute)', () => {
  function seedDestination(name: string, channelType: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }

  function insertWithRouting(
    id: string,
    kind: string,
    content: object,
    channelType: string | null,
    platformId: string | null,
  ): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?)`,
      )
      .run(id, kind, platformId, channelType, JSON.stringify(content));
  }

  it('chat message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="discord-main"');
  });

  it('chat message falls back to raw routing when no destination matches', () => {
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'telegram', 'chat-999');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="unknown:telegram:chat-999"');
  });

  it('chat message omits from= when routing is null', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).not.toContain('from=');
  });

  it('task message includes from= when destination matches', () => {
    seedDestination('slack-ops', 'slack', 'C-OPS');
    insertWithRouting('t1', 'task', { prompt: 'check status' }, 'slack', 'C-OPS');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).toContain('from="slack-ops"');
  });

  it('task message omits from= when routing is null', () => {
    insertMessage('t1', 'task', { prompt: 'check status' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).not.toContain('from=');
  });

  it('webhook message includes from= when destination matches', () => {
    seedDestination('github-ch', 'github', 'repo-1');
    insertWithRouting('w1', 'webhook', { source: 'github', event: 'push', payload: {} }, 'github', 'repo-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('from="github-ch"');
  });

  it('system message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('s1', 'system', { action: 'test', status: 'ok', result: null }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('from="discord-main"');
  });
});

describe('mock provider', () => {
  it('should produce init + result events', async () => {
    const provider = new MockProvider({}, (prompt) => `Echo: ${prompt}`);
    const query = provider.query({
      prompt: 'Hello',
      cwd: '/tmp',
    });

    const events: Array<{ type: string }> = [];
    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      events.push(event);
    }

    const typed = events.filter((e) => e.type !== 'activity');
    expect(typed.length).toBeGreaterThanOrEqual(2);
    expect(typed[0].type).toBe('init');
    expect(typed[1].type).toBe('result');
    expect((typed[1] as { text: string }).text).toBe('Echo: Hello');
  });

  it('should handle push() during active query', async () => {
    const provider = new MockProvider({}, (prompt) => `Re: ${prompt}`);
    const query = provider.query({
      prompt: 'First',
      cwd: '/tmp',
    });

    const events: Array<{ type: string; text?: string }> = [];

    setTimeout(() => query.push('Second'), 30);
    setTimeout(() => query.end(), 60);

    for await (const event of query.events) {
      events.push(event);
    }

    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(2);
    expect(results[0].text).toBe('Re: First');
    expect(results[1].text).toBe('Re: Second');
  });
});

describe('end-to-end with mock provider', () => {
  it('should read messages_in, process with mock provider, write messages_out', async () => {
    // Insert a chat message into inbound DB
    insertMessage('m1', 'chat', { sender: 'User', text: 'What is 2+2?' });

    // Read and process
    const messages = getPendingMessages();
    expect(messages).toHaveLength(1);

    const routing = extractRouting(messages);
    const prompt = formatMessages(messages);

    // Create mock provider and run query
    const provider = new MockProvider({}, () => 'The answer is 4');
    const query = provider.query({
      prompt,
      cwd: '/tmp',
    });

    // Process events — simulate what poll-loop does
    const { markProcessing } = await import('./db/messages-in.js');
    const { writeMessageOut } = await import('./db/messages-out.js');

    markProcessing(['m1']);

    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      if (event.type === 'result' && event.text) {
        writeMessageOut({
          id: `out-${Date.now()}`,
          in_reply_to: routing.inReplyTo,
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: event.text }),
        });
      }
    }

    markCompleted(['m1']);

    // Verify: message was processed (not pending, acked in processing_ack)
    const processed = getPendingMessages();
    expect(processed).toHaveLength(0);

    // Verify: response was written to outbound DB
    const outMessages = getUndeliveredMessages();
    expect(outMessages).toHaveLength(1);
    expect(JSON.parse(outMessages[0].content).text).toBe('The answer is 4');
    expect(outMessages[0].in_reply_to).toBe('m1');
  });
});

/**
 * Build a one-shot stub query that yields init + a single result event, then
 * ends. `pushes` records any follow-ups the loop tried to inject (e.g. the
 * re-wrap nudge), so a test can assert the loop did NOT re-hammer.
 */
function makeResultQuery(result: ProviderEvent): { query: AgentQuery; pushes: string[] } {
  const pushes: string[] = [];
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'init', continuation: 'sess-1' };
    yield result;
  }
  return {
    pushes,
    query: {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    },
  };
}

const ERR_ROUTING = {
  platformId: 'chan-1',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'm1',
};

// Reproduces the routing shape of an agent-to-agent inbound row (including a
// container's own on_wake restart message, which agent-route.ts always
// stamps with channel_type 'agent' + platform_id = the group's own id — see
// container-runner.ts / agent-route.ts:344). A side-channel notice
// (subagent/token-usage/error) that blindly reuses this routing context and
// gets delivered would itself become a fresh channel_type:'agent' inbound
// row (self-messages are always allowed), which produces its own notice,
// which delivers again — a self-sustaining loop with no external trigger
// needed. Live incident: two `ncl groups restart --message ...` calls (which
// write exactly this on_wake shape) each seeded this loop, racking up
// millions of tokens over several minutes before the account's monthly
// spend cap stopped it.
const AGENT_ROUTING = {
  platformId: 'ag-self',
  channelType: 'agent',
  threadId: null,
  inReplyTo: 'm1',
};

describe('error result with no <message> envelope', () => {
  it('delivers a budget/billing error to the triggering channel and does not nudge', async () => {
    const budgetText = 'Spending limit reached. Add your own key at https://example.com/keys';
    const { query, pushes } = makeResultQuery({ type: 'result', text: budgetText, isError: true });

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe(budgetText);
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].channel_type).toBe('discord');
    // No re-wrap nudge — an error result must not re-hammer the gateway.
    expect(pushes).toHaveLength(0);
  });

  it('stays silent on an agent-to-agent (self) route instead of feeding the loop', async () => {
    const budgetText = 'Spending limit reached. Add your own key at https://example.com/keys';
    const { query } = makeResultQuery({ type: 'result', text: budgetText, isError: true });

    await processQuery(query, AGENT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('still nudges (and does not deliver) a normal unwrapped result', async () => {
    const { query, pushes } = makeResultQuery({ type: 'result', text: 'bare text, no envelope' });

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    expect(getUndeliveredMessages()).toHaveLength(0);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('was not delivered');
  });

  it('aborts instead of re-delivering when the SDK repeats an identical error result forever', async () => {
    // Reproduces a live incident: once an account hits its monthly spend
    // cap, the SDK's own internal retry kept re-emitting the exact same
    // isError 'result' every ~1-2s, and the old code faithfully forwarded
    // every single one — 180+ duplicate chat messages before the container
    // was killed by hand. The loop must recognize an immediate repeat and
    // stop instead of relaying it forever.
    const spendCapText =
      "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage";
    const pushes: string[] = [];
    let abortCalls = 0;
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'sess-1' };
      for (let i = 0; i < 20; i++) {
        yield { type: 'result', text: spendCapText, isError: true };
      }
    }
    const query: AgentQuery = {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {
        abortCalls++;
      },
    };

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe(spendCapText);
    expect(abortCalls).toBeGreaterThanOrEqual(1);
  });
});

describe('duplicate delivery across a same-turn re-wrap retry', () => {
  it('does not re-deliver a tool-sent reply after a malformed result triggers a re-wrap nudge', async () => {
    // Reproduces the 2026-08-08 10:12 Matrix incident: the agent sends via
    // the send_message tool mid-turn, then the model's own final text for
    // that same turn comes back truncated (no closing </message> tag) —
    // dispatchResultText can't match it, so hasUnwrapped=true and the loop
    // nudges the model to re-wrap. The model complies and resends the exact
    // same text, properly wrapped this time. Because a 'result' event fired
    // in between (the malformed one), markTurnStart() must NOT have reset
    // the echo-suppression window, or this retry gets delivered as a real
    // second message — which is exactly what happened live (outbound seq
    // 941 and 947, byte-identical text).
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('matrix-mg-1', 'matrix-mg-1', 'channel', 'matrix', 'matrix:@user:example.org', NULL)`,
      )
      .run();

    const replyText = 'Erster Check: `docker` ist in meinem Container gar nicht installiert (command not found).';

    const pushes: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'sess-1' };
      // The tool call happens mid-turn — i.e. after processQuery's own
      // initial markTurnStart(), same as in the live incident (the tool
      // send landed well after the turn began, not before it).
      await sendMessage.handler({ to: 'matrix-mg-1', text: replyText });
      // Malformed: missing closing </message> tag, so dispatchResultText's
      // regex never matches — nothing is delivered, hasUnwrapped=true.
      yield { type: 'result', text: `<message to="matrix-mg-1">${replyText}` };
      // Retry after the nudge: same text, properly wrapped this time.
      yield { type: 'result', text: `<message to="matrix-mg-1">${replyText}</message>` };
    }
    const query: AgentQuery = {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    };

    const routing = {
      platformId: 'matrix:@user:example.org',
      channelType: 'matrix',
      threadId: null,
      inReplyTo: 'm1',
      taskRun: false,
    };

    await processQuery(query, routing, ['m1'], 'claude', undefined, 'prompt', undefined);

    // Exactly one re-wrap nudge, and the retry must be recognized as an
    // echo of the tool send — only the original tool-sent message survives.
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('was not delivered');
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe(replyText);
  });
});

describe('current_in_reply_to follows the active follow-up batch', () => {
  it('stamps a tool send made after a follow-up push against the follow-up message, not the original', async () => {
    // setCurrentInReplyTo is only called once, for the initial batch
    // (poll-loop.ts:290). A tool call made after the follow-up poller pushes
    // a later message into the same continuous stream must thread against
    // that later message, not the one that started the stream — otherwise a
    // reply lands mis-threaded (2026-08-08 incident: outbound seq 941
    // stamped in_reply_to against message 792 instead of 798, the message it
    // actually answered).
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('ops', 'ops', 'channel', 'matrix', 'matrix:@user:example.org', NULL)`,
      )
      .run();

    insertMessage('m1', 'chat', { sender: 'User', text: 'first question' });
    const initialMessages = getPendingMessages();
    const routing = extractRouting(initialMessages);
    // Mirrors what runPollLoop does right before calling processQuery
    // (poll-loop.ts:196, 290) — this test drives processQuery directly, so
    // it has to set up the same preconditions by hand. Without marking m1
    // processing, the follow-up poller's own getPendingMessages() call would
    // see m1 as still pending alongside m2 and derive in_reply_to from m1
    // (the older of the two) again — masking the very staleness this test
    // checks for.
    markProcessing(initialMessages.map((m) => m.id));
    setCurrentInReplyTo(routing.inReplyTo);

    const pushes: string[] = [];
    let toolSendReplyTo: string | null | undefined;
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'sess-1' };

      insertMessage('m2', 'chat', { sender: 'User', text: 'follow-up question' });
      const deadline = Date.now() + 5000;
      while (pushes.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }

      await sendMessage.handler({ to: 'ops', text: 'answering the follow-up' });
      const rows = getUndeliveredMessages();
      toolSendReplyTo = rows[rows.length - 1]?.in_reply_to;

      yield { type: 'result', text: '<message to="ops">done</message>' };
    }
    const query: AgentQuery = {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await processQuery(query, routing, ['m1'], 'claude', undefined, 'prompt', undefined);

    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('follow-up question');
    expect(toolSendReplyTo).toBe('m2');
  });
});

/** Build a query that yields init, a subagent event, then an empty result. */
function makeSubagentQuery(): { query: AgentQuery; pushes: string[] } {
  const pushes: string[] = [];
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'init', continuation: 'sess-1' };
    yield { type: 'subagent', subagentType: 'websearch', model: 'haiku' };
    yield { type: 'result', text: null };
  }
  return {
    pushes,
    query: {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    },
  };
}

describe('subagent logging notice', () => {
  it('delivers a chat notice naming the subagent and its model when logSubagents is on', async () => {
    const { query, pushes } = makeSubagentQuery();

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const text = JSON.parse(out[0].content).text as string;
    expect(text).toContain('websearch');
    expect(text).toContain('haiku');
    expect(out[0].platform_id).toBe('chan-1');
    // Diagnostic, not ordinary chat — see the token-usage notice test.
    expect(out[0].kind).toBe('notice');
    // The notice is a side-channel write, never a push into the agent's own
    // SDK stream — it must not appear as a nudge/follow-up.
    expect(pushes).toHaveLength(0);
  });

  it('stays silent when logSubagents is off (the default)', async () => {
    const { query } = makeSubagentQuery();

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('stays silent on an agent-to-agent (self) route even when logSubagents is on', async () => {
    const { query } = makeSubagentQuery();

    await processQuery(query, AGENT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

type UsageMap = NonNullable<Extract<ProviderEvent, { type: 'result' }>['modelUsage']>;

/** Per-model usage totals in the shape the SDK reports them. */
function usage(
  inputTokens: number,
  outputTokens: number,
  cacheReadInputTokens: number,
  costUSD: number,
  cacheCreationInputTokens = 0,
) {
  return { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD };
}

const DEFAULT_USAGE: UsageMap = {
  sonnet: usage(1000, 200, 50, 0.08),
  haiku: usage(300, 100, 0, 0.01),
};

/** Build a query that yields init, then a result carrying per-model token usage. */
function makeTokenUsageQuery(modelUsage: UsageMap = DEFAULT_USAGE): { query: AgentQuery; pushes: string[] } {
  const pushes: string[] = [];
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'init', continuation: 'sess-1' };
    yield { type: 'result', text: null, modelUsage };
  }
  return {
    pushes,
    query: {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    },
  };
}

describe('token usage notice', () => {
  it('delivers separate token counters without provider-specific pricing', async () => {
    const { query, pushes } = makeTokenUsageQuery({
      sonnet: usage(1000, 200, 50, 0.08, 600),
      haiku: usage(300, 100, 0, 0.01, 25),
    });

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, false, true);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const text = JSON.parse(out[0].content).text as string;
    expect(text).toContain('sonnet: input 1,000 · cache read 50 · cache creation 600 · output 200');
    expect(text).toContain('haiku: input 300 · cache read 0 · cache creation 25 · output 100');
    expect(text).not.toContain('$0.08');
    expect(text).not.toContain('$0.01');
    expect(text).not.toContain('1,850');
    expect(text).not.toContain('425');

    expect(out[0].platform_id).toBe('chan-1');
    // Marked as a diagnostic, not ordinary chat: the host suppresses these on
    // channels that declare they don't carry notices (email). Falling back to
    // 'chat' here would silently mail the operator's token cost to whoever
    // the agent is corresponding with.
    expect(out[0].kind).toBe('notice');
    // Side-channel write, never a push into the agent's own SDK stream.
    expect(pushes).toHaveLength(0);
  });

  it('stays silent when showTokenUsage is off (the default)', async () => {
    const { query } = makeTokenUsageQuery();

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('stays silent on an agent-to-agent (self) route even when showTokenUsage is on', async () => {
    const { query } = makeTokenUsageQuery();

    await processQuery(query, AGENT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, false, true);

    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  // The SDK's modelUsage is a running total for the whole session (it survives
  // a resume), not this turn's usage. Reporting it raw made a one-word reply
  // look like it cost 1.4M tokens. Every case below pins the subtraction.
  async function runTurn(modelUsage?: UsageMap): Promise<string | null> {
    const before = getUndeliveredMessages().length;
    const { query } = makeTokenUsageQuery(modelUsage);
    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, false, true);
    const out = getUndeliveredMessages();
    if (out.length === before) return null;
    return JSON.parse(out[out.length - 1].content).text as string;
  }

  it('reports only this turn, not the session running total', async () => {
    await runTurn({ sonnet: usage(1000, 200, 50, 0.08) });
    const text = await runTurn({ sonnet: usage(1000, 260, 8050, 0.11) });

    // 1,250 -> 9,310 cumulative: the turn itself was 8,060 tokens and $0.03.
    expect(text).toContain('sonnet: input 0 · cache read 8,000 · cache creation 0 · output 60');
    expect(text).not.toContain('9,310');
  });

  it('counts a subagent model that only appears mid-session', async () => {
    await runTurn({ sonnet: usage(1000, 200, 50, 0.08) });
    const text = await runTurn({
      sonnet: usage(1000, 300, 50, 0.09),
      haiku: usage(4000, 500, 0, 0.02),
    });

    expect(text).toContain('sonnet: input 0 · cache read 0 · cache creation 0 · output 100');
    expect(text).toContain('haiku: input 4,000 · cache read 0 · cache creation 0 · output 500');
    expect(text).not.toContain('$0.01');
    expect(text).not.toContain('$0.02');
  });

  it('treats a counter that went backwards as a fresh session', async () => {
    await runTurn({ sonnet: usage(100000, 5000, 900000, 4.2) });
    // Container restarted: the SDK's totals start over from this turn's own usage.
    const text = await runTurn({ sonnet: usage(1000, 200, 50, 0.08) });

    expect(text).toContain('sonnet: input 1,000 · cache read 50 · cache creation 0 · output 200');
    expect(text).not.toContain('$0.08');
  });

  it('says nothing when the turn consumed nothing', async () => {
    await runTurn({ sonnet: usage(1000, 200, 50, 0.08) });

    expect(await runTurn({ sonnet: usage(1000, 200, 50, 0.08) })).toBeNull();
  });

  it('keeps subtracting across a container restart via the persisted baseline', async () => {
    await runTurn({ sonnet: usage(1000, 200, 50, 0.08) });
    // Fresh container: module baseline gone, but the SDK's modelUsage is
    // restored on resume as a running total. Without persistence this turn
    // would re-print the whole 1,250 -> 9,310 history.
    reloadTokenUsageBaselineForTests();
    const text = await runTurn({ sonnet: usage(1000, 260, 8050, 0.11) });

    expect(text).toContain('sonnet: input 0 · cache read 8,000 · cache creation 0 · output 60');
    expect(text).not.toContain('9,310');
  });

  it('says nothing when the provider reports no usage at all', async () => {
    expect(await runTurn({})).toBeNull();
  });
});

describe('isCorruptionError', () => {
  it('matches the Docker Desktop macOS torn-read symptom', () => {
    expect(isCorruptionError('database disk image is malformed')).toBe(true);
  });

  it('matches wrapped SQLite corruption codes', () => {
    expect(isCorruptionError('SqliteError: SQLITE_CORRUPT_VTAB: ...')).toBe(true);
    expect(isCorruptionError('file is not a database')).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isCorruptionError('database is locked')).toBe(false);
    expect(isCorruptionError('no such table: messages_in')).toBe(false);
    expect(isCorruptionError('')).toBe(false);
  });
});

// --- Task-run turn wiring: the REAL processQuery path (one-door) ---
// These drive the actual call sites (autoAppendTaskLog at result-handling,
// shouldNudgeTaskBlocks gating, and follow-up turn reset). Deleting the wiring
// — not just the helpers — goes red here.

const TASK_ROUTING = {
  platformId: null,
  channelType: null,
  threadId: 'system:tasks:ser-1',
  inReplyTo: 't1',
  taskRun: true,
};

function taskLogRows(): Array<{ text: string }> {
  return (
    getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind = 'task_log' ORDER BY seq").all() as Array<{
      content: string;
    }>
  ).map((r) => JSON.parse(r.content) as { text: string });
}

describe('task-run turn wiring (real processQuery)', () => {
  it('auto-appends the final text as a task_log row', async () => {
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'result', text: 'checked feeds — nothing new' };
    }
    const query: AgentQuery = { push: () => {}, end: () => {}, events: events(), abort: () => {} };

    await processQuery(query, TASK_ROUTING, ['t1'], 'claude', undefined, 'prompt', undefined);

    const logs = taskLogRows();
    expect(logs).toHaveLength(1);
    expect(logs[0].text).toBe('checked feeds — nothing new');
    // and nothing was delivered as chat
    expect(getUndeliveredMessages().filter((m) => m.kind === 'chat')).toHaveLength(0);
  });

  it('re-arms a scheduled run the provider rejected, instead of only logging it', async () => {
    // The chat error path is skipped for task runs, so before this a 429'd
    // sweep tick went into the run log and nowhere else — no retry, no wake,
    // the occurrence simply lost. Measured five times in 36 hours on the Deck
    // sweep (17.–18.09.2026).
    const rejected = 'API Error: Request rejected (429) · Provider returned error';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'result', text: rejected, isError: true };
    }
    const query: AgentQuery = { push: () => {}, end: () => {}, events: events(), abort: () => {} };

    await processQuery(query, TASK_ROUTING, ['t1'], 'claude', undefined, 'prompt', undefined);

    const actions = (
      getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind = 'system'").all() as Array<{
        content: string;
      }>
    ).map((r) => JSON.parse(r.content) as Record<string, unknown>);
    const retry = actions.find((a) => a.action === 'schedule_usage_limit_retry');

    expect(retry).toBeDefined();
    // The gateway reports no reset counter, so the container's own delay is
    // the whole wait — the host must not pad it.
    expect(retry!.applyBuffer).toBe(false);
    expect(Date.parse(retry!.resetsAt as string)).toBeGreaterThan(Date.now());
    // A run that never executed was not "left off" anywhere.
    expect(String(retry!.text)).toContain('scheduled run');
    // The failure is still on the record.
    expect(taskLogRows().map((l) => l.text)).toContain(rejected);
  });

  it('logs and conditionally nudges a second task run in the same open query', async () => {
    const pushes: string[] = [];

    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      // Turn 1 uses the legacy wrong door and consumes its one correction.
      yield { type: 'result', text: '<message to="local-cli">fire one result</message>' };
      yield { type: 'result', text: 'first delivery decision handled' };

      // A SECOND task run lands while the query is open — the follow-up poller
      // pushes it and must reset the per-turn correction state.
      insertMessage('t2', 'task', { prompt: 'fire two' });
      const deadline = Date.now() + 5000;
      while (!pushes.some((p) => p.includes('fire two')) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }

      // Turn 2 repeats the mistake. This receives a second independent nudge
      // only if the follow-up path reset taskBlockNudged.
      yield { type: 'result', text: '<message to="local-cli">fire two result</message>' };
      yield { type: 'result', text: 'second delivery decision handled' };
    }

    const query: AgentQuery = {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await processQuery(query, TASK_ROUTING, ['t1'], 'claude', undefined, 'prompt', undefined);

    const nudges = pushes.filter((p) => p.includes('If and only if'));
    expect(nudges).toHaveLength(2);
    expect(nudges[0]).toContain('fire one result');
    expect(nudges[1]).toContain('fire two result');

    const logs = taskLogRows().map((l) => l.text);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain('[undelivered → local-cli] fire one result');
    expect(logs[1]).toContain('[undelivered → local-cli] fire two result');
    expect(logs).not.toContain('first delivery decision handled');
    expect(logs).not.toContain('second delivery decision handled');
  });
});

/**
 * A message that arrives mid-turn is pushed into the running query and, until
 * now, marked completed in the same breath. Between that mark and the model
 * actually reading it there is a window — one long model call wide — in which a
 * container death destroys the message for good: the ack says done, nothing
 * redelivers it, and the sender believes it was received. That is not
 * theoretical; it happened twice on 2026-09-09/10, both times through an
 * ordinary operator restart.
 *
 * The messages that *start* a turn never had this problem: they are completed
 * on the result event, and a container that dies first leaves them claimed, so
 * the next container clears the claim and re-reads them. These tests hold the
 * follow-up path to that same standard.
 */
describe('follow-up messages are not acked before the turn produces something', () => {
  /** A query that stays open long enough for one follow-up poll, then results. */
  function makeSlowQuery(): { query: AgentQuery; pushes: string[]; finish: () => void } {
    const pushes: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'sess-1' };
      await gate;
      yield { type: 'result', text: '<message to="user">done</message>', isError: false };
    }
    return {
      pushes,
      finish: () => release?.(),
      query: {
        push: (m: string) => {
          pushes.push(m);
        },
        end: () => {},
        events: events(),
        abort: () => {},
      },
    };
  }

  const ackOf = (id: string) =>
    (
      getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(id) as
        | { status: string }
        | undefined
    )?.status;

  it('holds the claim while the turn is still running, and completes it with the result', async () => {
    insertMessage('m1', 'chat', { text: 'first' });
    markProcessing(['m1']);
    const { query, pushes, finish } = makeSlowQuery();
    const run = processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    // Arrives while the turn is open — the follow-up poll picks it up.
    insertMessage('m2', 'chat', { text: 'second' });
    await Bun.sleep(900);

    expect(pushes.length).toBeGreaterThanOrEqual(1);
    // Handed to the model, but nothing has come back yet: still ours to redo.
    expect(ackOf('m2')).toBe('processing');

    finish();
    await run;
    expect(ackOf('m2')).toBe('completed');
  }, 10_000);

  it('holds the claim for the whole turn even when no result ever comes', async () => {
    // A container killed during that hold finds the claim cleared on the next
    // start and the row still pending — which is exactly how it comes back.
    insertMessage('m1', 'chat', { text: 'first' });
    markProcessing(['m1']);
    const pushes: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'sess-1' };
      await gate;
      // Stream ends with no result at all — the shape a dropped provider
      // connection leaves behind.
    }
    const query: AgentQuery = {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    };
    const run = processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    insertMessage('m2', 'chat', { text: 'second' });
    await Bun.sleep(900);
    expect(ackOf('m2')).toBe('processing');

    release?.();
    await run;
    // Once the turn has ended in this process it is acked like any other —
    // an errored turn is not redelivered, and leaving the claim would make the
    // message invisible to a container that is still alive. The window that
    // matters is the one asserted above, while the turn was still open.
    expect(ackOf('m2')).toBe('completed');
  }, 10_000);
});

// --- Harvesting background work that settles after the turn ------------------
//
// A background subagent or a backgrounded Bash command settles with a
// `task_notification`, which the CLI queues as a user message for the next turn
// — and if the turn that delegated the work has already ended, no turn ever
// comes. On 2026-09-13 the R65 emulator gate finished two seconds after KaiL's
// closing message, nobody read the verdict, and 30 minutes later the idle
// ceiling reclaimed the container. Pushing a short note in starts the turn that
// collects the queued notification.
//
// The first version woke the agent for every settle, including the seconds-long
// SSH greps it fires off mid-turn: 177 API calls and 17.9M tokens on
// 2026-09-15, most of them turns that concluded "nothing new" — and the agent
// took the drumbeat as evidence that its engineer subagent had died. Hence the
// two filters here: only work somebody waits on, and one note per burst.

const SETTLE = { type: 'background-settled' as const, summary: 'the gate', subagent: false, durationMs: 600_000 };

function settleQuery(events: ProviderEvent[]): { query: AgentQuery; pushes: string[] } {
  const pushes: string[] = [];
  async function* gen(): AsyncGenerator<ProviderEvent> {
    for (const e of events) {
      yield e;
      // Shorter than the coalescing window, so consecutive settles land in the
      // same batch; the wait after the last event lets the timer fire.
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    pushes,
    query: {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: gen(),
      abort: () => {},
    },
  };
}

describe('settled background work (real processQuery)', () => {
  beforeEach(() => {
    setSettleCoalesceMsForTesting(120);
  });
  afterEach(() => {
    setSettleCoalesceMsForTesting(null);
  });

  it('nudges when long-running work settles after the turn ended', async () => {
    const { query, pushes } = settleQuery([
      { type: 'init', continuation: 's1' },
      { type: 'result', text: '<internal>turn done</internal>' },
      SETTLE,
    ]);

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    const nudges = pushes.filter((p) => p.includes('settled while no turn was running'));
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toContain('the gate');
  });

  it('nudges for a subagent however briefly it ran', async () => {
    // Delegated work is what someone is waiting on by definition — a subagent
    // that answers in four seconds still owes its caller the answer.
    const { query, pushes } = settleQuery([
      { type: 'init', continuation: 's1' },
      { type: 'result', text: '<internal>turn done</internal>' },
      { ...SETTLE, subagent: true, summary: 'Agent "engineer" finished', durationMs: 4_000 },
    ]);

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    expect(pushes.filter((p) => p.includes('settled while no turn was running'))).toHaveLength(1);
  });

  it('stays quiet for a seconds-long shell task', async () => {
    // The grep case: its output rides along with the next real turn, and waking
    // the agent for it buys nothing but a turn that concludes "nothing new".
    const { query, pushes } = settleQuery([
      { type: 'init', continuation: 's1' },
      { type: 'result', text: '<internal>turn done</internal>' },
      { ...SETTLE, summary: 'Extract log lines', durationMs: 3_000 },
    ]);

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    expect(pushes.filter((p) => p.includes('settled while no turn was running'))).toHaveLength(0);
  });

  it('coalesces a burst into one note that names both', async () => {
    const { query, pushes } = settleQuery([
      { type: 'init', continuation: 's1' },
      { type: 'result', text: '<internal>turn done</internal>' },
      { ...SETTLE, summary: 'first gate' },
      { ...SETTLE, summary: 'second gate' },
    ]);

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    const nudges = pushes.filter((p) => p.includes('settled while no turn was running'));
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toContain('first gate');
    expect(nudges[0]).toContain('second gate');
  });

  it('stays quiet while the turn is still running', async () => {
    // Mid-turn the CLI hands the notification to the model anyway. A note here
    // would be a second copy of something it already has.
    const { query, pushes } = settleQuery([
      { type: 'init', continuation: 's1' },
      SETTLE,
      { type: 'result', text: '<internal>turn done</internal>' },
    ]);

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    expect(pushes.filter((p) => p.includes('settled while no turn was running'))).toHaveLength(0);
  });

  it('points at the notification instead of demanding a verification ritual', async () => {
    // The first wording told the agent to go verify the work where it lives,
    // every time. It dutifully did, at length, for three-second greps.
    const { query, pushes } = settleQuery([
      { type: 'init', continuation: 's1' },
      { type: 'result', text: '<internal>turn done</internal>' },
      SETTLE,
    ]);

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    const nudge = pushes.find((p) => p.includes('settled while no turn was running'))!;
    expect(nudge).toMatch(/notification/i);
    expect(nudge.length).toBeLessThan(400);
  });
});
