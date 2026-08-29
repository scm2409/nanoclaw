# Fork Changelog

Changes in this fork ([scm2409/nanoclaw](https://github.com/scm2409/nanoclaw))
relative to upstream [nanocoai/nanoclaw](https://github.com/nanocoai/nanoclaw).
Every entry is **vibecoded** — written by Claude Code under human direction —
and names the model that wrote it.

Upstream's own release notes live in [CHANGELOG.md](CHANGELOG.md); this file
never touches them. See [docs/fork-changelog.md](docs/fork-changelog.md) for
the entry format and how this file is kept up to date.

---

## 2026-08-29 — Preserve assistant text after empty SDK results

Fixed the Claude provider's handling of successful SDK result messages whose `result` field is empty even though an earlier assistant message contains the final text. This occurs with some OpenRouter reasoning output orderings and previously caused NanoClaw to log `Result: (empty)` and silently drop the reply. The provider now falls back to the last non-empty assistant text, with regression coverage for both fallback and genuinely textless results. Live verification confirmed a `coder` calculation reached `messages_out` after the fix.
vibecoded with openai/gpt-5.6-luna-pro

## 2026-08-29 — Add generic coding subagent skill

Added `.claude/skills/add-coding-subagent`, which installs a reusable `coder` file subagent for locally verifiable calculations, executable scripts, tests, and focused workspace coding. The bundled definition uses OpenRouter model `z-ai/glm-5.3-flash`, confines work to explicitly authorized paths, defaults to read-only, and requires `edit: allowed` for explicit coding edits; once that flag is present, it edits without another confirmation. It enforces a one-week dependency release-age gate, allowing only configured `uv`, `pnpm`, Yarn, or Bun workflows and rejecting unconfigured or bypassed package managers. It distinguishes ephemeral, shared, and persistent project workspaces and forbids unrequested external side effects. It relies on NanoClaw's existing file-subagent loader and persistent group workspace, so no host-code or database changes are needed.
vibecoded with openai/gpt-5.6-luna-pro

## 2026-08-29 — Add standalone OpenRouter Claude Code launcher

Added `claude_openrouter.sh`, a repository-local launcher for Claude Code that sets the OpenRouter-compatible Anthropic endpoint and requested model aliases, then runs Claude through OneCLI so the vault-managed credential and gateway proxy handle authentication. The launcher never contains an OpenRouter key.
vibecoded with openai/gpt-5.6-luna-pro

## 2026-08-29 — Route Claude Code harness through OpenRouter

Kept NanoClaw's Claude Code / Claude Agent SDK provider while routing its Anthropic-compatible requests through OpenRouter. The existing OneCLI placeholder-token path remains unchanged; the OpenRouter credential is intended to live in a separate OneCLI vault secret and is never stored in `.env` or container configuration. Added the reusable `configure-openrouter-claude-code` Claude Code skill for repeating endpoint, OneCLI, model, effort, restart, and verification setup. Configured the active groups for `google/gemini-3.7-flash` at `max` effort, changed regular file subagents to that model, and gave the `smart` subagent `openai/gpt-5.6-sol` at `high` effort. Extended file-subagent frontmatter parsing to pass per-agent effort through the existing Claude SDK path.
vibecoded with openai/gpt-5.6-luna-pro

## 2026-08-21 — Nextcloud Deck: fix instruction conflict causing missed stack moves

The `nextcloud` subagent's own instructions contradicted each other: "Vorgehen"
said to follow the deck-workflow skill's stack conventions even when the
delegation order didn't repeat them, but "Grenzen" separately forbade moving
any card not named in the order — read literally, that blocked the very moves
the workflow skill calls for on the card actually being worked. In practice
this meant cards sometimes stayed in Doing after producing something to review,
or stayed in Review/Done after a new open item was added to them. Reworded the
Grenzen bullet so it's explicit: other, unrelated cards are off limits, but the
card the order is actually working on follows the workflow skill's stack rules
regardless. Also added an explicit reopening rule to the `nextcloud-deck-workflow`
skill itself — a card in Review or Done with a fresh unresolved item attached
moves back to Doing as part of the same action, since the skill previously had
no rule at all for that case.
vibecoded with Claude Sonnet 5

## 2026-08-21 — DokuWiki: link every newly created page from an existing page

New wiki pages were reachable only by direct URL or search until a human
happened to link them in — easy to leave orphaned. The `dokuwiki` subagent
now treats linking a fresh page from a fitting existing page (namespace
overview, related topic page) as a default step of page creation itself,
not an extra the caller has to remember to ask for; it reports explicitly if
no fitting target exists rather than skipping silently. KaiL01's delegation
instructions in `instructions.prepend.md` were updated to still ask for it
explicitly in every create-page order, as a backstop. `/add-dokuwiki-tool`
updated so future installs generate the same behavior.
vibecoded with Claude Sonnet 5

## 2026-08-20 — Auto-resume after Anthropic usage-limit rejection

Martin reported that when KaiL hits Anthropic's usage limit (the SDK's
`rate_limit_event` rejection), it drops one apologetic error message and
just stops — nothing brought it back once the limit reset, so he had to
notice and re-message it manually. Wired the pieces that already existed
(rate-limit classification, the `processAfter`/due-message wake host-sweep
already uses for scheduled tasks, and the container→host system-action
bridge) into an actual auto-resume path.

Container side (`container/agent-runner/src/providers/claude.ts`,
`providers/types.ts`, `poll-loop.ts`): `classifyRateLimitEvent()`'s
`resetsAt` now travels as structured data on the `ProviderEvent`, not just
folded into a message string. When a turn ends in a `rate_limit` rejection
(never `quota`/out-of-credits — waiting doesn't fix an empty balance) with a
known `resetsAt`, and the triggering message's own retry count is under a
cap of 3, poll-loop now writes a `schedule_usage_limit_retry` system action
alongside the existing error notice, and tells the user it will resume
automatically.

Host side (new `src/modules/usage-limit-retry.ts`, wired into
`src/modules/index.ts`): a plain, unguarded delivery-action handler — no
privileged side effect, it only re-wakes the session that asked for it —
turns that system action into a `writeSessionMessage`-style inbound row with
`process_after` set ~60s past the reported reset time. No kill/respawn
needed; the same container just gets woken again once due, via host-sweep's
existing due-message path, and the SDK's own conversation continuation
means the model picks the conversation back up rather than starting fresh.

vibecoded with Claude Sonnet 5

---

## 2026-08-14 — Mealie MCP server, subagent-only, restricted mode

Wired Martin's fork of `mcp-mealie` (`github.com/scm2409/mcp-mealie`) into
KaiL01, in the same subagent-only shape as Nextcloud and DokuWiki: the main
agent never holds the Mealie tools, a dedicated `mealie` subagent does, and
the real API token never enters the container — the OneCLI gateway rewrites
the `Authorization` header at request time.

**Restricted mode.** Upstream `mgummich/mcp-mealie` has no access-restriction
mechanism at all; Martin's fork adds `MEALIE_RESTRICTED_MODE`, which filters
the tool list at MCP registration time rather than rejecting calls at
runtime — a blocked tool never appears in `tools/list`, so the subagent can't
even attempt it. Under restricted mode: reads, `create_recipe`,
`add_recipe_note` (append-only), `import_recipe_from_url`, and the full meal
plan survive; `update_recipe`, `delete_recipe`, `set_recipe_image`,
`upload_recipe_image`, `bulk_tag_recipes`, and all cookbook/taxonomy
mutation do not.

**Deliberate caveat, accepted as-is.** The fork's meal-plan tool module
accepts a `restricted` flag but never reads it — restricted mode therefore
grants *full* meal-plan write access, including `delete_meal_plan_entry`.
Not a bug to route around; the meal plan just isn't part of what this flag
protects.

**No shopping-list tools exist in this server**, restricted mode or not —
absent upstream, not something the flag is hiding. Noted in the subagent
file so it doesn't hunt for a capability that was never there.

**Unpinned-fork risk, closed with a build-time test.** Restricted mode
lives on an unreleased commit (`80e9166`) — the fork has no git tag and
`__version__` is still `0.3.1`. Following the fork's own README verbatim
(`@v0.3.1`) would silently install a ref *without* restricted mode. The
Dockerfile pins `ARG MEALIE_MCP_REF=80e9166` (a commit SHA, not a branch),
and `src/mealie-mcp-pin.test.ts` fails the build if that ARG is ever changed
to `main`/`master`/`HEAD` or anything that isn't a SHA or version tag —
otherwise a routine rebuild could silently pick up whatever `main` becomes.

**No httpx proxy shim needed, unlike Nextcloud.** `nextcloud-mcp-server`
needed a hand-rolled `sitecustomize.py` shim because its Deck client builds
an explicit `httpx.AsyncHTTPTransport` that bypasses `HTTPS_PROXY`
resolution, silently skipping the OneCLI gateway. `mcp-mealie`'s client
lets `httpx.AsyncClient` build its own transport with no explicit
`transport=` argument, so httpx reads `HTTPS_PROXY` itself — the exact
condition the shim exists to work around doesn't apply here. Flagged as an
open risk instead: whether the resolved httpx version honors
`SSL_CERT_FILE` for `verify=True` against the gateway's MITM cert is
unverified pending network access to the instance; if it doesn't, pin httpx
explicitly rather than reaching for `MEALIE_VERIFY_SSL=false`, which would
disable verification for every request instead of just trusting one CA.

**Injection surface, new relative to DokuWiki/Nextcloud.**
`import_recipe_from_url` makes the server fetch a URL server-side and
persist whatever comes back — a URL sourced from untrusted content (a
recipe's own text, a note, another agent's output) turns a prompt injection
into a write. The subagent file restricts that tool to URLs the operator
supplied directly, on top of the usual report-never-quote handling of
embedded instructions and secret-looking values.

**Content language is a data fact, not a house style.** Following house
convention (English code/skills/docs), the new `mealie` subagent file and
the shipped `mealie-restricted` container skill are English — a departure
from `dokuwiki.md`/`nextcloud.md`, which are German and predate that
convention. Separately, and orthogonally: what the subagent *writes into
Mealie* (recipe titles, ingredients, notes, meal-plan entries) is German,
stated as a fact about this specific recipe collection in the subagent file
and in `instructions.local.md`, not left to whatever language a task
happens to arrive in. Imported recipe text (`import_recipe_from_url`) is
the one exception — it keeps the source page's language rather than being
silently translated after the fact.

**Verified end-to-end.** Gateway injection confirmed (a deliberately wrong
`Bearer dummy-placeholder` still returned an authenticated response for
Mealie user `kail`). Asked the `mealie` subagent to list its own tools: it
reported exactly the 18 tools restricted mode should expose and, unprompted,
named the 6 it doesn't have (`update_recipe`, `delete_recipe`,
`set_recipe_image`, `upload_recipe_image`, `bulk_tag_recipes`, cookbook
mutation) — confirming the filter happens at registration, not as a runtime
rejection the model could talk its way around.

vibecoded with Opus 5

## 2026-08-11 — Harden the websearch subagent and move it to Sonnet

`websearch` is the only component that reads fully attacker-controlled text,
and its summary flows onward to the main agent and from there potentially to
Matrix or email. It already refused to follow embedded instructions, but was
still allowed to quote them, which delivered the payload one hop further
instead of stopping it. Its security section now spells out four things it
never did before: report a prompt-injection finding as source plus kind of
attempt and never as wording, fetch URLs only from the task, from search hits
or from ordinary links (never one a page's prose asks it to call, which would
turn read-only web access into an outbound channel via query parameters),
emit no auto-loading markup in its answer since that answer gets rendered and
forwarded elsewhere, and treat quoted third-party material inside its own task
as data too — the main agent builds tasks out of mail and wiki content. It
also gains a credentials section modelled on the dokuwiki subagent's,
including that section's anti-over-redaction half: a username, host or port is
the substance of a search result, not a secret, and redacting it would make
the research worthless.

The same report-never-quote clause is now in the `nextcloud` and `dokuwiki`
subagents and in the `deep-research` skill, which all carried the same gap in
the same house wording. The main agent's standing instructions gain the
matching caller-side rule: what a subagent withheld stays withheld — don't ask
for the wording, don't source it another way, don't offer to sort it out.

The model moves from Haiku to Sonnet. These rules only help if the model holds
them while reading text written to make it not hold them, and the weakest
model sat at exactly the point where the only hostile input arrives. It costs
roughly twice as much per token today and three times from September, on every
internet-facing request, since delegation to `websearch` is unconditional. The
larger context window is a side benefit: big pages no longer risk exhausting
the subagent.

vibecoded with Claude Opus 5

## 2026-08-09 — Harden dokuwiki subagent against secrets on the wiki

`groups/main-agent/.claude/agents/dokuwiki.md` gained a `## Geheimnisse —
nicht verhandelbar` section, same weight as the existing injection-defense
one. Martin's wiki accumulates real credentials over time (passwords, API
keys, VPN details) and the `dokuwiki` subagent is the only thing that ever
sees raw page content — the caller (`kail01`) has no DokuWiki tools of its
own, so this is the sole point where a leak or an accidental write can be
stopped.

Two rules: never repeat a secret-looking value (password/API-key/token
labels, private-key blocks, `user:pass@host` connection strings) in the
report back to the caller — flag its existence and page location only,
never the value; and never write a secret into a page even if a task
explicitly asks for it — refuse that part, report it under "not done",
never submit a review-queue change containing it. The "Antwortformat"
section's "Nicht getan" bullet now points at this explicitly.

`kail01`'s standing instructions (`groups/main-agent/instructions.prepend.md`)
got a defense-in-depth paragraph in the DokuWiki delegation section: a
redacted-secret flag from the subagent is relayed to Martin as-is (page +
"credential found, withheld"), never a value, and `kail01` never tries to
fetch the raw page itself to check — cheap belt-and-braces, not the real
control, since it never had the tools to do that anyway.

Live-testing the write refusal turned up a second, less obvious gap. The
subagent correctly refused to put a password on a page, but `kail01` relayed
that as *the subagent's own quirk* ("eine Eigenentscheidung des Subagenten,
keine von mir vorgegebene Regel") and offered to try again or "work out a way
to do it" — which is exactly the pressure the refusal exists to withstand.
The paragraph therefore also states that both rules are house policy, and
that a refusal is the end of the matter: report it, never offer a retry or a
reformulation. A secret belongs in a password manager, not the wiki.

A follow-up correction from Martin sharpened the rule in the other
direction. The first wording treated anything following a
password/token/key label as a secret, which over-fires on this wiki: its
installation how-tos name usernames, hosts, ports and settings constantly,
and for passwords Martin records at most a mnemonic (a first letter) —
the actual secrets live in a password manager. Full secrets do occur (a
plaintext LoRaWAN AppKey turned up in the survey), so the hard rule stands
for those, but the section now says plainly that usernames, hosts, ports,
paths and settings are the content the page exists for and must be reported
normally, and that withholding is the exception rather than the default.
An over-redacting subagent is useless here, because the caller holds no
wiki tools and cannot check anything that gets redacted away. The installer
skill carries the same counterweight.

Testing the loosened rule on a real page then exposed the opposite leak.
Asked for the usernames on the wiki's IT overview page, the subagent
returned them correctly and withheld the passwords — except for two, whose
plaintext values it passed along because it judged them "nur schwache
Defaults". `kail01` caught them and refused to relay them further, so the
second layer held where the first didn't, and it reported the discrepancy
unprompted. Both files now say the rule admits no harmlessness exception:
weak defaults, factory passwords, PINs, service codes and obvious test
values are secret values, the agent cannot know where one is reused or who
reads the answer, and catching itself building a case for why one value is
fine is precisely the signal to withhold it.

Worth recording for the next person who edits a persona: the first attempt
put this in `groups/main-agent/.claude-fragments/persona.md`, which is the
*generated* artifact — `composeGroupClaudeMd` rewrites the whole fragments
directory from `instructions.prepend.md` on every container spawn, so the
edit silently vanished at the next restart and only the live test revealed
it. `instructions.prepend.md` is the source of truth; `.claude-fragments/`
is downstream and disposable.

`.claude/skills/add-dokuwiki-tool/SKILL.md` Phase 4 updated so future
installs (and re-runs) generate this section too, instead of only the
Nextcloud-derived reporting/injection boilerplate — it now points at this
install's `dokuwiki.md` as the reference wording.

No server-side/programmatic secret redaction — the MCP server is the
external `dokuwiki-plugin-mcp` PHP plugin reached over `mcp-remote`, outside
this repo's request path, so this is prompt/persona hardening only. No
build or rebuild needed, just a container restart for the `groups/` file
changes to take effect.

vibecoded with Claude Sonnet 5

## 2026-08-09 — DokuWiki review-queue integration for kail01

New fork-local tool skill, `.claude/skills/add-dokuwiki-tool/SKILL.md`, wiring
a review-gated DokuWiki (running a separate, fork-external `reviewqueue`
plugin project) into the owner's agent group as an MCP tool. Mirrors
`/add-nextcloud-tool`'s OneCLI-native shape (no credential ever reaches the
container; the gateway rewrites the `Authorization` header at request time)
but for Bearer auth against a remote HTTP MCP endpoint instead of Basic
auth against a native stdio server: `mcp-remote` (pinned `0.1.38` via
`container/cli-tools.json`, invoked directly by binary name — not `npx`,
which would silently ignore the pin and fetch latest on every cold start)
bridges the stdio-only `ncl groups config add-mcp-server` schema to the
plugin's `https://.../lib/plugins/mcp/mcp.php` endpoint. Its native
`--enable-proxy` flag was enough to route through the gateway; unlike the
Nextcloud integration, no custom env-proxy shim was needed.

