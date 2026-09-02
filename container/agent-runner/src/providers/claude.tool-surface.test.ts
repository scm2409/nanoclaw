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
 * Non-MCP tools the claude CLI (2.1.197) actually put on the wire, read out of
 * an llm-trace record rather than from documentation. Update this from a fresh
 * trace after a CLI bump — see docs/llm-trace.md.
 */
const OBSERVED_ON_THE_WIRE = [
  'Agent',
  'Bash',
  'Edit',
  'Glob',
  'Grep',
  'NotebookEdit',
  'Read',
  'SendMessage',
  'Skill',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'WebFetch',
  'WebSearch',
  'Workflow',
  'Write',
];

/** Never used once in 7,513 recorded tool calls, and 30,031 characters between them. */
const DEAD_WEIGHT = ['Workflow', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'];

describe('SDK_DISALLOWED_TOOLS', () => {
  it('drops the tools that cost prefix on every call and are never used', () => {
    for (const tool of DEAD_WEIGHT) {
      expect(SDK_DISALLOWED_TOOLS).toContain(tool);
    }
  });

  it('keeps the delegation tools the agent actually depends on', () => {
    // Agent runs every subagent (203 recorded calls); TaskOutput/TaskStop are
    // how a background agent is read and cancelled. Disallowing these would
    // silently break delegation, which is the opposite of the saving.
    for (const tool of ['Agent', 'TaskOutput', 'TaskStop']) {
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
