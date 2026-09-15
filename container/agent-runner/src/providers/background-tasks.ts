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
  summary?: string;
  description?: string;
  subagent_type?: string;
  task_type?: string;
  usage?: { duration_ms?: number };
  patch?: { status?: string };
}

/** What a settled task was, for callers deciding whether it is worth reacting to. */
export interface SettledTask {
  summary: string;
  /** True for Task-tool subagents; false for shell and other background tasks. */
  subagent: boolean;
  durationMs: number;
}

export interface TaskChange {
  outstanding: number;
  /** Present when this change was a task settling, absent when one started. */
  settled?: SettledTask;
}

const TERMINAL_STATUS = new Set(['completed', 'failed', 'stopped', 'killed']);

interface LiveTask {
  startedAtMs: number;
  subagent: boolean;
  description: string;
}

export class BackgroundTaskTracker {
  private readonly live = new Map<string, LiveTask>();

  get outstanding(): number {
    return this.live.size;
  }

  /**
   * Feed one SDK message. Returns the new outstanding count when it changed —
   * plus what settled, when the change was a settle — or null when the message
   * says nothing about background work, so the caller can report a change
   * without re-announcing an unchanged count.
   *
   * `nowMs` exists so duration is testable; it defaults to the wall clock.
   */
  observe(message: TaskLifecycleMessage, nowMs: number = Date.now()): TaskChange | null {
    if (message.type !== 'system') return null;
    const id = message.task_id;
    if (!id) return null;

    if (message.subtype === 'task_started') {
      if (this.live.has(id)) return null;
      this.live.set(id, {
        startedAtMs: nowMs,
        subagent: Boolean(message.subagent_type),
        description: message.description ?? '',
      });
      return { outstanding: this.live.size };
    }

    const isSettle =
      (message.subtype === 'task_notification' && TERMINAL_STATUS.has(message.status ?? '')) ||
      (message.subtype === 'task_updated' && TERMINAL_STATUS.has(message.patch?.status ?? ''));
    if (!isSettle) return null;
    const task = this.live.get(id);
    if (!task) return null;
    this.live.delete(id);

    return {
      outstanding: this.live.size,
      settled: {
        // The SDK's own duration is authoritative when it reports one: it
        // measures the task, while our clock only measures what we saw of it.
        durationMs: message.usage?.duration_ms ?? nowMs - task.startedAtMs,
        subagent: task.subagent,
        summary: message.summary || task.description || 'a background task',
      },
    };
  }
}
