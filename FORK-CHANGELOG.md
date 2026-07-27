# Fork Changelog

Changes in this fork ([scm2409/nanoclaw](https://github.com/scm2409/nanoclaw))
relative to upstream [nanocoai/nanoclaw](https://github.com/nanocoai/nanoclaw).
Every entry is **vibecoded** — written by Claude Code under human direction —
and names the model that wrote it.

Upstream's own release notes live in [CHANGELOG.md](CHANGELOG.md); this file
never touches them. See [docs/fork-changelog.md](docs/fork-changelog.md) for
the entry format and how this file is kept up to date.

---

## 2026-07-27 — Add deep-research container skill

New container skill `container/skills/deep-research/` orchestrates the existing `websearch` and
`smart` Task-tool subagents (see the 2026-07-26 entry below) into a multi-step research workflow:
decompose an explicitly-requested deep/thorough research question into bounded sub-questions,
dispatch them to `websearch` in parallel, cross-check for contradictions and gaps, and synthesize
a cited report — escalating to `smart` for synthesis without asking the user first, since the
explicit deep-research request is itself the standing approval for that (a scoped exception to
the group's normal "ask before using `smart`" rule, which still applies everywhere else). Triggers
only on explicit user requests ("recherchiere ausführlich", "compare X and Y in depth"); simple
lookups keep going straight to `websearch` as before. Shared/auto-mounted like the other container
skills, so any group with `websearch`/`smart` subagents defined can use it — no separate installer
skill, no host-side reach-in, no REMOVE.md (consistent with the other container skills, which have
none either: removing it is a plain file deletion).
vibecoded with Claude Sonnet 5

## 2026-07-26 — Track group capability config instead of gitignoring it

Upstream blanket-ignores `groups/*` as per-installation state. That is wrong for this fork: a
custom Task-tool subagent or a persona edit is a real capability addition, authored once and
nowhere else on disk, so ignoring it meant `websearch.md`, `smart.md`, and
`instructions.prepend.md` existed in no commit and would vanish on a fresh clone. Carved those
two paths out of the ignore rule (`groups/*/instructions.prepend.md`, `groups/*/.claude/agents/`)
via a generic pattern, so any future group gets the same treatment automatically.

Everything else under `groups/` stays ignored, for two distinct reasons: `conversations/` and
`memory/` are private user content (chat transcripts, personal notes) that must not reach a
public remote; `CLAUDE.md`, `container.json`, and `.claude-fragments/` are build artifacts
regenerated at every container spawn — `CLAUDE.md` literally carries a "Composed at spawn - do
not edit" header and holds nothing but `@`-imports, whose real sources (`container/CLAUDE.md`,
`container/agent-runner/src/mcp-tools/*.instructions.md`, `container/skills/*/instructions.md`,
and now `instructions.prepend.md`) are all tracked at their own locations. Committing them would
add dangling `/app/...` symlinks and content that the next spawn overwrites anyway.

Also worth recording from the same session: the `smart` subagent's `opus` alias resolves to
`claude-opus-4-8`, not Opus 5. Alias→model-id mapping is frozen inside the pinned
`@anthropic-ai/claude-agent-sdk@0.3.197` / `@anthropic-ai/claude-code@2.1.197` (`container/cli-tools.json`),
not resolved server-side, so pointing `opus` at a newer model requires bumping those pins.

**Do not bump those pins fork-locally to chase this** — that conclusion was considered and
rejected. The pins are upstream-owned (`91ebc9d`, by an upstream maintainer; upstream bumps them
periodically as `chore: bump claude-code to X and agent SDK to Y`), and as of 2026-07-27 upstream
pins exactly the same 2.1.197/0.3.197 we do. Bumping locally would mean diverging on a file
upstream actively maintains, re-deciding that divergence at every future update — for an effect
that arrives for free once upstream bumps and we take it via `/update-nanoclaw`. Hardcoding a
full model ID (`model: claude-opus-5`) in the subagent file works too — verified against the
pinned CLI, which passes full model IDs straight through, only the *alias table* is stale — but
it was rejected for the same maintenance reason: it needs manual updating for every future Opus,
whereas the alias self-maintains once the SDK moves. Decision: wait for the upstream bump.

vibecoded with Claude Opus 5

## 2026-07-26 — Fix a self-sustaining agent-to-agent notice loop, and a duplicate-error relay bug

Incident, corrected root cause (an earlier version of this entry blamed prompt-cache
invalidation from restarting a long resumed session — wrong; ruled out after the user pointed
out they restart routinely all weekend without ever seeing this, which is decisive evidence
against a generic restart-cost theory). The actual mechanism, confirmed from the session DB:
`ncl groups restart --message "..."` writes its `on_wake` row with `channel_type: 'agent'` and
`platform_id` set to the group's own id (`agent-route.ts`'s "self-messages are always allowed"
convention, meant for legitimate internal follow-ups). `poll-loop.ts`'s side-channel UI
notices (`deliverSubagentNotice`, `deliverTokenUsageNotice`, `deliverErrorResult`) blindly
reused that same routing context. Once the triggering message carried `channel_type: 'agent'`,
every notice generated in response was itself delivered as a fresh `channel_type: 'agent'` row
straight back into the *same session's* inbound queue — which the follow-up poller then pushed
into the still-open query as a new turn, whose own notice repeated the cycle. Self-sustaining,
no external trigger needed, and specific to `--message` restarts on a group with
`showTokenUsage`/`logSubagents` enabled — which is exactly why routine `ncl groups restart`
(no `--message`) never triggered it. Two such restarts on `main-agent` (the second only needed
because an edit had landed in the wrong file — see below) each independently seeded the loop,
running up several million tokens over about 7 minutes before tripping the account's monthly
spend cap.

Fixed in `container/agent-runner/src/poll-loop.ts`: added `isAgentToAgentRoute()` and guarded
all three notice functions with it — a side-channel notice is never delivered when the
triggering route's `channel_type` is `'agent'` (nothing is lost; there's no human watching an
agent-to-agent route anyway). Added three regression tests reproducing the loop's routing shape
(`AGENT_ROUTING`, mirroring a real a2a/on_wake inbound row) and asserting each notice type stays
silent on it.

Separately, and still worth keeping: once *any* terminal error genuinely repeats (e.g. the
SDK's own internal retry against an already-exhausted spend cap), the old code relayed every
identical repeat as a fresh duplicate message forever. `processQuery` now tracks the last
delivered error-result text and, on an immediate identical repeat, delivers nothing further,
calls `query.abort()`, and breaks out of the event loop instead of continuing to consume the
stuck stream. Regression test reproduces this too (a mock provider yielding 20 identical
`isError` results → asserts exactly one gets delivered).

vibecoded with Claude Sonnet 5

## 2026-07-26 — Document the persona file gotcha in `nanoclaw-coding`

During the same incident, the first restart was needed only because a persona edit had landed
in `groups/main-agent/.claude-fragments/persona.md` — a generated copy that
`composeGroupClaudeMd()` silently overwrites from `groups/main-agent/instructions.prepend.md`
on every container spawn — instead of the real source file, and reverted on the next spawn.
Added a "Group persona/instructions" section to `.claude/skills/nanoclaw-coding/SKILL.md`
documenting the correct file and the regeneration behavior, so this doesn't happen a third
time.

vibecoded with Claude Sonnet 5

## 2026-07-26 — `smart` escalation subagent for main-agent

Added `groups/main-agent/.claude/agents/smart.md`, a Task-tool subagent that runs on `opus` (vs.
the group's default `sonnet`) with no `tools:` restriction — it inherits the full tool set,
including `Task` itself (so it can call `websearch`) and the `ask_user_question` MCP tool (so it
isn't strictly one-shot). Added a matching section to
`groups/main-agent/instructions.prepend.md` (the actual persona source —
`.claude-fragments/persona.md` is a generated copy `composeGroupClaudeMd()` overwrites from it on
every container spawn, learned the hard way after a first edit landed in the wrong file and got
silently reverted by the next restart) instructing the main agent to always ask the
user before delegating to `smart` on genuinely complex tasks (architecture decisions, multi-file
debugging, ambiguous requirements) — never silently escalate — and to optionally let the user pick
a different model per call via the Task tool's per-invocation `model` override, rather than editing
the subagent file. Also enabled `log_subagents` on the group (`ncl groups config update --id
ag-1784455694582-5kfscx --log-subagents true`) so escalation is visible in-chat as a
"🔎 Subagent: smart (Modell: opus)" notice. Requested by the user, who wanted a stronger-model
fallback for hard tasks without permanently raising the main chat's default model.

vibecoded with Claude Sonnet 5

## 2026-07-26 — Document how to switch an agent group's model

Added a "Switching the Model an Agent Group Uses" section to `.claude/skills/customize/SKILL.md`,
covering the `ncl groups config update --id <group-id> --model sonnet` + `ncl groups restart`
flow, why short SDK aliases (`sonnet`/`opus`/`haiku`) are preferable to dated snapshot ids, and
the restart gotcha where `groups/<folder>/container.json` only re-materializes on the next actual
container spawn (not immediately at kill time) — verify via the DB instead. Prompted by walking
the user through pinning the Matrix-wired main chat's model to `sonnet` after confirming it had
no relation to the model running this Claude Code CLI session, and them asking to capture the
procedure for next time.

vibecoded with Claude Sonnet 5

## 2026-07-26 — `nanoclaw-coding` meta-skill for hands-on repo work

Added `.claude/skills/nanoclaw-coding/SKILL.md`, a project-level Claude Code skill (not a
NanoClaw product skill) that consolidates conventions this fork has had to re-teach across
sessions via auto-memory: ask before implementing or committing/pushing, never put secrets in a
shell argument, TDD (mandatory for the Matrix channel), follow an existing plumbing pattern
instead of inventing a new one (the `show_token_usage` toggle added earlier today is used as the
worked example), systemd unit resolution + host/container restart semantics, the Matrix live
E2E suite, and — the rule that had just been violated twice — always self-verify a change
end-to-end (including any required service/container restart) before telling the user it's ready
to test. Prompted by the user pointing out that relying on scattered auto-memory files wasn't
working reliably; an always-loadable skill is the more durable form for conventions specific to
editing this repo's own code. The source memory files are left in place as the detailed
historical record.

vibecoded with Claude Sonnet 5

## 2026-07-26 — Optional per-response token-usage summary notice

Added a second opt-in, off-by-default diagnostic notice alongside the existing
`log_subagents` one: `show_token_usage` (`ncl groups config update --show-token-usage true`).
When enabled, after each completed turn the agent's channel gets a side-channel
`📊 Tokens: ...` line summing input+output+cache tokens and USD cost per model used during
that turn (main model and any subagents invoked within it) — sourced from the Claude Agent
SDK's `modelUsage` field on the `result` message, which `claude.ts` previously discarded when
narrowing the message type. Built by copying the `log_subagents` plumbing pattern exactly: new
`show_token_usage` column (migration 021), threaded through `container-configs.ts`,
`container-config.ts`, the `ncl groups config update` CLI handler, the container runner's
`config.ts`/`index.ts`, and gated in `poll-loop.ts`'s `result`-event handling via a new
`deliverTokenUsageNotice` (mirrors `deliverSubagentNotice` — a direct `writeMessageOut`, never
`query.push()`, so it can't influence the agent's own context).

vibecoded with Claude Sonnet 5

## 2026-07-26 — `.claude/agents/*.md` subagent files were silently unusable

While verifying the subagent-logging feature below, the log stayed silent for every web-research
turn — the main agent kept using `curl` via Bash or the built-in `general-purpose` subagent
instead of the group's own `websearch` subagent, despite an explicit standing instruction to
always delegate. Traced it all the way down: the Claude Agent SDK / `claude` CLI does **not**
auto-discover `.claude/agents/*.md` files when run headlessly. Verified empirically against the
real `claude` binary (`2.1.197`) inside a running container — `claude -p ... --setting-sources
project,user,local` never lists a subagent defined only as a markdown file on disk as an available
`Task`-tool `subagent_type`, regardless of content, cwd, or frontmatter cleanliness. Passing the
exact same definition via the CLI's `--agents '{"name": {...}}'` flag (the SDK's programmatic
`Options.agents` field) registers it immediately. Auto-discovery of `.claude/agents/` appears to
be an interactive-TUI-only behavior — every subagent file this fork has ever shipped (starting
with `websearch.md`) was invisible to the Task tool from the day it was added.

Added `container/agent-runner/src/providers/file-subagents.ts`: reads `.claude/agents/*.md` from
the query's `cwd`, parses the YAML-ish frontmatter (`description`, `model`, `tools: [...]`) plus
body-as-prompt, and `claude.ts`'s `query()` now passes the result through `Options.agents` on
every call. Best-effort per file — one malformed agent file can't take down the others. No new
dependency: the frontmatter shape these files use (flat scalars + one bracketed array) doesn't
need a real YAML parser.

Verified end-to-end myself via the local CLI channel (`pnpm run chat`, wired to the same
production agent group) rather than asking for another live Matrix round-trip after several
failed fix attempts — restarted the group's container to pick up the fix, then watched a weather
question correctly trigger `🔎 Subagent: websearch (Modell: haiku)` and a properly sourced answer,
with no `curl` in sight. 9 new unit tests (`file-subagents.test.ts`), full host + container suites
green.

vibecoded with Claude Sonnet 5

---

## 2026-07-26 — Matrix self-heal was inventing a new room on ANY send failure, not just a dead one

Direct continuation of the DM-room-resolution fix below (itself a continuation of the 2026-07-25
incident) — same symptom kept recurring after each attempted fix: a reply landing in a fresh,
unencrypted room instead of the room the question arrived in. Two real, separate bugs, found by
reading `matrix-js-sdk@41.9.0`'s own source rather than guessing further:

1. `Room.getMyMembership()` is `this.selfMembership ?? KnownMembership.Leave` — it collapses "no
   membership state event applied to this room yet" into the exact same `'leave'` string as a
   genuine confirmed departure. `resolveThreadId`'s staleness check trusted that string outright.
   Fixed by checking `room.currentState.getStateEvents('m.room.member', botUserId)` directly for
   an actual state event before ever treating `'leave'`/`'ban'` as evidence — deterministic, no
   guessing, replaces an earlier same-day attempt that used a 60-second freshness window instead
   (correctly called out as arbitrary and replaced same session).
2. The real trigger of the incident this specific evening: `ensureEncryptorForRoom` has the exact
   same local-state-lag blind spot for `m.room.encryption`, so a send failed with "Cannot encrypt
   event in unconfigured room" for a room the bot had just decrypted a live inbound message from.
   `postMessage`'s catch-all then treated *that* local, self-inflicted failure as equally strong
   evidence as a real `M_FORBIDDEN` departure and called `openDM()` — which silently invents a
   brand-new unencrypted room on any cache-miss. Fixed both ends: `ensureEncryptorForRoom` now
   falls back to a live `client.getStateEvent()` homeserver fetch when the local cache is empty
   (same authoritative-source principle as fix 1), and the `openDM()` self-heal path now requires
   a *named* Matrix API error (`M_FORBIDDEN` / `M_NOT_FOUND` / "not a member") — anything else
   retries the same room once instead of ever abandoning it. Answering a question in a different
   room than it arrived in should never have been possible; now only unambiguous server-side proof
   of departure can cause it.

7 new/updated tests across `matrix-dm-resolution.test.ts` and `matrix-encryptors.test.ts`. Full
host suite green; the two poisoned `data/matrix-dm-rooms.json` entries this produced during
testing were corrected back to the operator's real room by hand.

vibecoded with Claude Sonnet 5

---

## 2026-07-26 — Optional live chat notice when a subagent runs

A prior session added a `websearch` subagent (`groups/main-agent/.claude/agents/websearch.md`,
model `haiku`) for the main agent to delegate web research to via the SDK's `Task` tool, but
there was no way to verify from the chat whether it was actually being used. Added an optional,
per-agent-group toggle (`log_subagents` on `container_configs`, set via `ncl groups config
update --log-subagents true`, default off) that makes the agent-runner deliver a short chat
notice (e.g. "🔎 Subagent: websearch (Modell: haiku)") the moment the SDK's `Task` tool starts a
subagent.

Detection: the Claude Agent SDK emits a `system`/`task_started` message with `subagent_type` set
for genuine Task-tool subagent invocations (shell/workflow/monitor tasks don't set it); the model
is resolved via the SDK's `Query.supportedAgents()`, called once per query and cached. The notice
is written straight to `messages_out` (the same side-channel `deliverErrorResult()` already used
for undelivered error turns) rather than pushed into the agent's own SDK stream, so it can never
enter the agent's context or influence its reasoning — purely a host-side observation on top of
the existing message flow.

Follows the model/effort/cli_scope pattern end to end: migration `020-log-subagents.ts`, new
`ContainerConfig`/`RunnerConfig` field, `--log-subagents` CLI flag, and a new `ProviderEvent`
('subagent') translated in `claude.ts`'s `translateEvents()`. Verified with `bun install` +
`bun test` in `container/agent-runner` (a local `bun` binary isn't preinstalled in this dev
environment, so it was fetched ad hoc for this session) alongside the full host `pnpm test` /
`pnpm run build`.

vibecoded with Claude Sonnet 5

---

## 2026-07-25 — Drop commit shas from the changelog convention entirely

While closing out the Matrix DM-resolution fix below, hit a real bug in the
changelog convention itself: after committing the fix, I tried to update its
`Commits:` line to name the commit's own sha, committed that, then had to
update the line again to also cover *that* commit, and so on — a commit's sha
is a hash of its own content, so a commit can never name its own final sha
inside itself. Chased this three times before catching it, then tried a
narrower fix (exempting changelog-only commits from the coverage check) —
still a workaround for a self-inflicted problem. Simplest fix: don't require
shas at all.

Entries now end with a plain `vibecoded with <model>` line — no `Commits:`
trailer, no sha-coverage check in `check-fork-changelog.mjs`. The heading's
date is enough provenance; `git log` is authoritative for anything more
specific. Updated `docs/fork-changelog.md` and stripped the now-removed
`Commits:` line from every existing entry below.

vibecoded with Claude Sonnet 5

## 2026-07-25 — Matrix DM room resolution: stop trusting openDM() as the fallback authority

Root-caused a recurring "reply lands in a new, unencrypted room after a reboot"
failure that survived two prior fixes (665f105, 18c0b49) — all three incidents
traced back to the same design flaw: `resolveThreadId` in `src/channels/matrix.ts`
treated `openDM()` as the fallback authority whenever its own single-slot
`userToRoomCache` went cold or stale, even though `openDM()` is the least
trustworthy source available (it silently invents a new, uninvited, unencrypted
room on any cache miss).

Four changes, each covered by a red-then-green unit test in
`matrix-dm-resolution.test.ts`:

- **Reverse-lookup before `openDM()`** (`findConfirmedRoomForUser`): when the
  single-slot pointer shows a confirmed departure, scan `roomToUserCache` —
  populated from every confirmed inbound event and never pruned — for another
  still-joined room for the same user before ever calling `openDM()`.
- **Tombstone follow-through** (`followTombstone`): a room upgrade
  (`m.room.tombstone`) isn't evidence of staleness, just that the room id moved;
  both the fast path and the reverse lookup now follow to `replacement_room`
  instead of discarding the mapping.
- **Self-heal on send failure**: a cached room can look locally joined and still
  be dead server-side. `adapter.postMessage` now catches a send failure,
  invalidates the cache entry, re-resolves via `openDM()` exactly once, and
  retries — the one case where deferring to `openDM()` is actually correct.
- **Persisted user→room store** (new `src/channels/matrix-dm-room-store.ts`,
  a flat JSON file under `DATA_DIR`, atomic write, mirrors the philosophy of
  `matrix-crypto-store.ts` without its IndexedDB machinery): closes the residual
  gap where a proactive/host-initiated send right after a restart — before any
  fresh inbound message re-warms the in-memory caches — had nothing to fall
  back on. `wrapWithDmResolution` seeds both in-memory caches from disk at wrap
  time and persists on every confirmed update.

Also fixed `matrix.live.test.ts`'s "reply lands in the room the user wrote from"
test, which restarts the real host mid-test to get a cold cache: it resolved
the systemd unit via `systemctl --user list-unit-files | grep -i nanoclaw | head
-1`, ambiguous on any machine that also runs `claude-rc-nanoclaw.service` (this
Claude Code session's own remote-control server). It grabbed that unit instead,
silently restarting the wrong service while the actual host ran on untouched —
the test then just timed out waiting for a log line that could never appear.
Now resolves via `getSystemdUnit()` (`src/install-slug.ts`), the same
install-slug-scoped function the setup wizard uses to create the unit, and
verifies it's active before restarting it. Confirmed the real host
(`nanoclaw-v2-e1d62e67.service`) was never touched by the earlier failure, then
re-ran the fixed test against it for real — passed in 41s.

vibecoded with Claude Sonnet 5

## 2026-07-25 — Fork changelog + vibecoded disclosure

Made this file structurally hard to skip, plus surfaced that this repo is vibecoded. A
`SessionStart` hook records each work item's baseline (a hash of this file, the model in
use); a `PostToolUse` hook records which repo files Claude actually writes; a `Stop` hook
(`.claude/hooks/check-fork-changelog.mjs`, wired in `.claude/settings.json`) blocks the turn
from ending if the session wrote a fork file but this file's content hasn't changed since.
The gate is satisfiable by editing this file alone; it never asks Claude to commit and never
inspects git history. Also added the README callout disclosing the fork is vibecoded, and
`docs/fork-changelog.md` documenting the convention.

vibecoded with Claude Opus 5

## 2026-07-25 — Voice-note speech-to-text

Inbound voice notes are transcribed on the host before the message reaches the
agent, so the agent reads text instead of being handed an opaque attachment.
Channel-independent by design: `src/attachment-transcription.ts` is driven from
the `router.ts` inbound path via `extractAndTranscribeAttachments`
(`src/session-manager.ts`) and fires for any attachment a channel adapter flags
`isVoice` through the `isVoiceAttachment` hook in `chat-sdk-bridge.ts`. Matrix is
the first consumer, not the owner — any Chat SDK channel picks this up by
flagging its voice attachments.

Transcription goes through OpenRouter's chat-completions endpoint with an
`input_audio` content part (default `google/gemini-2.5-flash`) rather than
`/audio/transcriptions`, which 404s under this account's provider privacy
policy. It never throws: a missing key, network failure, or non-200 degrades to
the plain attachment hint rather than dropping the message. Override the model
with `OPENROUTER_TRANSCRIPTION_MODEL`.

vibecoded with Claude Sonnet 5

## 2026-07-25 — Matrix channel

Added Matrix as a channel (`src/channels/matrix.ts`) with working E2EE, plus the
Node/E2EE compatibility fixes it needed, and a live homeserver test suite
(`pnpm test:matrix-live`). Subsequent fixes: a DM-routing race and a startup
retry gap; encrypted-media fetch and agent trust for voice notes; permanent
delivery failure after a snapshot-restored restart; and replies landing in the
wrong room when `openDM` resolved slowly.

vibecoded with Claude Sonnet 5 and Claude Fable 5

