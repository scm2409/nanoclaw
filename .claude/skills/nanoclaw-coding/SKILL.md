---
name: nanoclaw-coding
description: "Hard-won conventions for hands-on-keyboard coding on NanoClaw's own codebase — host src/, container/agent-runner/src/, DB migrations, CLI resources (ncl), and their tests. Covers: ask before implementing or committing, follow existing plumbing patterns instead of inventing new ones, TDD (mandatory for Matrix), and — the rule that keeps getting missed — always self-verify a change end-to-end (including any required service/container restart) before telling the user it's ready to test. Load this before editing this repo's own code. Does NOT apply to using NanoClaw as an end user, running product setup skills, or installing channels."
---

# NanoClaw Coding Conventions

Established rules for working on NanoClaw's own source — distilled from repeated corrections
across sessions (see the individual `feedback_*` / `project_*` memory files under
`~/.claude/projects/*/memory/` for full history and rationale; this skill is the actionable
summary, not a replacement for that record).

## When to use

- Editing this repo's own TypeScript, DB migrations, CLI (`ncl`), or their tests.
- NOT for: installing/using a product skill, running NanoClaw as an assistant, general chat,
  or writing a NanoClaw *product* skill (those follow `docs/skill-guidelines.md` instead — a
  different rulebook from this one).

## Before writing any code

1. **Ask first.** Even for a small, "obviously wanted" fix, propose it and wait for an explicit
   yes before `Write`/`Edit`. A request that could be read as "explain this" or "build this"
   defaults to explaining — a prior offer earlier in the conversation is not the same as a
   later go-ahead.
2. **Never commit or push without asking — every single time**, even mid-flow on a change that
   feels obviously wanted, even though a scoped GitHub PAT exists on this machine. Stage freely;
   stop before `git commit` and before `git push`. The rule specifically erodes under "this is
   clearly wanted" pressure — that's exactly when to slow down and ask.
3. **Secrets never touch bash history.** If a secret needs to land in `.env` or similar, don't
   give the user a command with the secret as a literal argument. Give them an interactive one
   instead:
   ```bash
   read -s -p "Secret value: " VAR && echo >&2 && printf 'ENV_KEY=%s\n' "$VAR" >> .env && unset VAR
   ```

## Test-driven development

- Write the failing test **first**, confirm it fails for the right reason, then implement until
  green — not "implement, then backfill a test that happens to pass."
- **Mandatory** for anything under `src/channels/matrix*.ts`: that channel has repeatedly
  regressed in production from fixes whose tests were shaped around the implementation rather
  than the observed symptom.
- For Matrix specifically, also weigh whether the case belongs in the live E2E suite (below)
  rather than a unit test — the incidents that actually hurt were integration-level, not
  logic-level.
- If TDD genuinely isn't possible for a given case, say so and explain why instead of silently
  skipping it.

## Follow the existing plumbing pattern — don't invent a new one

NanoClaw repeats the same shape for each category of change. Before writing a new mechanism,
grep/Explore for the closest existing instance and copy its exact touch points rather than
designing from scratch.

Example — a new per-agent-group container-config toggle (e.g. `log_subagents`,
`show_token_usage`) always threads through the same chain:

| Step | File |
|---|---|
| 1. DB column | new migration in `src/db/migrations/` |
| 2. Row type | `src/types.ts` (`ContainerConfigRow`) |
| 3. Scalar plumbing | `src/db/container-configs.ts` (`SCALAR_COLUMNS`, the `Pick<...>` union, the `INSERT` column list) |
| 4. Materialized config | `src/container-config.ts` (`ContainerConfig` + `configFromDb()`) |
| 5. CLI surface | `src/cli/resources/groups.ts` (`config update` handler, both usage strings, `presentConfig`) |
| 6. Runner config | `container/agent-runner/src/config.ts` (`RunnerConfig` + `loadConfig()`) |
| 7. Threading | `container/agent-runner/src/index.ts` → `runPollLoop()` → `processQuery()` |
| 8. Gated effect | inline in `poll-loop.ts`'s event loop — a side-channel `writeMessageOut()`, **never** `query.push()`, so it can never leak into the agent's own context |

Add a matching test at each existing test file's location (`poll-loop.test.ts`, `groups.test.ts`,
provider tests), following that file's existing test style — don't introduce a second testing
convention alongside an established one.

## Group persona/instructions — edit the source, never the generated fragment

A group's persona/behavioral instructions live in `groups/<folder>/instructions.prepend.md`.
**Never edit `groups/<folder>/.claude-fragments/persona.md` directly** — it is a generated
copy. `composeGroupClaudeMd()` (`src/claude-md-compose.ts`) calls `readGroupPersona()`
(`src/group-persona.ts`, reads `instructions.prepend.md`) and overwrites the fragment from it
on every container spawn. A direct edit to the fragment survives only until the next
`ncl groups restart` (or natural respawn), then silently reverts to whatever
`instructions.prepend.md` still says — this has happened twice now. If a "file modified
externally" notice appears for a `.claude-fragments/*` file right after a restart, that's this
regeneration overwriting your edit, not a real external change — re-apply it to
`instructions.prepend.md` instead of trusting the fragment.

