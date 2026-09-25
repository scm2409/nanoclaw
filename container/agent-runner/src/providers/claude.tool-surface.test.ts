/**
 * The tool surface the agent carries is a direct, recurring cost: every schema
 * is re-sent on every API call, and on providers where prompt caching does not
 * actually discount the prefix it is billed at full price each time. Measured
 * on the wire on 2026-09-02: 28 schemas, 57,413 characters, ~14k tokens of a
 * ~31.5k-token prefix.
 *
 * These tests pin the two lists that decide that surface. They are not style
 * checks — a name that drifts out of sync with the CLI is silent: the list
 * keeps looking authoritative while the tool it names no longer exists.
 */
import { describe, expect, it } from 'bun:test';

import { SDK_DISALLOWED_TOOLS, TOOL_ALLOWLIST } from './claude.js';

/**
 * Non-MCP tools the claude CLI (2.1.280) actually put on the wire, read out of
 * an llm-trace record rather than from documentation. Update this from a fresh
 * trace after a CLI bump — see docs/llm-trace.md.
 *
 * Read with SDK_DISALLOWED_TOOLS in force, so a disallowed tool is absent here
 * by construction; the tools disallowed before 2.1.280 were observed on the
 * wire under 2.1.197.
 */
const OBSERVED_ON_THE_WIRE = [
  'Agent',
  'Bash',
  'Edit',
  'Glob',
  'Grep',
  'ListAgents',
  'Monitor',
  'NotebookEdit',
  'Read',
  'SendMessage',
  'Skill',
  'TaskStop',
  'WebFetch',
  'WebSearch',
  'Write',
];

/** First on the wire with 2.1.280; they reach a phone or a cloud trigger that a container agent has neither of. */
const NO_TARGET_IN_A_CONTAINER = ['PushNotification', 'RemoteTrigger'];

/** Never used once in 7,513 recorded tool calls, and 30,031 characters between them. */
const DEAD_WEIGHT = ['Workflow', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'];

describe('SDK_DISALLOWED_TOOLS', () => {
  it('drops the tools that cost prefix on every call and are never used', () => {
    for (const tool of DEAD_WEIGHT) {
      expect(SDK_DISALLOWED_TOOLS).toContain(tool);
    }
  });

  it('drops the tools that have nothing to reach from inside a container', () => {
    for (const tool of NO_TARGET_IN_A_CONTAINER) {
      expect(SDK_DISALLOWED_TOOLS).toContain(tool);
    }
  });

  it('keeps the delegation tools the agent actually depends on', () => {
    // Agent runs every subagent (203 recorded calls); ListAgents/SendMessage/TaskStop
    // find, address and cancel a background agent. Disallowing these would
    // silently break delegation, which is the opposite of the saving.
    for (const tool of ['Agent', 'ListAgents', 'SendMessage', 'TaskStop']) {
      expect(SDK_DISALLOWED_TOOLS).not.toContain(tool);
    }
  });
});

describe('TOOL_ALLOWLIST', () => {
  it('names no tool the CLI no longer emits', () => {
    // `ToolSearch` is exempt: it only appears on the wire when deferred tools
    // are present, so a trace of an ordinary turn does not list it.
    const stale = TOOL_ALLOWLIST.filter((t) => t !== 'ToolSearch' && !OBSERVED_ON_THE_WIRE.includes(t));
    expect(stale).toEqual([]);
  });

  it('includes every wire tool that is not deliberately disallowed', () => {
    const missing = OBSERVED_ON_THE_WIRE.filter(
      (t) => !TOOL_ALLOWLIST.includes(t) && !SDK_DISALLOWED_TOOLS.includes(t),
    );
    expect(missing).toEqual([]);
  });

  it('never lists a tool that is also disallowed', () => {
    const both = TOOL_ALLOWLIST.filter((t) => SDK_DISALLOWED_TOOLS.includes(t));
    expect(both).toEqual([]);
  });
});
