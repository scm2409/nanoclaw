---
name: configure-openrouter-claude-code
description: Configure NanoClaw's Claude Code harness to use OpenRouter's Anthropic-compatible API, manage the separate OneCLI OpenRouter secret, and change main or subagent models and reasoning effort.
---

# Configure Claude Code through OpenRouter

Use this skill when NanoClaw must keep the `claude` provider and Claude Code harness while routing requests to OpenRouter models. Do not install or select the OpenCode provider.

## Invariants

- Keep NanoClaw's provider set to `claude`.
- Keep Claude Code / `@anthropic-ai/claude-agent-sdk` as the runtime.
- Store the OpenRouter key only in OneCLI. Never put it in `.env`, a command argument, a DB row, a container config, or chat text.
- Use OpenRouter model IDs without an `openrouter/` prefix, for example `google/gemini-3.8-flash`.
- Set `effort` through NanoClaw's existing `ncl groups config update --effort` option. Supported values are `low`, `medium`, `high`, `xhigh`, and `max`.

## Configure endpoint

Ensure the host `.env` contains these non-secret settings:

```env
ANTHROPIC_BASE_URL=https://openrouter.ai/api
```

Do not add `ANTHROPIC_AUTH_TOKEN` for this harness path. Keep any existing `OPENROUTER_API_KEY` entry: it may serve other features and is unrelated to this setup. NanoClaw's Claude provider passes a harmless placeholder token, and OneCLI replaces the outgoing `Authorization` header with the stored secret.

Restart NanoClaw after changing `.env`. Resolve the unit name dynamically:

```bash
systemctl --user list-units --all | grep nanoclaw
systemctl --user restart <resolved-nanoclaw-unit>
```

## Add separate OneCLI secret

Open `http://127.0.0.1:10254` locally, or use the install's configured OneCLI web address. Navigate to **Connections → Custom → +Add Secret** and enter:

- Name: `OpenRouter NanoClaw`
- Type: `Generic Secret`
- Host pattern: `openrouter.ai`
- Header name: `Authorization`
- Value format: `Bearer {value}`
- Value: paste new OpenRouter key into the password/secret field

Save. Never paste key into terminal history. Confirm secret metadata with `onecli secrets list`; output must show host pattern and header configuration, never value.

If the NanoClaw OneCLI agent uses `secretMode: selective`, assign this secret to every relevant agent. Read current assignments first because `set-secrets` replaces the complete list.

## Select models

Main group:

```bash
ncl groups config update --id <group-id> --provider claude --model <model-id> --effort <effort>
ncl groups restart --id <group-id>
```

For file subagents, edit `groups/<folder>/.claude/agents/*.md` and set `model:` to the desired full OpenRouter ID. Set the smart escalation agent separately. Restart the group after edits.

Example:

```text
normal subagents: google/gemini-3.8-flash, effort inherited from main group
smart subagent: openai/gpt-5.6-sol, effort high when invoking it
```

Claude Code's SDK passes NanoClaw's `effort` option to the harness. File subagents may override both fields:

```yaml
model: openai/gpt-5.6-sol
effort: high
```

The runner validates named effort levels and passes them to the SDK.

## Set the compaction window

Claude Code cannot see the real context window of an OpenRouter model. It
auto-compacts against `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and triggers at roughly
three quarters of that value, so a 1M-context model still compacts early unless
the window is raised. The default is `500000`.

Override it in the host `.env` (or the host process env, which wins):

```env
CLAUDE_CODE_AUTO_COMPACT_WINDOW=500000
```

Must be a positive integer; anything else is ignored with a warning. Restart
NanoClaw, then restart the group — the value is read when the container spawns.

## Verify

1. `ncl groups config get --id <group-id>` shows provider `claude`, expected model, and effort.
2. `onecli secrets list` shows the separate OpenRouter secret metadata.
3. Restart the group.
4. Send a real test message with `pnpm run chat "Reply with the configured model name."`.
5. Inspect `logs/nanoclaw.error.log` for authentication or model errors.

If requests fail with authentication errors, check OneCLI secret host pattern and `Authorization: Bearer {value}` first. If requests fail with model errors, verify the exact OpenRouter slug and whether the selected model supports Claude Code's tool and message format.