Because the whole point of the review queue is to keep the agent from
touching the live wiki unsupervised, the tools are `subagentOnly: true`,
held by a new dedicated `dokuwiki` subagent
(`groups/main-agent/.claude/agents/dokuwiki.md`) rather than given to
`kail01` directly — same isolation pattern as the existing `nextcloud`
subagent. A new container skill, `container/skills/dokuwiki-reviewqueue`
(also bundled inside the tool skill for redistribution), teaches whoever
holds the tools the one rule that matters: a "submitted for review" save
response is success, not failure, and re-reading a page afterward can
silently overwrite the agent's own unreviewed draft.
`instructions.prepend.md` gained a delegation section mirroring the
existing Nextcloud one, so kail01 reports a queued change as done rather
than as an error.

Two environment prerequisites worth recording, both of which blocked
verification until found:

- The NanoClaw host and the wiki sit on separate VLANs with no route
  between them, so every call timed out before reaching the wiki at all.
  Worth isolating with a plain unauthenticated `curl` early: a
  timeout is routing, a 401/403 is auth, a 500 is the wiki app itself.
- The wiki is Debian-packaged, and every call to the MCP plugin's endpoint
  returned HTTP 500. Debian splits core (`/usr/share/dokuwiki`, which holds
  `vendor/`) from data and plugins (`/var/lib/dokuwiki`), and already
  symlinks `inc` between them precisely so plugin entry points computing
  `DOKU_INC` from `__DIR__` resolve (Debian bug #588405) — but `vendor` was
  never added to that list when upstream adopted Composer. One symlink
  (`/var/lib/dokuwiki/vendor → /usr/share/dokuwiki/vendor`) fixes it, and a
  review of every `DOKU_INC` use confirms nothing else is missing behind
  it. Documented in the skill's Phase 0, since the failure looks like a
  missing Composer step and isn't one.

Verified end to end against the live wiki: the agent delegated correctly,
reported the write as "zur Review eingereicht — Change #2, pending, noch
nicht live" rather than as published, and on a follow-up "is it visible
yet?" returned the queued draft without stacking a second one — confirmed
independently via `plugin_reviewqueue_listMyPending`, which showed exactly
one pending change.

vibecoded with Claude Sonnet 5

## 2026-08-08 — fixed the deferred in_reply_to staleness follow-up from the duplicate-reply investigation

Follow-up to the same-day duplicate-Matrix-reply fix below. That investigation
found a second, unrelated bug in the same code region and left it unfixed on
purpose (not a duplicate-delivery cause, just wrong reply threading) — this
closes it.

`send_message`/`send_file` stamp outbound rows with `in_reply_to` read from
`current_in_reply_to` (`session_state` in `outbound.db`), but
`setCurrentInReplyTo` was only ever called once per active query — for the
initial batch, at `poll-loop.ts:290`. When the same continuous stream later
absorbed a follow-up message via the concurrent follow-up poller, the stamp
never moved, so a tool call made after that point still threaded against
whatever message had originally opened the stream, not the one actually in
play. Live incident evidence: outbound seq 941 was stamped `in_reply_to`
against a message from 10:05 instead of the one from 10:12 it actually
answered.

Fix: the follow-up poller now republishes `current_in_reply_to` for its own
batch (`setCurrentInReplyTo(extractRouting(keep).inReplyTo)`), right
alongside the `markTurnStart()` call added by the duplicate-reply fix — same
"this is where a new batch starts" cluster in `poll-loop.ts`. New regression
test in `poll-loop.test.ts` drives a real follow-up push through
`processQuery` and asserts a tool send made afterward threads against the
follow-up message; it failed on the prior code (stayed pinned to the
original message) and passes now.

vibecoded with Claude Sonnet 5

## 2026-08-08 — fixed the real cause of duplicate Matrix replies (turn-boundary reset, not a Matrix bug)

KaiL01 sent the same Matrix reply twice again, despite the 2026-08-02 fix
(`f70bec82`) for exactly this symptom. This time the cause was tracked all the
way through with log evidence — host logs, `outbound.db`, and live
`docker logs` from the still-running container — rather than inferred, per the
user's explicit request for a verified root cause instead of another guess.

The earlier fix's mechanism (suppress a final `<message>` block that echoes an
earlier `send_message` tool call in the same turn, via
`container/agent-runner/src/turn-sends.ts`) is sound and did not need
reverting — it correctly suppressed three earlier echoes in this very
incident. The gap was narrower: `poll-loop.ts` called `markTurnStart()`
unconditionally after every `'result'` event, including a same-turn re-wrap
retry (triggered when the model's final text is missing its closing
`</message>` tag and gets nudged to resend). That reset the echo-suppression
window mid-turn, so when the model complied with the nudge and resent the
exact text it had already sent via the tool moments earlier, the retry was no
longer recognized as an echo and got delivered as a genuine second message
(outbound seq 941 and 947 in the incident, byte-identical text, 7.8s apart).

