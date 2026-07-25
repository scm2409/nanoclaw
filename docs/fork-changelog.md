# Fork Changelog

This fork ([scm2409/nanoclaw](https://github.com/scm2409/nanoclaw)) keeps its
own history separate from upstream's ([nanocoai/nanoclaw](https://github.com/nanocoai/nanoclaw)):

- **[FORK-CHANGELOG.md](../FORK-CHANGELOG.md)** — what this fork changed relative
  to upstream, why, and which model wrote it. Fork-only, never touched by
  `/update-nanoclaw`.
- **[CHANGELOG.md](../CHANGELOG.md)** — upstream's release notes, governed by
  `RELEASING.md` and parsed by `/update-nanoclaw` for `[BREAKING]` entries.
  Never write fork history here — it would conflict on every upstream sync and
  corrupt input to a skill that parses it.

## The invariant

Every commit in `nanoclaw-upstream/main..HEAD` must be referenced in
`FORK-CHANGELOG.md`, either by its short SHA or by an inclusive `A..B` range
(unlike git's own range syntax, `A..B` here includes `A`). A `Stop` hook
(`.claude/hooks/check-fork-changelog.mjs`, wired in `.claude/settings.json`)
checks this at the end of every Claude Code turn and blocks the turn from
ending if any fork commit is uncovered — it reports the missing SHAs and their
subjects in the block reason.

The hook reads the **working tree** copy of the file, not `HEAD`, so writing
the entry — without committing it — already satisfies the check. Commits still
require the human's approval; the hook never asks Claude to commit.

A `SessionStart` hook (same script, `--session-start`) does the same
comparison non-blockingly, as a heads-up at the start of a session, and
supplies the model-attribution string from the harness's own `model` field
rather than Claude's self-report.

If neither hook fires (e.g. hooks disabled, or a change made outside Claude
Code), the invariant just goes unchecked until the next Claude Code turn on
this repo — there's no separate CI job for it today.

## Entry format

Newest entry at the top, right after the file's header. One entry per work
item — it may span several commits from one session or several sessions on
the same topic.

```markdown
## <YYYY-MM-DD> — <short title>

<Prose: what changed and why, worth a sentence or two of context a GitHub
visitor wouldn't get from the commit subjects alone. Reference files/functions
that matter.>

Commits: <sha>, <sha> · vibecoded with <model>
```

- Multiple commits from one topic: comma-separate SHAs, or use an inclusive
  `A..B` range if they're contiguous.
- Multiple models across a range: `vibecoded with Claude Sonnet 5 and Claude Fable 5`.
- Keep it to short SHAs (`git log --format=%h`) — the hook normalizes either
  length via `git rev-parse --short`.

## Writing an entry

Write it as part of the work, before asking to commit — not as an
afterthought once the hook blocks. The hook is a backstop, not the primary
mechanism.
