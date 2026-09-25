---
name: devbox-opencode
description: Drive OpenCode headless on the dev box as the software engineer's coding tool — invocation, its agents and models, the global rules it runs under, permissions, MCP servers, skills, and the spend-limit stop. Use whenever a mandate is executed with OpenCode on the dev box. OpenCode is the fallback; Claude Code (skill `devbox-claude-code`) is the default.
---

# OpenCode on the dev box

OpenCode is the dev box's fallback coding tool — installed, configured and
working, but not the default. It runs only when the calling agent's order
says so. Everything here runs over the pinned SSH call from your own
instructions, as the unprivileged account.

OpenCode has its own OpenRouter credential in
`~/.local/share/opencode/auth.json`. Never read, print or touch it.

## Headless call

```bash
cd /home/dev/projects/<slug> && opencode run --format json "$(cat <mandate file>)" \
  > <run dir>/result.jsonl 2> <run dir>/stderr.log
```

- Sessions persist: `--continue` or `--session <id>`. Every continuation
  re-reads the full transcript, and nothing is learned across sessions — the
  knowledge file named in the mandate is the only continuity.
- Long runs go under `nohup … &`, like every long command on the box, and
  you poll the output.

## Agents and models

Configured in `~/.config/opencode/opencode.json` and `opencode.jsonc`. Both
are loaded; the `model` / `variant` fields are what counts, comments in the
`.jsonc` can be stale.

- **build** — the implementer: `openrouter/openai/gpt-6-luna`, variant `max`.
- **plan** (`mode: "all"`) — `gpt-6-sol`, variant `medium`, deliberately a
  stronger model than the implementer. Phase 1 of a plan-first mandate runs
  through it. Never override its model in a mandate.
- **hard-case** — the escalation agent: `gpt-6-sol`, variant `xhigh`. Do not
  change its model. When OpenCode stops making progress, unblock `hard-case`
  (grant what it is missing in the config) instead of routing around it.

## Global rules (`~/.config/opencode/AGENTS.md`)

OpenCode runs under these on every project; a mandate does not repeat them:

- **Test-first delivery** — the e2e test or its scaffold first, run red once.
  The gate crosses the same boundary the user does and asserts at the
  outermost observable effect.
- **Hard-case escalation** — trigger A: the same problem unsolved after three
  diagnosis attempts in one session. Trigger B: three rounds in a row without
  green, so the next round opens with `hard-case`. Budget about 90 minutes or
  a tool-call cap; the cap is raised only on the owner's order. Diagnostics
  stay value-free.
- **Plan-first for new features** — Phase 1 plan through the `plan` agent
  (approach, affected files, e2e proof), Phase 2 implementation. Skipped only
  for a genuinely trivial addition, and the report says why.
- **Terminology** (`~/.config/opencode/terminology.md`) — "e2e" includes the
  UI and asserts on the rendered app; a test without UI is an integration
  test, whatever its name.

## Permissions (`permission` in the config)

`edit` and `bash` are allowed. `external_directory` grants cover the
toolchains and caches (android-sdk, `.android`, `.gradle`, `.java`, `.cache`,
jdks, mise, `.opencode`), the skills, the reference checkouts, `/home/dev/*`
and the project. Deliberately not granted: `~/.ssh`,
`~/.local/share/opencode` (holds `auth.json`), other projects. `.env`
protection is on.

## MCP servers (`mcp` in the config)

`deepwiki` (remote, `https://mcp.deepwiki.com/mcp`) and `context7` (remote,
header `Bearer {env:CONTEXT7_API_KEY}`). Adding a server a task needs is your
job; report what you added and why.

## Where knowledge goes

- **Project knowledge** — the repo's `AGENTS.md`; OpenCode reads it
  automatically.
- **Cross-project recipes** — `~/.config/opencode/skills/<name>/SKILL.md`
  (e.g. `poc-architecture`). Say in your report when you wrote one.

## Spend limit is a stop

An OpenRouter 402 such as `in_flight_budget_exhausted`, or any other spend
limit error, is the monthly limit, not a bug. Stop, report where the owner
can raise it, and never work around it or retry.