Fix: `markTurnStart()` now only fires where a genuinely new pending message
gets pushed into an active query (the follow-up poller in `processQuery`,
where `unwrappedNudged`/`taskBlockNudged` already reset for the same reason),
not after every `'result'` event. A same-turn retry — wrapping or task-block —
keeps seeing the turn's own earlier tool sends and dedupes against them as
before. New regression test in `poll-loop.test.ts` reproduces the exact
incident shape (tool send → malformed result → nudge → compliant retry) and
fails without the fix.

A second, unrelated bug turned up during the investigation and was left
unfixed by the user's choice: `current_in_reply_to` (set once per outer
poll-loop iteration) goes stale across a long-lived stream with multiple
pushed follow-ups, so a tool-based send made after a later push threads
against an older inbound message instead of the one that triggered it. Not a
duplicate-delivery cause, just wrong reply-to metadata — worth a follow-up.

vibecoded with Claude Sonnet 5

## 2026-08-03 — chat stays the default channel, and self-started mail carries its own subject

An hourly Deck sweep reported to the user by email instead of chat, under the
subject `Re: <an older, unrelated subject>`. Two separate causes.

A task run deliberately renders no default reply destination — the agent has to
name one — so with an email destination present it simply picked that one. That
part is an install-level decision and now lives in the group's standing
instructions: chat is the channel for anything the agent starts on its own,
mail only for answering an incoming mail, for tasks that genuinely need it
(attachment, calendar invitation), or on explicit request.

