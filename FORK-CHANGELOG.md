# Fork Changelog

Changes in this fork ([scm2409/nanoclaw](https://github.com/scm2409/nanoclaw))
relative to upstream [nanocoai/nanoclaw](https://github.com/nanocoai/nanoclaw).
Every entry is **vibecoded** — written by Claude Code under human direction —
and names the model that wrote it.

Upstream's own release notes live in [CHANGELOG.md](CHANGELOG.md); this file
never touches them. See [docs/fork-changelog.md](docs/fork-changelog.md) for
the entry format and how this file is kept up to date.

---

## 2026-08-02 — calendar invitations by mail, and the two adapter changes that make them arrive as invitations

The agent has a Nextcloud calendar of its own but no write access to the operator's, so
"make me an appointment" had no path at all. It now has one that keeps the human in the
loop by construction: it mails a real iMIP invitation, and *accepting* it in the mail
client is what creates the event. Nothing lands in a calendar without a deliberate act.

The new container skill `calendar-invite` is a `SKILL.md` plus `make-ics.ts` — the first
container skill in this fork that ships executable code rather than only instructions.
The script is single-file and stdlib-only (`node:` imports, no `Bun.*`), so the same file
runs under Bun in the read-only skill mount and under Node in the host test suite; no
image rebuild, no dependency, nothing written next to itself. The generated `.ics` goes
to `/tmp`, not the workspace: it only has to live until `send_file` copies it into the
outbox, and a persistent location would collect one dead file per appointment forever.
Only the organizer address, which must survive, is written to the workspace. It exists because the
properties that decide whether a client accepts an `.ics` at all — CRLF endings, 75-octet
line folding on character boundaries, TEXT escaping, an exclusive `DTEND` for all-day
events, wall-clock times converted through the right DST offset — are invisible in
anything a reviewer can read back. A hand-written invitation looks correct and silently
fails to import; there was already one in the workspace from an earlier improvised
attempt. Scope is deliberately just creation: updating and cancelling would need a UID
journal, and recurrence needs `TZID` plus a `VTIMEZONE` block, since `RRULE` over UTC
stamps drifts by an hour past a daylight-saving change. Reminders are supported
(`--reminder 15m`, `1d`, repeatable) as `VALARM` blocks, with the caveat written into the
skill: they are a request, since a receiving client may substitute its own defaults on
accept — but an invitation carrying no alarm can never produce one, so the block still
has to be correct.

Two things on the email path had to change for the file to arrive as an invitation rather
than as a download.

First, the attachment's Content-Type. An invitation and a calendar export share both the
extension and the media type; only the `METHOD` property separates them, and clients read
it from the Content-Type parameter, not from the body. Rather than thread a new field
through the container-to-host protocol just to say "this one is an invitation",
`checkOutboundAttachments` now reads it out of the file — for `text/calendar` it scans the
first 2 KB for a `METHOD:` line and emits `text/calendar; charset=UTF-8; method=REQUEST`.
A calendar without one is untouched.

Second, the subject. It was always host-generated (`Message from <name>`, or `Re: <last
subject>` when a thread ref existed), which for an invitation meant a generic subject
*and* `In-Reply-To` pointing at whatever unrelated mail the correspondent last sent —
filed into the wrong conversation and unfindable later. `send_message` and `send_file`
now take an optional `subject`, carried in the content JSON that channels without
subjects already ignore. The rule at the adapter is that setting a subject means starting
a topic: the subject is used verbatim and the reply headers are dropped. Omitting it
leaves the previous behaviour exactly as it was.

Verified end to end, not just in unit tests: the GreenMail live suite gained a case
asserting the `method=REQUEST` parameter and the verbatim subject survive a real SMTP/IMAP
round trip, and a real invitation was sent through the running install and inspected on
the wire. `vitest.config.ts` grew a `container/skills/**/*.test.ts` glob so a script
shipped with a container skill is covered by `pnpm test` at all.

vibecoded with Claude Opus 5

## 2026-08-02 — duplicate replies: a final-text block that only echoes a tool send is dropped

Matrix answers started arriving twice. The cause was not Matrix, not the network and
not a send retry — the duplicate already existed in `outbound.db` before any channel
adapter saw it. The agent delivered the same text twice: once via the `send_message`
MCP tool mid-turn, then again as a `<message to="…">` block in its final response,
which `dispatchResultText` dutifully delivered as a second message. The token-usage
notice appearing between the two copies was the tell: in the result handler
`deliverTokenUsageNotice` runs before `dispatchResultText`, so the order is always
tool send, notice, echo.

The transcript for the two reported incidents (17:59 and 19:35) shows the tool call
and the final block carrying byte-identical text, 435 and 370 characters. The class
was already known — `dispatchResultText` names it "the double-delivery class" in a
comment — but the guard beneath that comment only applies to task runs, so ordinary
chat sessions had none. It had also been hit before, in `ca52d2c6`
("stop emitting the greeting twice"), and was addressed there only by rewording the
instructions; prose does not reliably constrain the model, so it came back.

New `turn-sends.ts` marks where `outbound.db` stood when a turn began and collects
what was delivered since. `dispatchResultText` snapshots that once per final dispatch
and drops a block whose destination and text repeat one of those sends. Matching is
exact after whitespace normalization — both incidents repeated the text verbatim, so
nothing looser is warranted, and anything looser could swallow a real follow-up. The
"quick acknowledgment, then the actual answer" pattern is untouched: only a verbatim
repeat is suppressed, and only against sends that predate the dispatch, so two
identical blocks in one response both still deliver.

Suppression reads the session DB rather than an in-process registry, and that is the
whole point rather than an implementation detail: the MCP tools run as a separate
`bun run mcp-tools/index.ts` subprocess, so anything the tool records in module state
is invisible to the poll loop. A first attempt did use a shared `Set`; its unit tests
passed because `bun test` runs everything in one process, and it then failed on the
first live message. The shared session DB is the only channel between the two, the
same way it is between host and container. A regression test now writes the row
directly, standing in for that subprocess.

A suppressed echo also counts as delivered for the re-wrap nudge. Without that, a
result consisting only of the echo would look like nothing was sent, and the nudge
would ask the agent to send its response again — recreating the duplicate by another
route.

Verified end to end, not just in tests: the same forced double-send that produced two
rows before the fix produces one after, and a tool send followed by a genuinely
different final block still produces two.

vibecoded with Claude Opus 5

## 2026-08-02 — overview-doc update rule surfaced in the coding skill, doc gap closed

KaiL01 had kept an old Nextcloud Deck card open researching mail providers with a
*native* two-way address allowlist, unaware that the email channel added 2026-08-01
enforces that allowlist inside NanoClaw itself — so no provider capability is
required and the research question was already moot. Traced this to two doc gaps:
`groups/main-agent/nanoclaw-overview.md` never said outright that Nextcloud has no
mail app or that the allowlist is host-enforced (both added now), and the instruction
to keep that file in sync with capability changes lived only in root `CLAUDE.md`'s
Fork/Config Changelog sections — not in `.claude/skills/nanoclaw-coding/SKILL.md`,
the skill actually loaded before coding sessions on this repo, which is why it was
missed for the email-channel change. Added a bullet there pointing back at the same
rule.

vibecoded with Claude Sonnet 5

## 2026-08-01 — KaiL01 self-description doc shared between Claude Code and the agent

Added `groups/main-agent/nanoclaw-overview.md`: a plain doc describing what
KaiL01 is and does (Matrix + voice transcription, the
`websearch`/`smart` subagents, the Nextcloud MCP tool's calendar/Deck/webdav
scope, and the still-open items — Deck auto-reminders, DokuWiki access,
email drafting). Prompted by the user having written an equivalent brief by
hand on a Nextcloud Deck card and wanting one description both sides of the
collaboration — Claude Code sessions on this repo, and the agent itself —
can read, instead of two copies drifting apart. Verified against the actual
repo/DB state first (container.json, CONFIG-CHANGELOG.md, the group's own
`.claude/agents/` files) rather than restating the card's claims verbatim.

The file lives at the group's workspace root (not under `memory/`, not
OKF-formatted) so it's plain content KaiL01 reads when relevant, not an
active memory entity with its own indexing discipline. It names real
host/domain specifics (the homelab hostname, the Nextcloud domain), so
unlike `instructions.prepend.md`/`.claude/agents/` it stays out of git —
same reasoning and same mechanism as `CONFIG-CHANGELOG.md`: this is a public
repo, and `groups/*/*` is gitignored by default already, so no `.gitignore`
change was needed, just leaving it alone rather than adding a `!` allowlist
entry for it.

The actually regenerated-at-spawn fragment tree (`.claude-fragments/`) was
*not* the right place to point the agent at this file — an initial edit
there was silently wiped by `composeGroupClaudeMd()` on the next container
spawn, since that directory is fully derived from `instructions.prepend.md`
and DB state, not a place for hand edits. Fixed by adding the pointer to
`groups/main-agent/instructions.prepend.md` instead (the real source
`.claude-fragments/persona.md` is compiled from), then verifying with
`ncl groups restart` + `pnpm run chat` that the regenerated fragment picked
it up.

By design, KaiL01 only reads the file and never edits it — every capability
change to date came from a Claude Code session, not the agent itself (per
`CONFIG-CHANGELOG.md`), and giving both sides write access to the same file
risked drift/races for no benefit. Root `CLAUDE.md`'s Fork Changelog and
Config Changelog sections each got one added sentence: if a change touches
what this file describes, update it in the same session — convention only,
matching how `CONFIG-CHANGELOG.md` itself is kept (no new `Stop` hook, since
"is this change relevant to the doc" isn't mechanically diffable the way
"was a fork-local file written" is).

vibecoded with Claude Sonnet 5

## 2026-08-02 — container tests could leak a running poll loop into other test files

`bun test` runs every test file in a single process, and the container's session
DBs are module-level in-memory singletons (`db/connection.ts`). State is therefore
shared across files, and a poll loop that outlives the test which started it keeps
polling that shared database — quietly eating pending messages belonging to later
tests, in other files.

Both places that start a loop leaked one:

- `integration.test.ts` raced `runPollLoop` against an abort listener and a timeout,
  and awaited *that race*. The race settles the instant `abort()` is called while the
  loop itself is still mid-turn, so the test returned with the loop still running.
- `upload-trace.test.ts` never passed the signal to `runPollLoop` at all, so nothing
  short of process exit could stop its loop.

And the signal did not actually work anyway: `runPollLoop` only checked it between
poll iterations, while a provider stream can stay open indefinitely — so the one
mechanism documented as existing "so an abandoned loop actually exits" did not exit.
The signal is now also wired to `query.abort()` for the in-flight turn, the same
mechanism the pending-slash-command path already used. Production is unaffected: no
signal is passed there.

The symptom was a test in a *different* file (`task-run turn wiring`) timing out
because its message had been consumed, appearing and disappearing with file execution
order. It surfaced while working on the email channel and looked like a regression
from it; it is not, and reproduces on the previous commit once the file order flips.
Chasing it needed four bisections — worth recording, because the natural conclusion
("must be the change in the tree") was wrong twice.

New `src/testing/poll-loop-harness.ts`: `startPollLoop` always passes the signal, and
`stopPollLoop` aborts and then WAITS for the loop to genuinely finish, throwing if it
does not. A leak now fails the test that caused it, in the file that caused it,
instead of a stranger three files later.

vibecoded with Claude Opus 5

## 2026-08-02 — diagnostic notices are no longer delivered on every channel

The token-usage ("📊 Tokens: …") and subagent ("🔎 Subagent: …") lines the container
writes when `show_token_usage` / `log_subagents` are on were plain `kind: 'chat'` rows,
delivered wherever the turn was routed. On a chat channel that is one extra line and
nobody minds. On the new email channel it was one extra *mail per turn* — in practice
three mails arrived where one was expected.

The noise is the visible half. The real problem is that a notice goes to whoever the
turn was addressed to, so a mail to a correspondent who is not the operator would have
carried this install's model choice and USD cost. That is a disclosure, which is why
the fix is a property of the channel rather than a setting someone could get wrong:
`ChannelAdapter.deliversNotices` (absent = true, so every existing channel is
unchanged), resolved by `channelDeliversNotices()` in the registry with the same
live-adapter-then-registration order as the channel defaults. The email adapter
declares `false`.

The container now writes those two side-channel rows as `kind: 'notice'` instead of
`'chat'`, and `src/delivery.ts` drops notice rows for channels that don't carry them —
returning rather than throwing, so the row is marked delivered instead of being
retried into a permanent failure. Ordinary chat on the same channel is untouched.

Tests: `src/delivery-notices.test.ts` for the host half (including that a suppressed
notice is marked delivered, and that real messages still go out on the same channel),
plus `kind` assertions on the two existing container notice tests so a revert to
`'chat'` cannot pass silently.

vibecoded with Claude Opus 5

## 2026-08-01 — email channel with a per-address allowlist in both directions

Added a native email channel (`src/channels/email.ts`, IMAP in via `imapflow`, SMTP
out via `nodemailer`, MIME decoding via `mailparser`) so an agent group can
correspond by mail with a fixed, explicitly wired set of people — and with nobody
else. The requirement was "this mailbox may only talk to these addresses" with
enforcement local to NanoClaw, because the mail provider can't express it.

Modelled as a **channel rather than an MCP tool** because the allowlist machinery
already exists on the channel path and only there: inbound is
`unknown_sender_policy='strict'` plus the `agent_group_members` row that
`canAccessAgentGroup` checks, outbound is the `agent_destinations` row that
`src/delivery.ts` re-validates against the central DB and throws on. A mail MCP
server would have needed a second, parallel access-control system — and would have
had to hold the mailbox password inside the container. Here the credentials stay in
the host process (IMAP/SMTP aren't HTTP, so the OneCLI gateway can't inject them
anyway) and the agent never has mailbox access at all. The existing email-adjacent
skills didn't fit: `add-resend` is webhook-only and needs a verified domain,
`add-deltachat` requires the correspondent to run DeltaChat and complete a QR
SecureJoin, `add-gmail-tool` is explicitly tool-only with no inbound channel.

`src/channels/email-allowlist.ts` reads that wiring as the allowlist — no new table,
no migration, no second source of truth — and both directions fail closed, including
when the agent-to-agent module is absent (deliberately unlike `delivery.ts`, which
fails open there: for mail, "no destinations table" must not mean "may write to
anyone"). `scripts/email-allow.ts add|remove|list` creates or removes all four rows
in one idempotent step and projects destinations into live sessions, so allowing a
new recipient takes effect without waiting for a container wake.

Attachments work in both directions with hard limits (`src/channels/email-limits.ts`,
10 MiB per file / 20 MiB total / 10 files outbound, env-overridable, junk values
falling back to the default rather than disabling the limit). The asymmetry is
deliberate: an outbound breach throws before anything reaches SMTP so the whole
message fails, because a mail whose attachment was silently dropped is invisible to
the recipient; an inbound breach skips the part and leaves an
`[attachment omitted: …]` note in the text so the sender's words still arrive.

Other behaviour worth naming: a first scan records the mailbox's current end position
and processes nothing, so a fresh install doesn't answer years of archived mail; the
UID watermark rather than `\Seen` drives selection, so a human reading the mailbox in
a normal client can't make the agent skip messages; autoresponder mail is dropped
*before* the allowlist check, because the mail-loop risk comes precisely from an
allowed correspondent's own out-of-office reply; and every send goes to exactly one
recipient with no CC or BCC, so the agent cannot smuggle extra recipients into a mail.

Also added `.claude/skills/add-email/SKILL.md` (setup, allowlist management,
verification) and `container/skills/email-formatting/SKILL.md`, which tells the agent
the attachment numbers so it checks file sizes before attaching instead of
discovering the limit by failing a send.

**Live suite.** `pnpm test:email-live` (`src/channels/email.live.test.ts`, excluded
from `pnpm test` like the Matrix live suite) runs the full round trip against a real
local mail server — GreenMail in Docker, started by `scripts/greenmail.sh up`. It
injects mail over SMTP, lets the adapter read it over IMAP, and reads the adapter's
replies back out of the recipient's own IMAP mailbox, covering both allowlist
directions, attachments both ways, both size refusals, and the loop guard in ~9s
without a real mailbox or a single real recipient. A mail-testing SaaS was considered
and rejected: Mailtrap's sandbox cannot be read over IMAP at all, so it can only
exercise the outbound half — and the inbound half is where the allowlist lives.

That suite immediately paid for itself by finding two bugs no unit test could have,
both since fixed: (1) the scan issued the `\Seen` store while the FETCH generator was
still open, which killed the connection after the very first message; the scan now
drains the fetch into a bounded batch (25 messages, re-queueing) before touching the
connection again. (2) There was no reconnect at all — one dropped socket left the
adapter logging `Connection not available` once per poll forever, receiving nothing,
while `isConnected()` still reported healthy. For a channel that runs for months
against servers that time out IDLE sessions and restart, that is a when, not an if.
Reconnect now backs off 2s→60s, and resets the backoff only after a connection has
held for 60s, so a server that accepts the socket and drops it immediately is not
retried every 2s forever. `src/channels/email-reconnect.test.ts` pins that behaviour
with a fake client, since the live suite never severs the connection itself.

The provisioning logic moved to `src/channels/email-provisioning.ts` with
`scripts/email-allow.ts` as a thin CLI over it — the live suite needs it, and `src/`
importing from `scripts/` breaks the build's `rootDir`.

**Directions are separate permissions** (`--direction in|out|both`, default `both`).
The first cut could only open both halves at once, which cannot express the setup it
was built for: several people may write to the agent, while the agent answers to one
address only. Inbound is the `agent_group_members` row, outbound the
`agent_destinations` row, so the two were always independently expressible — only the
provisioning tool conflated them. `add` is declarative rather than additive: re-running
with a narrower direction closes the other half, because on this surface a wrong entry
must be fixable in place rather than needing a remove/re-add cycle.

vibecoded with Claude Opus 5

## 2026-08-01 — nextcloud-deck-workflow container skill

Added `container/skills/nextcloud-deck-workflow/SKILL.md` — generic conventions for
any agent working Nextcloud Deck cards via the `add-nextcloud-tool` MCP integration:
a recommended To do → Doing → Review → Done stack layout where "Review" is a pure
automation gate (never touch a card sitting there, on any trigger, until the user
releases it — prevents a scheduled/manual re-run from re-working a card before the
user has seen the result), a default to comment your result on any card you touch,
and chat-notification defaults (notify on Done, notify on gating to Review, ask
directly if stuck, respect a per-task do-not-disturb). Lands in every agent
container that runs `skills: 'all'` (the common case) but only matters to groups
that actually have the Nextcloud Deck tool wired — same situation as any other
generic container skill. Kept deliberately free of board names or group-specific
facts so it's fine as a tracked, public file; a specific recurring task's own
`--prompt` (DB-only, see `CONFIG-CHANGELOG.md`) references it by name instead of
repeating its rules.

vibecoded with Claude Sonnet 5

## 2026-07-31 — Config changelog convention (local, gitignored file)

`CLAUDE.md` and `docs/config-changelog.md` document a local convention for
logging DB-only `ncl` changes (agent groups, wirings, roles, scheduled tasks,
container config) that never show up in `git log`. The log file itself,
`CONFIG-CHANGELOG.md`, is gitignored — it can carry operational specifics
(what a group's tasks do, what boards/channels are wired) that shouldn't sit
in a public repo. Only the convention (this doc + the pointer) is tracked;
its content stays local per install.

vibecoded with Claude Sonnet 5

## 2026-07-31 — Nextcloud (calendar + Deck) as an MCP tool

New skill `.claude/skills/add-nextcloud-tool/` wires the upstream Python server
`nextcloud-mcp-server` into an agent group so the agent can read and write CalDAV
calendar entries and Deck cards. It is the sibling of `/add-gcal-tool`, but with HTTP
Basic instead of an OAuth bearer: the app password lives only in the OneCLI vault as
`base64(user:app-password)` behind an `Authorization: Basic {value}` header template, and
the group's MCP config carries the literal placeholder `onecli-managed` as its password —
so no usable credential is stored in `data/v2.db`, in `container.json`, or inside the
container.

This is the first Python CLI in the agent image. `container/cli-tools.json` only covers
pnpm globals, so `container/Dockerfile` gained a small `uv` block instead: the pinned uv
image is pulled in as a stage (`COPY --from=` refuses to expand a build arg inside an
image reference) and `uv tool install` places a self-contained interpreter plus the server
under `/opt/uv`, redirected out of uv's default `~/.local/share/uv` because the container
runs as the non-root `node` user. PyPI sits outside pnpm's `minimumReleaseAge` gate, so
both versions were picked by hand from releases at least a week old rather than from the
newest tag. `src/nextcloud-dockerfile.test.ts` guards that block structurally — the server
is a stdio process, never an imported module, so nothing else in the tree would notice its
removal.

The server registers 110+ tools across a dozen Nextcloud apps; the wiring enables only
`calendar` and `deck` via `--enable-app`, because every registered tool costs system-prompt
tokens on every single turn.

Two things had to be worked around before it ran end to end, both worth knowing for the
next Python MCP server. First, TLS trust: the gateway MITMs the connection, so its CA has
to be trusted, and the server's own `NEXTCLOUD_CA_BUNDLE` knob is the wrong lever — it
turns the bundle into an `ssl.SSLContext`, which the caldav/niquests stack rejects, so
every calendar call fails with `CERTIFICATE_VERIFY_FAILED`. Passing the same bundle as a
path via `SSL_CERT_FILE` and `REQUESTS_CA_BUNDLE` works. Second, and less obvious: the
server hands httpx a transport it constructed itself, and httpx only resolves `HTTPS_PROXY`
when it builds the transport — an explicit one routes directly. Those calls skipped the
gateway entirely and reached Nextcloud holding the placeholder password, which showed up as
Deck returning 401 while calendars worked and while `curl` in the same container got 200.
`container/httpx-env-proxy-shim.py`, installed into the venv as `sitecustomize.py`, restores
the env-proxy default for explicitly-built transports; it is generic and would fix any
Python MCP server with the same shape.

vibecoded with Claude Opus 5

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

