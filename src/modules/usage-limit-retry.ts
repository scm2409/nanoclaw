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
    const processAfter = new Date(resetsAt + RESET_BUFFER_MS).toISOString();

    const mg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;

    insertMessage(inDb, {
      id: generateId(),
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: mg?.platform_id ?? null,
      channelType: mg?.channel_type ?? null,
      threadId: session.thread_id,
      content: JSON.stringify({
        text: 'Usage limit has reset — continue where you left off.',
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