The subject is the generic half. Passing no `subject` makes the host build one
from the correspondent's last stored mail — right for a reply, wrong for a
report that has nothing to do with it. The guidance in the `email-formatting`
skill and in the outbound-tools instructions said to leave the subject off
"when you are answering something," which a proactive notification reads as
applying to itself. Both now say the opposite by default: everything the agent
starts gets an explicit subject, and the subject is omitted only when directly
answering a mail from the same conversation, where `Re:` and the threading
headers are what you want. No change to `src/channels/email.ts` — the fallback
itself was already correct and tested.

vibecoded with Claude Opus 5

## 2026-08-03 — an MCP server can now be withheld from the main agent and handed to one subagent

An MCP server's tool schemas ride along on every single API call of the thread
that holds them. The Nextcloud server (`-e calendar -e deck -e webdav`) exposes
63 tools; measured against the running image, they add 68,283 characters
(~17k tokens) to the request — spent on every turn, including the ones that never
mention Nextcloud. The `tools/list` response is 155,784 characters raw; the CLI
drops the MCP-side extras, so 68k is what actually goes on the wire and the honest
number to quote.

The obvious route does not work, and it was worth proving before building
anything. Withholding a server from the main thread with a top-level
`disallowedTools: ['mcp__x__*']` does strip the schemas from the main thread's
request — and strips them from the subagent's request too, even when the subagent
claims the server. Verified by pointing the CLI at a fake Anthropic endpoint that
logs the `tools` array actually sent per thread: main 30 → 24 tools, subagent
27 → 21, zero `mcp__nc__*` in either.

