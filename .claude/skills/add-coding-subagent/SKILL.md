---
name: add-coding-subagent
description: Install a generic local coding and deterministic-verification subagent in an agent group. Use when an agent should delegate calculations, executable checks, scripts, or focused workspace coding to OpenRouter model z-ai/glm-5.3-flash.
---

# Add Coding Subagent

This skill installs a file-based `coder` subagent into one NanoClaw agent group. The subagent runs in the same container and working directory as its calling agent, so it can use the group's existing workspace. No host source changes, database migration, provider installation, or container image rebuild is required.

The installed subagent uses OpenRouter model `z-ai/glm-5.3-flash` with low reasoning effort and these tools:

- `Bash` for running scripts, tests, and local verification;
- `Read`, `Write`, and `Edit` for inspecting and changing authorized files;
- `Glob` and `Grep` for locating relevant files.

It has no web tools, MCP servers, or messaging tools.

## Choose the target group

Ask which agent group should receive the subagent. Use the group's folder name, not its display name. For example:

```text
groups/main-agent/
```

If the operator gives no target, use the agent group's configured workspace identified by the operator. Never install into multiple groups without explicit instruction.

## Check whether it is already installed

From the NanoClaw project root, check:

```bash
test -f groups/<group-folder>/.claude/agents/coder.md
```

If the file exists, inspect it. Preserve local changes and stop if it does not match the bundled definition; do not overwrite it silently. If it matches, report that the subagent is already installed.

## Install

Create the target directory if needed and copy the bundled definition:

```bash
mkdir -p groups/<group-folder>/.claude/agents
cp "${CLAUDE_SKILL_DIR}/coder.md" groups/<group-folder>/.claude/agents/coder.md
```

Replace `<group-folder>` with the explicitly selected group folder. The copy is the only installation change.

The file-based agent loader discovers `.claude/agents/*.md` and registers the definition with the Claude provider. The next container start loads the new definition. Restart the target group through the normal NanoClaw CLI or service workflow before verification.

## Workspace behavior

Give the subagent a complete order that includes its workspace mode and authorized path:

- **Ephemeral:** `/tmp` or `/workspace/scratch/` for throwaway scripts and outputs.
- **Shared:** an explicitly named path under `/workspace/agent/` for files the calling agent must inspect in the same group.
- **Persistent project:** `/workspace/agent/projects/<project-name>/` for projects that should survive container and NanoClaw restarts.

The group workspace maps to `groups/<group-folder>/` on the host and is persistent. File subagents run in the same container and can see it. Agents in other groups cannot see it; use NanoClaw's agent-to-agent messaging for cross-group exchange.

Do not ask the subagent to use a persistent project path for disposable outputs. Do not authorize broad access to secrets, `.env` files, generated fragments, or system files.

## Dependency hardening

The subagent has a mandatory one-week dependency cooldown. It must not install or resolve a dependency unless the active package manager proves that every newly resolved package version is at least seven days old.

Use only these configurations:

- Python: `uv` with `exclude-newer = "1 week"` or a stricter value in `pyproject.toml`, or an equivalent explicit `uv` command option.
- TypeScript or JavaScript: `pnpm` with `minimumReleaseAge: 10080` or more minutes; Yarn with `npmMinimalAgeGate: "1w"` or a longer gate; or Bun with `[install] minimumReleaseAge = 604800` or more seconds in `bunfig.toml`.

`tsc`, `tsx`, Vite, and other build tools do not enforce dependency age. They may run with already installed dependencies, but dependency resolution must happen through a compliant package manager first.

Do not use `pip`, `pipx`, `npm`, an unconfigured Bun/Yarn/pnpm setup, another package manager, package exclusions, bypass flags, manually downloaded archives, or exact versions as an age-gate bypass. If the gate is missing, weaker, ambiguous, or disabled, stop and report the blocker. Do not add package-manager exceptions without explicit operator approval.

The policy applies to direct and transitive dependencies, including tools added only for a build or test.

## Verify

First verify the definition and model locally:

```bash
sed -n '1,12p' groups/<group-folder>/.claude/agents/coder.md
```

Then restart the target group with the normal NanoClaw workflow and send a small deterministic task through the actual channel. Ask it to calculate a simple value by writing and running a short script, and confirm the response distinguishes executed commands from assumptions.

For a persistent-workspace check, ask it to create a small file under:

```text
/workspace/agent/projects/<project-name>/
```

Then restart the group and ask it to read that file. Remove the test project only if the operator explicitly requests cleanup.

## Troubleshooting

### `coder` does not appear

1. Confirm `groups/<group-folder>/.claude/agents/coder.md` exists.
2. Confirm the YAML frontmatter contains `description`, `model`, and `tools`.
3. Restart the target group so its container reloads file-based subagents.
4. Check the host and container logs for agent-definition parsing errors.

### Subagent cannot see a file

Confirm both agents use the same agent group and that the file is under `/workspace/agent/` or another explicitly mounted path. A companion agent from another group has a separate workspace and cannot read this group's files.

### Script runtime is unavailable

The subagent may use runtimes already present in the container, such as `python3`, `node`, `bun`, or repository-provided commands. If a new package or runtime is required, stop and request explicit authorization before changing dependencies or the container image.
