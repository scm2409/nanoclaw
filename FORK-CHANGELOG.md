# Fork Changelog

Changes in this fork ([scm2409/nanoclaw](https://github.com/scm2409/nanoclaw))
relative to upstream [nanocoai/nanoclaw](https://github.com/nanocoai/nanoclaw).
Every entry is **vibecoded** — written by Claude Code under human direction —
and names the model that wrote it.

Upstream's own release notes live in [CHANGELOG.md](CHANGELOG.md); this file
never touches them. See [docs/fork-changelog.md](docs/fork-changelog.md) for
the entry format and how this file is kept up to date.

---

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

Commits: (uncommitted) · vibecoded with Claude Opus 5

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