What does work is declaring the server *only* in `AgentDefinition.mcpServers`.
Same harness: main thread 24 tools with none of the server's, subagent 84 with all
63, and the subagent's tool call really executed. The server process is not spawned
until the subagent is invoked, so a withheld server costs nothing on turns that
never use it. Two details are load-bearing and easy to get wrong — the Record form
is mandatory (a bare string resolves against the on-disk MCP config, not the
servers passed programmatically, and silently resolves to nothing), and the CLI
skips agent-frontmatter MCP servers entirely under `--strict-mcp-config`,
safe/bare mode, remote mode, or an enterprise MCP config. NanoClaw sets none of
those today; if one is ever introduced, every withheld server goes unreachable.

The assignment is deliberately two-sided. `container.json` / `container_configs`
marks a server `subagentOnly` — the withholding decision, DB-owned, set via the new
`ncl groups config set-mcp-server-scope` (or `--subagent-only` on
`config add-mcp-server`). A subagent claims it back by name through a new
`mcpServers:` key in its `.claude/agents/*.md` frontmatter — the granting decision,
tracked in git. `buildAgentDefinitions` in the claude provider resolves the claim
against the full server map and logs both the unclaimed-server and the
unknown-claim cases rather than failing silently. A new `skills:` frontmatter key
preloads skills into the subagent, which is what lets a Deck executor carry the
board conventions without the main agent restating them.

