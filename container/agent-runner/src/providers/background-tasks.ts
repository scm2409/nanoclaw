/**
 * Bookkeeping for background work the CLI is running on the agent's behalf:
 * background subagents and backgrounded Bash commands.
 *
 * Why the host needs this at all: the heartbeat is touched per stream event,
 * and a background task emits nothing between `task_started` and the
 * `task_notification` that settles it. A long one therefore looks exactly like
 * an idle container, and the host's 30-minute ceiling killed it — six times on
 * 2026-09-12/13, each time taking the delegated work with it and leaving the
 * next turn holding a launch receipt for something that can never report back.
 *
 * The count is only as honest as the terminal events, so both of the SDK's
 * settle paths are consumed: `task_notification` (completed | failed | stopped)
 * and a terminal `task_updated` patch. A task counted forever would buy the
 * container ceiling time it has not earned; the host caps the extension for
 * exactly that reason.
 */

/** The subset of an SDK message this tracker reads. */
export interface TaskLifecycleMessage {
  type?: string;
  subtype?: string;
  task_id?: string;
  status?: string;
  patch?: { status?: string };
}

const TERMINAL_STATUS = new Set(['completed', 'failed', 'stopped', 'killed']);

export class BackgroundTaskTracker {
  private readonly live = new Set<string>();

  get outstanding(): number {
    return this.live.size;
  }

  /**
   * Feed one SDK message. Returns the new outstanding count when it changed,
   * or null when the message says nothing about background work — so the
   * caller can report a change without re-announcing an unchanged count.
   */
  observe(message: TaskLifecycleMessage): number | null {
    if (message.type !== 'system') return null;
    const id = message.task_id;
    if (!id) return null;

    if (message.subtype === 'task_started') {
      if (this.live.has(id)) return null;
      this.live.add(id);
      return this.live.size;
    }

    const settled =
      (message.subtype === 'task_notification' && TERMINAL_STATUS.has(message.status ?? '')) ||
      (message.subtype === 'task_updated' && TERMINAL_STATUS.has(message.patch?.status ?? ''));
    if (!settled) return null;
    if (!this.live.delete(id)) return null;
    return this.live.size;
  }
}
