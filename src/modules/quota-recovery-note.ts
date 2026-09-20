/**
 * `queue_quota_recovery_note` is the host side of the quota recovery flow: the
 * container writes this system action when a turn ends on a provider quota
 * rejection — a 402/403 budget or key limit, which no timed retry can fix
 * (unlike a 429, it clears when the operator raises the limit, and only they
 * know when). See container/agent-runner/src/quota-recovery-note.ts for the
 * container-side decision.
 *
 * The handler turns the action into a trigger=0 inbound.db row: accumulated
 * context that never wakes anything on its own but rides along with the next
 * wake that happens for another reason — the next sweep tick, or the user's
 * next message. The first successful wake after the limit was raised is the
 * one that reads it, which is exactly the delivery timing wanted here.
 *
 * Unguarded: this writes an inert context row into the session that asked for
 * it, with no privileged side effect.
 */
import { registerDeliveryAction } from '../delivery.js';
import { getMessagingGroup } from '../db/messaging-groups.js';
import { insertMessage } from '../db/session-db.js';
import { unguarded } from '../guard/index.js';
import { log } from '../log.js';

function generateId(): string {
  return `quota-recovery-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const DEFAULT_TEXT =
  'Your previous turn(s) were rejected with a provider quota error (budget or key ' +
  'limit exhausted) and never executed. Reading this note means the model is reachable ' +
  'again; check what those rejected turns were meant to do.';

registerDeliveryAction(
  'queue_quota_recovery_note',
  async (content, session, inDb) => {
    // One note per outage, not one per rejected tick: the first note stays
    // pending until a successful wake consumes it, and every later action
    // written while it is still pending describes the same still-open gap.
    const pending = inDb
      .prepare("SELECT 1 FROM messages_in WHERE status = 'pending' AND id LIKE 'quota-recovery-note-%' LIMIT 1")
      .get();
    if (pending) {
      log.info('Quota recovery note already pending — dropping duplicate', { sessionId: session.id });
      return;
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
        text: typeof content.text === 'string' ? content.text : DEFAULT_TEXT,
        sender: 'system',
        senderId: 'system',
      }),
      processAfter: null,
      recurrence: null,
      trigger: 0,
    });

    log.info('Quota recovery note queued — rides with the next wake', { sessionId: session.id });
  },
  unguarded('writes an inert context note into the same session; it never wakes anything'),
);
