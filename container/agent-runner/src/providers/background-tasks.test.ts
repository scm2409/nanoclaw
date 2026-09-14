import { describe, it, expect } from 'bun:test';

import { BackgroundTaskTracker } from './background-tasks.js';

describe('BackgroundTaskTracker', () => {
  it('counts a started task and reports the change', () => {
    const t = new BackgroundTaskTracker();
    expect(t.observe({ type: 'system', subtype: 'task_started', task_id: 't1' })).toBe(1);
    expect(t.outstanding).toBe(1);
  });

  it('reports no change when the same task starts twice', () => {
    const t = new BackgroundTaskTracker();
    t.observe({ type: 'system', subtype: 'task_started', task_id: 't1' });
    expect(t.observe({ type: 'system', subtype: 'task_started', task_id: 't1' })).toBeNull();
  });

  it('drops a task when its notification settles it', () => {
    const t = new BackgroundTaskTracker();
    t.observe({ type: 'system', subtype: 'task_started', task_id: 't1' });
    t.observe({ type: 'system', subtype: 'task_started', task_id: 't2' });
    expect(t.observe({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed' })).toBe(1);
    expect(t.observe({ type: 'system', subtype: 'task_notification', task_id: 't2', status: 'failed' })).toBe(0);
    expect(t.outstanding).toBe(0);
  });

  it('settles on a stopped notification too', () => {
    const t = new BackgroundTaskTracker();
    t.observe({ type: 'system', subtype: 'task_started', task_id: 't1' });
    expect(t.observe({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'stopped' })).toBe(0);
  });

  it('settles on a terminal task_updated patch', () => {
    // Belt and braces: the SDK also patches task status through task_updated.
    // Missing a terminal event would leave a phantom task outstanding, and a
    // phantom task buys the container ceiling time it has not earned.
    const t = new BackgroundTaskTracker();
    t.observe({ type: 'system', subtype: 'task_started', task_id: 't1' });
    expect(t.observe({ type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'killed' } })).toBe(0);
  });

  it('ignores a non-terminal task_updated patch', () => {
    const t = new BackgroundTaskTracker();
    t.observe({ type: 'system', subtype: 'task_started', task_id: 't1' });
    expect(t.observe({ type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'running' } })).toBeNull();
    expect(t.outstanding).toBe(1);
  });

  it('ignores a notification for a task it never saw start', () => {
    const t = new BackgroundTaskTracker();
    expect(t.observe({ type: 'system', subtype: 'task_notification', task_id: 'ghost', status: 'completed' })).toBeNull();
  });

  it('ignores messages that are not task lifecycle', () => {
    const t = new BackgroundTaskTracker();
    expect(t.observe({ type: 'assistant' })).toBeNull();
    expect(t.observe({ type: 'system', subtype: 'init', session_id: 's' })).toBeNull();
    expect(t.observe({ type: 'system', subtype: 'task_started' })).toBeNull();
  });
});
