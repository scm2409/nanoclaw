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

Any Claude Code session that writes a fork-local file must also change
`FORK-CHANGELOG.md` before the session ends. A `Stop` hook
(`.claude/hooks/check-fork-changelog.mjs`, wired in `.claude/settings.json`)
checks this at the end of every turn — if the session wrote a non-exempt file
but the changelog's content is unchanged since the session started, it blocks
the turn and lists the files written.

The hook reads the **working tree** copy of the file, not `HEAD`, so writing
the entry — without committing it — already satisfies the check. Commits still
require the human's approval; the hook never asks Claude to commit, and never
inspects git history or commit shas.

A `SessionStart` hook (same script) records the changelog's content hash as
the session's baseline and prints the convention as a reminder.

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
visitor wouldn't get from a diff alone. Reference files/functions that matter.>

vibecoded with <model>
```

- No commit shas anywhere in an entry. The heading's date is enough
  provenance; `git log` is authoritative for anything more specific.
  (An earlier revision of this convention required naming commit shas and
  had a `Stop`-hook check to match — dropped entirely after it produced a
  real incident: a commit's sha is a hash of its own content, so a commit can
  never name its own final sha inside itself, and the fix-up commits chasing
  that kept needing another fix-up commit to reference themselves. Simplest
  fix was removing the requirement, not patching around the paradox.)
- Multiple models on one entry: `vibecoded with Claude Sonnet 5 and Claude Fable 5`.

## Writing an entry

Write it as part of the work, before asking to commit — not as an
afterthought once the hook blocks. The hook is a backstop, not the primary
mechanism.
