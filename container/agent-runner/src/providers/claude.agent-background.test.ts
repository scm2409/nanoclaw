/**
 * Every subagent call runs in the background, enforced here rather than asked
 * for in a prompt.
 *
 * A synchronous `Agent` call blocks the main thread for as long as the subagent
 * works: the tool result is the subagent's finished report. Measured live on
 * 2026-09-09 — one `software-engineer` call held the main thread for 39 minutes
 * with no model call in between, and two user messages that arrived meanwhile
 * (14:47 and 15:02 local) only reached the model at the end of it. Nothing was
 * lost, but the agent was unreachable for the whole run and never acted on them.
 *
 * The CLI's `Agent` tool defaults `run_in_background` to false in this version,
 * and asking the model to set it does not hold: across 2026-09-08/09 it passed
 * the flag on 2 of 14 calls. A PreToolUse hook rewrites the input before the
 * tool runs, which is the only version of a default that cannot be forgotten.
 *
 * It only fills the gap. An `Agent` call that states `run_in_background` either
 * way is left as it is — a deliberate foreground call stays possible for the
 * rare order whose very next step needs the result.
 *
 * Background work still keeps the container alive: every subagent step emits a
 * task notification into the main stream (92 of them in one evening), and each
 * event touches the heartbeat — so the host's 30-minute idle ceiling never sees
 * a working agent as idle.
 */
import { describe, it, expect } from 'bun:test';

import { preToolUseHook } from './claude.js';

// The hook's second and third arguments are the SDK's tool-use id and a
// callback context; neither is read here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (input: unknown) => preToolUseHook(input as any, undefined as any, undefined as any);

function agentInput(extra: Record<string, unknown> = {}) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_use_id: 'tu-1',
    tool_input: { description: 'do a thing', prompt: 'the order', subagent_type: 'coder', ...extra },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const updated = (out: any) => out?.hookSpecificOutput?.updatedInput;

describe('Agent calls default to the background', () => {
  it('adds run_in_background to a call that omits it', async () => {
    const out = await call(agentInput());
    expect(updated(out)).toEqual({
      description: 'do a thing',
      prompt: 'the order',
      subagent_type: 'coder',
      run_in_background: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((out as any).hookSpecificOutput.hookEventName).toBe('PreToolUse');
  });

  it('respects an explicit false — the agent may still choose the foreground', async () => {
    // A default, not a cage: an order whose very next step needs the result is
    // allowed to wait for it. Only the unstated case is decided here.
    const out = await call(agentInput({ run_in_background: false }));
    expect(updated(out)).toBeUndefined();
  });

  it('leaves an explicit true alone', async () => {
    const out = await call(agentInput({ run_in_background: true }));
    expect(updated(out)).toBeUndefined();
  });

  it('preserves every other field, including the model override', async () => {
    const out = await call(agentInput({ model: 'openai/gpt-5.6-sol', isolation: 'worktree' }));
    expect(updated(out)).toMatchObject({
      description: 'do a thing',
      prompt: 'the order',
      subagent_type: 'coder',
      model: 'openai/gpt-5.6-sol',
      isolation: 'worktree',
      run_in_background: true,
    });
  });

  it('does not touch other tools', async () => {
    const out = await call({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_use_id: 'tu-2',
      tool_input: { command: 'ls', timeout: 5000 },
    });
    expect(updated(out)).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((out as any).continue).toBe(true);
  });

  it('still blocks a disallowed tool rather than rewriting it', async () => {
    const out = await call({
      hook_event_name: 'PreToolUse',
      tool_name: 'Workflow',
      tool_use_id: 'tu-3',
      tool_input: {},
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((out as any).hookSpecificOutput.permissionDecision).toBe('deny');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((out as any).hookSpecificOutput.updatedInput).toBeUndefined();
  });
});
