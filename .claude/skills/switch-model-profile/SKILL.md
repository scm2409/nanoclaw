---
name: switch-model-profile
description: Switch every agent group between saved LLM setups (API endpoint + main model/effort + subagent models/efforts) in one step, or save the current setup as a profile. Use for "switch to Anthropic", "switch back to OpenRouter", "save the current model setup", "which profile are we on".
---

# Switch model profile

A model profile is one JSON file in `config/model-profiles/<name>.json` that pins
everything deciding which API and which models the agents use:

- `anthropicBaseUrl` — the install-wide `ANTHROPIC_BASE_URL` in `.env`. `null` means
  Anthropic direct: the line is commented out, never deleted, so switching back
  restores it byte for byte.
- per agent group folder: `model` and `effort` of its container config.
- per file subagent (`groups/<folder>/.claude/agents/<name>.md`): the `model:` and
  `effort:` frontmatter lines. Nothing else in those files is touched.

All commands run from the repo root.

## 1. Look at the current state

```bash
pnpm exec tsx scripts/model-profile.ts list
pnpm exec tsx scripts/model-profile.ts show
```

`show` prints the live setup and names the saved profile it matches. If it matches
none, save it first so nothing is lost:

```bash
pnpm exec tsx scripts/model-profile.ts save <name>
```

Edit the new file's `description` so the next reader knows what it is.

## 2. Preview, then apply

```bash
pnpm exec tsx scripts/model-profile.ts apply <name> --dry-run
```

Show the change list to the user and get a yes. Then:

```bash
pnpm exec tsx scripts/model-profile.ts apply <name>
```

It edits `.env`, updates each group via `ncl groups config update`, rewrites the
subagent frontmatter, and runs `ncl groups restart` per group. The restart kills a
running turn or scheduled task — pick a quiet moment.

## 3. Verify

```bash
pnpm run chat "Kurzer Test: antworte nur mit ok."
```

Then read the newest LLM trace record (if tracing is on) or
`logs/nanoclaw.error.log`: status 200, the expected `model`, and on a second turn a
growing `cache_read_input_tokens`. Ask the agent to use one cheap and one top-tier
subagent to prove their models answer too.

## 4. Write it down

Log the switch in `CONFIG-CHANGELOG.md` (what, why, and `apply <old>` as the way
back). Subagent files changed, so `FORK-CHANGELOG.md` gets an entry too.

## Credentials

Profiles carry no credentials. OneCLI injects the secret whose host pattern matches
the endpoint: `api.anthropic.com` for Anthropic direct, `openrouter.ai` for OpenRouter.
Agents here run in `selective` secret mode, so each agent needs both secrets assigned
once — then every profile works without touching OneCLI:

```bash
onecli agents list                    # agent id per group identifier
onecli agents secrets --id <agent-id> # current assignment
onecli agents set-secrets --id <agent-id> --secret-ids <existing>,<new>
```

`set-secrets` replaces the whole list — always pass the existing ids too.

## Troubleshooting

- **401 after a switch** — the agent lacks the secret for the new host. See Credentials.
- **404 / "model not found"** — a model id that the endpoint does not serve: OpenRouter
  ids are `vendor/slug`, Anthropic ids are `claude-…`. A profile mixing them is wrong.
- **400 "Claude Code … does not support this model; version X or newer is required"** —
  the container's Claude Code CLI is older than the model. Bump
  `@anthropic-ai/claude-code` in `container/cli-tools.json`, run `./container/build.sh`
  and `ncl groups restart --id <group> --rebuild`, then re-check the tool surface as
  `docs/llm-trace.md` describes (tool names drift between CLI versions).
- **400 on `effort`** — the model does not accept the effort parameter (Claude Haiku 4.5).
  Use a model that does, or set that entry's `effort` to `null`.