## Self-verify before saying "ready to test" — the rule that keeps getting missed

Two recorded incidents of declaring a change done/ready without actually exercising it
end-to-end. **Passing `tsc` / unit tests is not the same as verification** — it cannot catch a
stale running host process, a `container.json` not yet re-materialized from the DB, or a CLI
flag the currently-running binary doesn't recognize yet.

Before telling the user anything is ready:

- **Behavior/persona/tool-usage change** → `pnpm run chat "<message>"` (CLI channel, same
  production agent group, isolated session/thread — no Matrix round-trip) and read the actual
  reply.
- **Matrix channel change** → the live E2E harness (below). Synthetic `ncl messaging-groups send`
  does **not** exercise the same path as a real inbound event — not a substitute.
- **Anything needing a host/container restart to take effect** (new migration, new
  container-config field, new CLI flag): actually perform that restart and send a real test
  message — don't say it "should" work now on the strength of tests alone. If `pnpm run chat`'s
  own short silence-timeout exits before the full reply lands, check the session DB directly:
  ```bash
  pnpm exec tsx scripts/q.ts data/v2-sessions/<group>/<session>/outbound.db \
    "SELECT seq, timestamp, content FROM messages_out ORDER BY seq DESC LIMIT 10"
  ```
- Only ask the user to test something Claude genuinely cannot reach itself (a channel with no
  test account, a UI it can't drive).

## Service/process gotchas

- NanoClaw runs under a systemd `--user` service with a **per-install random-suffixed unit name**
  (`nanoclaw-v2-XXXXXXXX.service`) — never hardcode it. Resolve it fresh every time:
  ```bash
  systemctl --user list-units --all | grep nanoclaw
  ```
- Never hand-start it (`node dist/index.js` directly) alongside or instead of the service — it
  causes port/session conflicts that masquerade as unrelated bugs (`EADDRINUSE`, Matrix
  device-identity conflicts).
- Editing host `src/` requires `pnpm run build` (compiles to `dist/`) **and** a service restart
  before it's live. Production runs the compiled `dist/index.js` via systemd, never `tsx` — `src/`
  changes alone do nothing until rebuilt and restarted. A DB migration added to
  `src/db/migrations/index.ts` runs automatically on the next host startup, but only then.
- Editing `container/agent-runner/src/` does **not** need an image rebuild — it's bind-mounted
  read-only into the container; a plain `ncl groups restart --id <group>` picks it up
  immediately. A rebuild (`./container/build.sh` / `ncl groups restart --rebuild`) is only needed
  for Dockerfile, apt/npm package, or other dependency changes.
- `ncl groups config update ...` changes save to the DB but don't take effect for an
  already-running container until `ncl groups restart --id <group>` — or the next natural
  respawn, which re-materializes `container.json` from the DB automatically.
- **`ncl groups restart --id <group> --message "..."` used to be able to seed a runaway
  self-loop** on a group with `showTokenUsage` or `logSubagents` enabled — fixed 2026-07-26, but
  understand the mechanism before treating `--message` restarts as free. The `on_wake` row a
  `--message` restart writes is stamped `channel_type: 'agent'`, `platform_id: <own group id>`
  (the same shape as a legitimate internal agent-to-agent note). `poll-loop.ts`'s side-channel UI
  notices (subagent/token-usage/error) used to blindly reuse that routing context — so the
  turn's own notice got delivered right back into the *same session's* inbound queue as a fresh
  `channel_type: 'agent'` row, which the follow-up poller pushed into the still-open query as a
  new turn, whose notice repeated the cycle. Self-sustaining, no external trigger needed. Two
  such restarts on `main-agent` each independently burned several million tokens over ~7 minutes
  before tripping the account's monthly spend cap. **Do not attribute a cost spike to "restarting
  invalidates the prompt cache"** — that was the first (wrong) theory here, ruled out because the
  user restarts routinely without ever seeing this; the real cause was the routing bug above,
  now fixed in `poll-loop.ts` (`isAgentToAgentRoute()` guards all three notice functions) with
  regression tests. Plain `ncl groups restart` with no `--message` was never affected — it
  doesn't write that `on_wake` row at all.

## Matrix live E2E suite

`pnpm test:matrix-live` hits the real matrix.org homeserver via a throwaway account
(`MATRIX_TEST_*` in `.env`), with the live production bot as the peer. Deliberately excluded from
`pnpm test`. Run it for any Matrix channel change.

## Before ending the session

Any fork-local change needs a `FORK-CHANGELOG.md` entry (newest first, prose, no commit shas)
before the session ends — see `docs/fork-changelog.md` and the banner at the top of `CLAUDE.md`.
Write the entry as part of the work, before asking to commit.

If the change alters anything described in `groups/main-agent/nanoclaw-overview.md`
(channels, subagents, Nextcloud scope, open items), update that file too, in the same
session — see the Fork/Config Changelog sections in root `CLAUDE.md`. Easy to miss
because it's gitignored (hand-maintained, not part of any commit diff): it stayed
stale through the email-channel change until a live conversation surfaced the gap.
