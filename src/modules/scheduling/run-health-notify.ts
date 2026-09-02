/**
 * Delivery side of the task-run failure-streak detector.
 *
 * Split from `run-health.ts` so the streak accounting can be tested without a
 * channel adapter, a user table, or a DM round-trip.
 *
 * Routing mirrors the approvals path (`pickApprover` → `pickApprovalDelivery`):
 * scoped admins for the agent group, then global admins, then owners. There is
 * no separate "alerts" address to configure and get wrong.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { containerLogDir } from '../../container-logs.js';
import { pickApprover, pickApprovalDelivery } from '../approvals/primitive.js';

export interface RunHealthAlert {
  agentGroupId: string;
  series: string;
  signature: string;
  class: string;
  streak: number;
  firstSeen: string;
  excerpt: string;
}

/**
 * Build the message. Kept pure and exported so its content is testable: this
 * text is the entire point of the feature, and its value is whether a human
 * reading it on a phone can tell what broke and where to look next.
 */
export function formatRunHealthAlert(alert: RunHealthAlert, agentName: string): string {
  return [
    `⚠️ Scheduled task "${alert.series}" (${agentName}) has failed ${alert.streak} runs in a row.`,
    '',
    `First seen: ${alert.firstSeen}`,
    `Failure: ${alert.signature}`,
    '',
    '```',
    alert.excerpt,
    '```',
    '',
    // Without this pointer the recipient has the symptom and no way to the
    // cause — which is exactly the state this whole change exists to end.
    `Full container output: ${containerLogDir('<session>')} (see the host log line "Container exited non-zero" for the exact file).`,
    'No further alerts for this failure until it changes or clears.',
  ].join('\n');
}

/** Never throws — the caller has already marked the alert as sent. */
export async function notifyRunHealth(alert: RunHealthAlert): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.warn('Task-run failure streak detected but no delivery adapter is wired', { ...alert });
    return;
  }

  const approvers = pickApprover(alert.agentGroupId);
  const target = await pickApprovalDelivery(approvers, '');
  if (!target) {
    log.warn('Task-run failure streak detected but no approver DM could be resolved', { ...alert });
    return;
  }

  const agentName = getAgentGroup(alert.agentGroupId)?.name ?? alert.agentGroupId;
  log.warn('Task-run failure streak — notifying', { ...alert, approver: target.userId });

  try {
    await adapter.deliver(
      target.messagingGroup.channel_type,
      target.messagingGroup.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({ text: formatRunHealthAlert(alert, agentName) }),
    );
  } catch (err) {
    log.error('Failed to deliver task-run failure alert', { ...alert, err });
  }
}
