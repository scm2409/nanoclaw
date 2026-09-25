---
name: devbox-claude-code
description: Drive Claude Code headless on the dev box as the software engineer's coding tool — invocation, reading its JSON result, telling a usage limit from a throttle, model and effort, plan mode, subagents, permissions, MCP servers, and where knowledge goes. Use whenever a mandate is executed with Claude Code on the dev box.
---

# Claude Code on the dev box

Claude Code is the dev box's default coding tool. OpenCode stays installed as
the fallback (skill `devbox-opencode`); which one runs is the calling agent's
order, never your own choice. Everything here runs over the pinned SSH call
from your own instructions, as the unprivileged account.

The binary is `~/.local/bin/claude` (native installer, auto-update channel
`latest` — leave it that way). Docs: https://code.claude.com/docs/en/

## Login is not yours

Claude Code runs on the owner's subscription, not on API billing. The owner
logs in personally; the credential never passes through agent hands. It reaches
every SSH session of your key through an `environment=` entry in
`authorized_keys`, so a plain non-interactive SSH command is already logged in
— no `source`, no wrapper, no shell startup file.

- Check with `claude auth status` (JSON: `loggedIn`, `authMethod`).
- Not logged in, or the token expired: stop and report it under
  `Blocked on Martin`. Never run `claude auth login` or `claude setup-token`,
  never read, print, copy or move the token, and never touch
  `authorized_keys`.

## Headless call

```bash
cd /home/dev/projects/<slug> && claude -p "$(cat <mandate file>)" \
  --output-format json --permission-mode acceptEdits \
  > <run dir>/result.json 2> <run dir>/stderr.log
```

- **Read `is_error`, not the exit code.** The JSON carries `result`,
  `session_id`, `total_cost_usd` and `is_error`. A missing login or a hit
  usage limit still exits 0.
- **Permission mode:** headless `-p` defaults to asking, which nobody
  answers — always pass a mode. `acceptEdits` for implementation. Never
  `bypassPermissions` / `--dangerously-skip-permissions`; grant what the run
  needs through `allow` rules instead (see Permissions).
- **Never `--bare`.** It skips hooks, skills, `CLAUDE.md` and auto memory —
  everything the run relies on.
- **Continue** a run with `--resume <session_id>` (or `--continue` for the
  most recent session in that directory). Keep the `session_id` in the run
  directory.
- Long runs go under `nohup … &`, like every long command on the box, and
  you poll the result file.

## Usage limit versus throttle

The subscription has two rolling windows (5 hours and one week), shared by all
models, plus separate per-model quotas. With `is_error: true`, `result` says
which one:

- `You've hit your session limit · resets <time>`
- `You've hit your weekly limit · resets <time>`
- `You've hit your Opus limit · resets <time>` — another model would get
  past this one, but only on the calling agent's order.

A real limit is a stop: report it with the reset time, do not retry, do not
switch to OpenCode on your own. The calling agent decides.

Different and retryable: `API Error: Server is temporarily limiting requests
(not your usage limit)` is a server-side throttle. Wait and retry.

## Model and effort

The owner's standing choice for ordinary coding is **Opus 5.5 at effort
`medium`**. Set it explicitly even though it is the model's default, so a
changed default cannot move it silently:

- `~/.claude/settings.json`: `"model": "claude-opus-5-5"`,
  `"effortLevel": "medium"`, or per call `--model claude-opus-5-5 --effort medium`.
- Levels: `low | medium | high | xhigh | max`. Flag/env beat saved settings,
  which beat the model default.
- Change the model or effort only on the calling agent's order.

## Plan-first uses plan mode

Claude Code has a built-in read-only plan mode; it needs no separate plan
agent. For a plan-first mandate run Phase 1 with `--permission-mode plan`,
keep the plan in the run directory, then run Phase 2 with `acceptEdits` and
the plan as part of the prompt.

## Subagents

Project subagents live in the repo's `.claude/agents/<name>.md` (versioned,
wins over the user level), account-wide ones in `~/.claude/agents/`. YAML
frontmatter needs `name` and `description`; useful optional fields are
`tools`, `disallowedTools`, `model`, `effort`, `permissionMode`, `maxTurns`,
`skills` and `mcpServers`. This is where an escalation agent for hard cases
belongs, the counterpart of OpenCode's `hard-case`.

## Permissions

`permissions` in `settings.json` (project `.claude/settings.json`, or the
account's `~/.claude/settings.json`):

- `allow` / `ask` / `deny`, each a list of `Tool` or `Tool(specifier)`. Bash
  rules match the whole command with `*` wildcards; file tools take
  gitignore-style paths. Evaluation is deny, then ask, then allow — a deny
  always wins.
- `additionalDirectories` for paths outside the project (toolchains, SDKs,
  caches, reference checkouts).
- Always deny credentials: `~/.ssh`, `~/.claude.json` and `~/.claude/`
  themselves, `~/.git-credentials`, `.env*`, and OpenCode's
  `~/.local/share/opencode/`.

Setting these up so the run can work is your job; loosening a deny on
credentials is not.

## MCP servers

```bash
claude mcp add --scope user --transport http deepwiki https://mcp.deepwiki.com/mcp
```

A server that needs an auth header from an environment variable goes into
`.mcp.json` (project) or the user config, not `--header` (that takes literal
values only):

```json
{"mcpServers": {"context7": {"type": "http", "url": "<url>",
  "headers": {"Authorization": "Bearer ${CONTEXT7_API_KEY}"}}}}
```

Credential-like names (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`HTTPS_PROXY`, `NPM_TOKEN`, …) are deliberately not substituted there.

## Where knowledge goes

- **Project knowledge** stays in the repo's `AGENTS.md`, shared with
  OpenCode. Since v2.1.277 Claude Code reads `AGENTS.md` by itself — but only
  while no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` exists in
  the project **or any directory above it**. One such file, even in
  `/home/dev` or `/home/dev/projects`, silently switches `AGENTS.md` off. So
  create none; a project that genuinely needs a `CLAUDE.md` makes it import
  `@AGENTS.md`. `~/.claude/CLAUDE.md` does not count and loads alongside.
  Docs: https://code.claude.com/docs/en/memory#agents-md
- **Cross-project recipes** go to `~/.claude/skills/<name>/SKILL.md`. Claude
  Code does not read OpenCode's `~/.config/opencode/skills/`; a recipe needed
  by both exists in both places.
- **Account-wide rules** (the counterpart of OpenCode's global `AGENTS.md`)
  go in `~/.claude/CLAUDE.md`.
- **Auto memory** (`~/.claude/projects/<project>/memory/`) is Claude Code's
  own and decides for itself what to keep. It never replaces the explicit
  knowledge file a mandate names — that file stays the one source that is
  guaranteed to contain what was written into it.