A note on measurement, because the obvious instrument lies here: the per-message
token notice cannot show this. Each chat in this install spawns a fresh container,
and on a fresh container the SDK restores the session's cumulative usage, so the
first (and only) reported turn is a restored total, not a turn cost — the readings
climbed from 62k to 67k across the change and told us nothing. The request-payload
measurement above is the real number.

vibecoded with Claude Opus 5

## 2026-08-03 — the token notice was reporting the session total as if it were the message

A one-word "pong" was announced as 1,425,827 tokens. The number was real, but it
was not the message's: the Agent SDK's `modelUsage` is a running total for the
whole session — it accumulates over every API call the process makes, lives in a
process-global state object, and is restored on resume — while the notice printed
it verbatim under a comment claiming it covered "the turn that just completed".
The tests asserted the same wrong thing, so nothing caught it. Confirmed both ways
before touching anything: the SDK binary accumulates with `r.inputTokens +=
t.input_tokens` into a session-global object, and in the live session the counter
rose 1,335,734 → 1,425,827 across the "ping" that produced that "pong" — 90k for
the message itself.

`deliverTokenUsageNotice` now keeps the last cumulative totals per model and
reports the difference, so the notice says what the message cost and nothing else.
A total that went backwards means the SDK session started over (fresh container),
in which case the current value is the turn's usage. Models with no change are
dropped, and a turn that consumed nothing stays silent instead of delivering a
bare "📊 Tokens:" with no numbers — which is what the empty notices in the sweep
session had been.

