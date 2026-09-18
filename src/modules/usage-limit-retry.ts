/**
 * Host side of the Anthropic usage-limit auto-resume flow.
 *
 * When a container turn ends on a transient rate_limit rejection with a
 * known reset time, poll-loop.ts writes a `schedule_usage_limit_retry`
 * system action to outbound.db (it can't touch inbound.db directly — see
 * the cross-mount rule). This handler turns that into a delayed inbound.db
 * row: a synthetic "continue where you left off" message with
 * `process_after` set past the reset time. No kill/respawn — the same
 * container just gets woken again once it's due, via the same due-message
 * wake host-sweep already uses for scheduled tasks.
 *
 * Unguarded: this only re-wakes the session that asked for it, with no
 * privileged side effect (unlike self-mod's install_packages/add_mcp_server,
 * which mutate container config and therefore go through the guard).
 */
import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../config.js';
import { registerDeliveryAction } from '../delivery.js';
import { getMessagingGroup } from '../db/messaging-groups.js';
import { insertMessage } from '../db/session-db.js';
import { unguarded } from '../guard/index.js';
import { log } from '../log.js';

/** Safety margin past the SDK-reported resetsAt before waking the container. */
const RESET_BUFFER_MS = 180_000;

function generateId(): string {
  return `usage-limit-retry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

registerDeliveryAction(
  'schedule_usage_limit_retry',
  async (content, session, inDb) => {
    const resetsAt = Date.parse(content.resetsAt as string);
    if (!Number.isFinite(resetsAt)) {
      log.warn('schedule_usage_limit_retry: unparseable resetsAt, dropping', {
        sessionId: session.id,
        resetsAt: content.resetsAt,
      });
      return;
    }
    const retryCount = typeof content.retryCount === 'number' ? content.retryCount : 0;
    // The buffer clears a provider-reported counter that may not have rolled
    // over exactly on its stated edge. When the container picked the delay
    // itself — a gateway 429 reports no counter at all — that delay already is
    // the considered wait, and adding three minutes to each one only makes a
    // lost tick later.
    const buffer = content.applyBuffer === false ? 0 : RESET_BUFFER_MS;
    const processAfter = new Date(resetsAt + buffer).toISOString();

    // A recurring series that fires again before the retry would land needs no
    // retry: the schedule already is one. Without this a 15-minute sweep whose
    // backoff has grown to 30 minutes stacks extra wakes on top of ticks that
    // have long since run — and those extra wakes skip the pre-task gate that
    // keeps the sweep cheap, because they arrive as plain messages.
    if (typeof content.recurrence === 'string' && content.recurrence.length > 0) {
      try {
        const next = CronExpressionParser.parse(content.recurrence, { tz: TIMEZONE }).next().toDate();
        if (next.getTime() <= Date.parse(processAfter)) {
          log.info('Usage-limit retry dropped — next occurrence comes first', {
            sessionId: session.id,
            nextOccurrence: next.toISOString(),
            processAfter,
          });
          return;
        }
      } catch (err) {
        // An unparseable cron is the scheduler's problem, not this handler's:
        // fall through and schedule the retry rather than swallowing the wake.
        log.warn('Usage-limit retry: unparseable recurrence, scheduling anyway', {
          sessionId: session.id,
          recurrence: content.recurrence,
          err,
        });
      }
    }

    const mg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;

    insertMessage(inDb, {
      id: generateId(),
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: mg?.platform_id ?? null,
      channelType: mg?.channel_type ?? null,
      threadId: session.thread_id,
      content: JSON.stringify({
        // "Continue where you left off" is a chat sentence. A scheduled run
        // that was rejected before it executed left nothing off, so the
        // container sends its own wording for that case.
        text: typeof content.text === 'string' ? content.text : 'Usage limit has reset — continue where you left off.',
        sender: 'system',
        senderId: 'system',
        retryCount: retryCount + 1,
      }),
      processAfter,
      recurrence: null,
      trigger: 1,
    });

    log.info('Usage-limit retry scheduled', { sessionId: session.id, processAfter, retryCount: retryCount + 1 });
  },
  unguarded('re-wakes the same session with no privileged side effect'),
);
