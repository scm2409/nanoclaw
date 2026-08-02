/**
 * Test harness for starting and — crucially — actually STOPPING a poll loop.
 *
 * Bun runs every test file in one process, and the session DBs are
 * module-level in-memory singletons (db/connection.ts). A poll loop that
 * outlives the test that started it therefore keeps polling a database shared
 * with every later test, in this file and in every file that runs afterwards,
 * silently consuming their pending messages.
 *
 * That is exactly what used to happen. The old harness raced the loop against
 * an abort listener and a timeout, and the tests awaited THAT race — which
 * settles the instant `abort()` is called, while the loop itself is still
 * mid-turn and keeps running. `upload-trace.test.ts` was worse still: it never
 * passed the signal to runPollLoop at all, so its loop could not be stopped by
 * anything short of process exit.
 *
 * The symptom was a test in a completely different file timing out because its
 * message had been eaten, appearing and disappearing with file execution order
 * — the kind of failure that gets blamed on whatever change happened to be in
 * the tree at the time.
 *
 * So: `stopPollLoop` waits for the loop to genuinely finish, and throws if it
 * does not. A leak fails the test that caused it, in the file that caused it.
 */
import { runPollLoop } from '../poll-loop.js';
import type { AgentProvider } from '../providers/types.js';

/** How long a loop may take to notice the abort before we call it a leak. */
const STOP_TIMEOUT_MS = 5_000;

/**
 * Start a poll loop. Always pass the signal — it is the only way the loop can
 * ever be stopped (runPollLoop checks it at the top of each iteration).
 */
export function startPollLoop(provider: AgentProvider, signal: AbortSignal, cwd = '/tmp'): Promise<void> {
  return runPollLoop({ provider, providerName: 'mock', cwd, signal });
}

/**
 * Abort the loop and wait for it to actually stop.
 *
 * runPollLoop only checks the signal between iterations, so this resolves once
 * any in-flight turn finishes — which is the point: the DB must be quiet
 * before the next test touches it.
 */
export async function stopPollLoop(controller: AbortController, loop: Promise<void>): Promise<void> {
  controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = loop.catch(() => {});
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `poll loop still running ${STOP_TIMEOUT_MS}ms after abort — it will leak into the rest of this file and every file that runs after it`,
          ),
        ),
      STOP_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([stopped, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
