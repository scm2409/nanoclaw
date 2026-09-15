import { describe, it, expect } from 'bun:test';

import { BackgroundTaskTracker } from './background-tasks.js';

const started = (id: string, extra: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype: 'task_started',
  task_id: id,
  ...extra,
});
const settled = (id: string, extra: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype: 'task_notification',
  task_id: id,
  status: 'completed',
  ...extra,
});

describe('BackgroundTaskTracker', () => {
  it('counts a started task and reports the change', () => {
    const t = new BackgroundTaskTracker();
    expect(t.observe(started('t1'))?.outstanding).toBe(1);
    expect(t.outstanding).toBe(1);
  });

  it('reports no change when the same task starts twice', () => {
    const t = new BackgroundTaskTracker();
    t.observe(started('t1'));
    expect(t.observe(started('t1'))).toBeNull();
  });

  it('drops a task when its notification settles it', () => {
    const t = new BackgroundTaskTracker();
    t.observe(started('t1'));
    t.observe(started('t2'));
    expect(t.observe(settled('t1'))?.outstanding).toBe(1);
    expect(t.observe(settled('t2', { status: 'failed' }))?.outstanding).toBe(0);
    expect(t.outstanding).toBe(0);
  });

  it('settles on a stopped notification too', () => {
    const t = new BackgroundTaskTracker();
    t.observe(started('t1'));
    expect(t.observe(settled('t1', { status: 'stopped' }))?.outstanding).toBe(0);
  });

  it('settles on a terminal task_updated patch', () => {
    // Belt and braces: the SDK also patches task status through task_updated.
    // Missing a terminal event would leave a phantom task outstanding, and a
    // phantom task buys the container ceiling time it has not earned.
    const t = new BackgroundTaskTracker();
    t.observe(started('t1'));
    const change = t.observe({ type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'killed' } });
    expect(change?.outstanding).toBe(0);
  });

  it('ignores a non-terminal task_updated patch', () => {
    const t = new BackgroundTaskTracker();
    t.observe(started('t1'));
    expect(t.observe({ type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'running' } })).toBeNull();
    expect(t.outstanding).toBe(1);
  });

  it('ignores a notification for a task it never saw start', () => {
    const t = new BackgroundTaskTracker();
    expect(t.observe(settled('ghost'))).toBeNull();
  });

  it('ignores messages that are not task lifecycle', () => {
    const t = new BackgroundTaskTracker();
    expect(t.observe({ type: 'assistant' })).toBeNull();
    expect(t.observe({ type: 'system', subtype: 'init' })).toBeNull();
    expect(t.observe({ type: 'system', subtype: 'task_started' })).toBeNull();
  });

  // --- What settled, not just how many are left ---------------------------
  // A settle is worth waking a finished turn for only if somebody is actually
  // waiting on it. Delegated subagent work always is. A backgrounded shell
  // command is not, when it ran for seconds — those are the greps an agent
  // fires off mid-turn, and on 2026-09-15 each one woke KaiL into a full turn
  // that concluded "nothing new", 177 API calls and 17.9M tokens of them in a
  // day.

  it('reports what settled: a subagent task, with its description', () => {
    const t = new BackgroundTaskTracker();
    t.observe(started('t1', { subagent_type: 'software-engineer', description: 'r71 gate' }));
    const change = t.observe(settled('t1', { summary: 'Agent "r71 gate" finished' }));
    expect(change?.settled?.subagent).toBe(true);
    expect(change?.settled?.summary).toBe('Agent "r71 gate" finished');
  });

  it('reports a shell task as not-a-subagent', () => {
    const t = new BackgroundTaskTracker();
    t.observe(started('t1', { task_type: 'shell', description: 'Extract log lines' }));
    const change = t.observe(settled('t1', { summary: 'Extract log lines' }));
    expect(change?.settled?.subagent).toBe(false);
  });

  it('measures how long the task ran', () => {
    const t = new BackgroundTaskTracker();
    t.observe(started('t1', { task_type: 'shell' }), 1_000);
    const change = t.observe(settled('t1'), 91_000);
    expect(change?.settled?.durationMs).toBe(90_000);
  });

  it('prefers the notification own duration when the SDK reports one', () => {
    const t = new BackgroundTaskTracker();
    t.observe(started('t1', { task_type: 'shell' }), 1_000);
    const change = t.observe(settled('t1', { usage: { duration_ms: 4_242 } }), 5_000);
    expect(change?.settled?.durationMs).toBe(4_242);
  });

  it('falls back to a description when the notification has no summary', () => {
    const t = new BackgroundTaskTracker();
    t.observe(started('t1', { task_type: 'shell', description: 'Extract log lines' }));
    expect(t.observe(settled('t1'))?.settled?.summary).toBe('Extract log lines');
  });
});
