---
name: nextcloud-deck-inbox
description: >-
  Hand a task to the user by dropping a card into the one Nextcloud Deck
  board you may write to, so they can review it and move it onto their own
  board themselves. Use whenever the user asks you to put something on
  their board, note something down for them, or make a task out of
  something. Not for your own working board — that is
  nextcloud-deck-workflow. Only relevant if the Nextcloud MCP tool is wired
  with the Deck app enabled and your local facts name an inbox board.
metadata:
  author: nanoclaw
---

# Deck inbox handoff

The user's own Deck board is theirs. You can read it; you cannot write to
it, and that is enforced by the board's share permissions on the Nextcloud
server, not by this document. What you do have is a second board — an
inbox — that you may write to. You drop a card there, the user reads it,
and *they* move it onto their board.

**Creating the card is the handoff, not the task being done.** Never report
something as filed on their board, added to their tasks, or taken care of.
You put it in front of them and it is waiting for them.

## Which board is which

Your local facts (the install-specific section of your project document)
name the boards: which one is the user's own read-only board, which one is
the inbox you write to, and which stack in it to use. Take the identities
from there — never guess from board titles.

Then verify before writing. `deck_get_boards` returns every board with a
`permissions` object; the inbox board must come back with
`permissionEdit: true`. If it is missing, or edit is false, **stop and tell
the user**. Do not fall back to some other board that happens to be
writable — the whole point is that cards land where they expect to review
them.

For the stack: use the one your local facts name. If they name none, call
`deck_get_stacks` on the inbox board and use the first one. If the board
has no stack at all, say so and stop — never create a stack on a board you
do not own.

## Before creating: look for it already being there

Read the inbox board *and* the user's own board first. If the same thing is
already sitting in either — still in the inbox awaiting review, or already
moved over and being worked — say that instead of creating a second card.
A duplicate costs the user a review step and teaches them to distrust the
inbox.

## What a good card looks like

`deck_create_card(board_id, stack_id, title, description, duedate)`.

- **title** — short and imperative, the thing to be done. Not a topic label.
- **description** — the context they will have forgotten by review time:
  where this came from (quote the chat line, name the mail, paste the URL),
  why it needs doing, and what "done" would look like. The card has to
  stand on its own; you will not be there to explain it.
- **duedate** — ISO-8601, and only when the user actually named a date.
  Never invent one.

Then send them one short chat message: the card title and a one-line why.
That is enough for them to decide whether to review now or later.

## After they move it, it is out of your hands

Once a card is on the user's own board you have read access and nothing
else — no comment, no update, no closing it out. So do not promise
follow-up on it, and do not offer to keep it up to date. If there is work
*you* should actually be doing, that belongs on your own working board (see
`nextcloud-deck-workflow`), with a pointer from the card's description.

## Restraint on the inbox board

You have full write access there, which is exactly why the limits have to
be explicit:

- Only touch cards you created yourself, and only while the user has not
  commented on them. A comment from them means they are looking at it.
- Never delete or archive anything in the inbox. The user empties it by
  moving cards out; a card disappearing on its own is indistinguishable
  from you losing it.
- Correcting a card you just created — a typo, a missing detail — is fine.
  Rewriting one from an earlier session is not; add a comment instead.

## What this skill does not do

- No writing to the user's own board, in any form, including comments. A
  403 from there is the gate working, not a bug to route around.
- No moving cards between the two boards. The move is the user's review
  step and the only thing that makes a card theirs.
- No labels or assignees on the inbox board unless your local facts say
  which ones to use.
- No creating, renaming, or deleting boards or stacks.