Subagents need no special handling and are covered by a test: their usage lands in
`modelUsage` under the model they ran on, so a subagent-only model is a difference
against zero on the turn that used it. Verified live — a websearch turn reported
`claude-sonnet-5: 132,392 ($0.05) · claude-haiku-4-5-20251001: 44,546 ($0.04)`.

vibecoded with Claude Opus 5

## 2026-08-03 — Deck inbox handoff, and a gitignored home for install-specific facts

Two pieces, one purpose: let the agent put a task in front of its user without
being able to write to the user's own board, and keep the skill that does it free
of any personal names.

**The gate is a Deck board ACL.** The user's own board is shared read-only with the
agent's Nextcloud account; a second board is shared with write access. The agent
drops a card into that inbox board, the user reviews it and moves it onto their own
board by hand. A write attempt on the user's board fails with 403 on the server
regardless of what the agent intends — the same structural-rather-than-prompted
review step as the calendar invitations. It is also the only way Deck can express
this: permissions are per board, never per stack, so an "Inbox" stack on the user's
own board would have been convention, not a gate.

New container skill `nextcloud-deck-inbox` carries the conventions: resolve the
boards from local facts and verify against `permissionEdit` from `deck_get_boards`
before writing, never fall back to some other writable board, check both boards for
a duplicate first, write a card that stands on its own at review time, notify once
by chat — and, the part that is easy to get wrong, treat the card as a handoff
rather than a completed task, because once the user moves it the agent has read
access to it and nothing else.

