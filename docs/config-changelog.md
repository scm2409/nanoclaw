# Config Changelog

This fork keeps two changelogs side by side:

- **[FORK-CHANGELOG.md](../FORK-CHANGELOG.md)** — fork-local code changes.
  See [docs/fork-changelog.md](fork-changelog.md).
- **[CONFIG-CHANGELOG.md](../CONFIG-CHANGELOG.md)** — operational config made
  through `ncl` that lives only in `data/v2.db` (agent groups, messaging
  groups, wirings, roles, scheduled tasks, container config, destinations,
  members, MCP servers). None of this is tracked by git, so without a log
  there's no way to later answer "what's configured and why" beyond
  re-querying current DB state — which shows *what* but not *why* or *when*.

The file itself is **gitignored** (`/CONFIG-CHANGELOG.md` in `.gitignore`) —
unlike the fork changelog, its entries can describe what a specific group's
tasks/wirings actually do, which may be personal or otherwise unsuited to a
public repo. Only this convention doc and the `CLAUDE.md` pointer are
tracked; the log content itself stays local per install.

## The convention

This is a convention, not a hook-enforced invariant like the fork changelog.
DB changes go through arbitrary `ncl` CLI calls rather than tracked file
writes, so there's no reliable diff to gate a `Stop` hook on. Log an entry
whenever a session makes an `ncl`-driven change worth remembering later —
use judgment: a one-off `ncl groups get` to inspect state doesn't need an
entry; creating a task, wiring a channel, granting a role, or changing
container config does.

## Entry format

Newest entry at the top, right after the file's header.

```markdown
## <YYYY-MM-DD> — <short title>

<Prose: what was configured, the exact ncl command/resource IDs involved,
and why — a future session re-reading this should be able to find and
inspect the same rows via `ncl ... get`.>

configured with <model>
```

Same no-commit-sha rule as the fork changelog: the heading's date is
sufficient provenance, and there's no commit to name anyway since a
DB-only change often has no accompanying commit at all.
