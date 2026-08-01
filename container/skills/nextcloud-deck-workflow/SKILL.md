---
name: nextcloud-deck-workflow
description: >-
  Conventions for working with Nextcloud Deck cards via the Nextcloud MCP
  tool — stack layout, when to comment, when to gate a card for human
  review, and when to notify the user by chat. Use this whenever a task
  (scheduled or ad-hoc) has you read, create, or update Deck cards. Only
  relevant if the Nextcloud MCP tool is wired with the Deck app enabled.
metadata:
  author: nanoclaw
---

# Nextcloud Deck Workflow

These are default conventions for any Deck board you're asked to work on
autonomously (a scheduled sweep, a background task, or an ad-hoc request
that touches several cards). A specific task's own instructions always win
if they say something different — this is the fallback, not an override.

## Stack convention

Recommended stack layout for a board you work on repeatedly: **To do →
Doing → Review → Done**.

- **To do** — not started.
- **Doing** — you're actively working it; safe for you to pick back up and
  continue on a later run.
- **Review** — a pure automation gate, not a progress stage. Move a card
  here whenever you've produced something — a comment, partial work, a
  finished sub-step — that needs the user's eyes or a decision before any
  further work happens on that card, *regardless* of whether the
  underlying task is actually finished. A card can reach Review after five
  minutes of work or after being fully resolved but awaiting sign-off.
- **Done** — genuinely finished, nothing further needed from the user.

**Never act on a card already sitting in Review** — not on a scheduled
run, not on a manually triggered one. Only the user moving it themselves
(back to Doing to keep going, or forward to Done to accept it), or an
explicit chat instruction from them, releases it. This exists specifically
to prevent a race: without this gate, a later automated pass (or the user
triggering an extra run) can pick the same card back up and keep working
it — e.g. doing a second round of research — before the user has even
seen the first result.

If a board doesn't have a Review stack yet and you find yourself needing
one, say so rather than silently working around the gap (e.g. by leaving a
card in Doing and hoping nobody re-triggers it).

## Comment by default

Add your result or current status as a comment on the card whenever you
work on it — what you did, what you found, what's left — by default,
unless the task's own instructions explicitly say otherwise. This is what
lets the user pick up the thread later without re-reading everything you
did from scratch, and it's what makes a card sitting in Review
self-explanatory.

## Chat notifications

- Notify the user by chat when you mark a card **Done**.
- Notify the user by chat when you move a card to **Review** (i.e. you
  left a comment without finishing) — keep it brief, just enough to know
  which card and what to check.
- If you get stuck mid-card and need a quick answer to keep going, ask the
  user directly by chat rather than stalling silently.
- If the user has told you they don't want to be disturbed about a
  specific task and will check back themselves later, respect that and
  stay quiet on it — this overrides the notification defaults above for
  that task only.
- Otherwise, if there's nothing worth reporting, stay quiet — a background
  sweep doesn't need to check in every time it finds nothing to do.
