import { beforeEach, describe, expect, test } from 'bun:test';

import {
  clearContainerToolInFlight,
  getOutboundDb,
  initTestSessionDb,
  refreshBackgroundTasks,
  setBackgroundTasks,
  setContainerToolInFlight,
} from './connection.js';

beforeEach(() => {
  initTestSessionDb();
});

function readState(): { background_tasks: number | null; updated_at: string; current_tool: string | null } {
  return getOutboundDb()
    .prepare('SELECT background_tasks, updated_at, current_tool FROM container_state WHERE id = 1')
    .get() as { background_tasks: number | null; updated_at: string; current_tool: string | null };
}

describe('container_state — background tasks', () => {
  test('records the outstanding count', () => {
    setBackgroundTasks(2);
    expect(readState().background_tasks).toBe(2);
    setBackgroundTasks(0);
    expect(readState().background_tasks).toBe(0);
  });

  test('re-stamps updated_at while work is outstanding', async () => {
    setBackgroundTasks(1);
    const first = readState().updated_at;
    await new Promise((r) => setTimeout(r, 5));
    refreshBackgroundTasks();
    expect(readState().updated_at > first).toBe(true);
  });

  test('does not re-stamp when nothing is outstanding', async () => {
    // The stamp is what tells the host the count is current. Refreshing it with
    // a count of zero would be noise; refreshing it with a stale nonzero count
    // would be a lie that buys ceiling time.
    setBackgroundTasks(0);
    const first = readState().updated_at;
    await new Promise((r) => setTimeout(r, 5));
    refreshBackgroundTasks();
    expect(readState().updated_at).toBe(first);
  });

  test('tool bookkeeping leaves the background count alone', () => {
    setBackgroundTasks(3);
    setContainerToolInFlight('Bash', 600_000);
    expect(readState().background_tasks).toBe(3);
    clearContainerToolInFlight();
    const after = readState();
    expect(after.background_tasks).toBe(3);
    expect(after.current_tool).toBeNull();
  });
});
