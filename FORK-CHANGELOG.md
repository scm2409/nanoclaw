# Fork Changelog

Changes in this fork ([scm2409/nanoclaw](https://github.com/scm2409/nanoclaw))
relative to upstream [nanocoai/nanoclaw](https://github.com/nanocoai/nanoclaw).
Every entry is **vibecoded** — written by Claude Code under human direction —
and names the model that wrote it.

Upstream's own release notes live in [CHANGELOG.md](CHANGELOG.md); this file
never touches them. See [docs/fork-changelog.md](docs/fork-changelog.md) for
the entry format and how this file is kept up to date.

---

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

Commits: 9b52920..e373ef7 · vibecoded with Claude Sonnet 5

## 2026-07-25 — Fork changelog + vibecoded disclosure

Made this file structurally hard to skip, plus surfaced that this repo is vibecoded. A
`SessionStart` hook records each work item's baseline (HEAD sha, a hash of this file, the
model in use); a `PostToolUse` hook records which repo files Claude actually writes; a `Stop`
hook (`.claude/hooks/check-fork-changelog.mjs`, wired in `.claude/settings.json`) blocks the
turn from ending if the session changed the fork but this file doesn't show it — checked
against edits, not just commits, since commits need approval and a typical session ends with
none yet. Commit ranges written here (`A..B`) are read inclusive of both ends and expanded to
full SHAs for the coverage check. The gate is satisfiable by editing this file alone; it never
asks Claude to commit. Also added the README callout disclosing the fork is vibecoded, and
`docs/fork-changelog.md` documenting the convention.

Commits: 0170eb5 · vibecoded with Claude Opus 5

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

Commits: 6466144, cf8eae7 · vibecoded with Claude Sonnet 5

## 2026-07-25 — Matrix channel

Added Matrix as a channel (`src/channels/matrix.ts`) with working E2EE, plus the
Node/E2EE compatibility fixes it needed, and a live homeserver test suite
(`pnpm test:matrix-live`). Subsequent fixes: a DM-routing race and a startup
retry gap; encrypted-media fetch and agent trust for voice notes; permanent
delivery failure after a snapshot-restored restart; and replies landing in the
wrong room when `openDM` resolved slowly.

Commits: 4cf4714..18c0b49 · vibecoded with Claude Sonnet 5 and Claude Fable 5