**`instructions.local.md`.** Skills under `container/skills/` are tracked and
public, so board names, mailboxes, and hosts cannot live in them — but the agent
still has to know which board is which, reliably, every session. The only
always-in-context per-group document was `instructions.prepend.md`, which this fork
tracks on purpose. So groups gained a second one: `instructions.local.md`, read by
`readGroupLocalFacts()` and compiled by `composeGroupClaudeMd()` into a
`local-facts.md` fragment imported right after the persona. It needed no
`.gitignore` change — `groups/*/*` already excludes everything not explicitly
re-included — and the existing reconcile loop prunes the fragment when the file
goes away. Skills now say "your local facts" and stay shareable; the names live in
one gitignored file per install.

vibecoded with Claude Opus 5

## 2026-08-03 — the fork-changelog note in CLAUDE.md said the opposite of the truth

`CLAUDE.md` claimed "this file is gitignored … it just never shows up in a diff or PR"
right after naming both `FORK-CHANGELOG.md` and `nanoclaw-overview.md`, so which file
it meant was ambiguous — and on the plain reading it was wrong: `FORK-CHANGELOG.md` is
tracked and ships with the commit it describes. Only `nanoclaw-overview.md` is
gitignored, because it names real host and domain specifics. Both are now stated
separately.

Also: `.claude/scheduled_tasks.lock`, a runtime lock, had been committed once by
accident, so every session opened with a phantom pending deletion in `git status`. It
is untracked now and ignored going forward.

vibecoded with Claude Opus 5

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

