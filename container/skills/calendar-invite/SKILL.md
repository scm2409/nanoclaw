---
name: calendar-invite
description: >-
  Create an appointment in someone else's calendar by mailing them a proper
  calendar invitation (.ics, METHOD:REQUEST) that their mail client offers to
  accept. Use whenever a user asks you to make, book, or put in an appointment
  for them and you have no write access to their calendar — which is the normal
  case for a personal calendar. Not for events in a calendar you can write to
  directly, and not for updating or cancelling an invitation you sent earlier.
allowed-tools: Bash(bun /app/skills/calendar-invite/make-ics.ts:*)
metadata:
  author: nanoclaw
---

# Mailing a calendar invitation

You cannot write to the user's personal calendar. What you can do is send an
invitation: a mail with an `.ics` attachment that their client shows with an
Accept button. **They accept, and that is what creates the event.**

This is a handoff, not a completed task. Never report an appointment as
entered, booked, or done — you sent an invitation and it is waiting for them.
Say that.

## Two steps

1. Build the file with the script.
2. Mail it with `send_file`, using the `path` the script printed.

Never write an `.ics` by hand. The properties that decide whether a client
treats the file as an invitation at all — CRLF line endings, 75-octet line
folding, escaping, an exclusive end date for all-day events — are invisible in
anything you can read back, so a hand-written file looks fine and silently
fails to import.

## Step 1 — build the file

```bash
bun /app/skills/calendar-invite/make-ics.ts create \
  --summary "Zahnarzt Kontrolle" \
  --start 2026-08-05T14:00 \
  --duration 45m \
  --location "Ordination Dr. Müller, Wien" \
  --attendee "martin@example.org:Martin"
```

It prints one JSON line:

```json
{"uid":"…","path":"/tmp/calendar-invite/invite-….ics","filename":"invite-….ics","summary":"Zahnarzt Kontrolle","humanSummary":"…"}
```

The file is scratch: it lives in `/tmp`, not in your workspace, and only has to
survive until `send_file` has copied it. Mail it in the same turn, don't move
it into the workspace, and don't refer back to it later.

Flags:

| Flag | Meaning |
|---|---|
| `--summary` | Event title. Required. |
| `--start` | Local wall-clock time `YYYY-MM-DDTHH:mm` (or `YYYY-MM-DD` with `--all-day`). Required. |
| `--duration` | `30m`, `2h`, `1h30m`. Either this or `--end`. |
| `--end` | Local end time. For `--all-day`, the **last day the event covers**. |
| `--all-day` | All-day event. |
| `--tz` | IANA zone. Defaults to the container's timezone — pass it only if the appointment is in a different one. |
| `--location` | Free text. |
| `--description` | Free text; use it for anything the recipient needs to bring or know. |
| `--attendee` | `address` or `address:Display Name`. Required, repeatable. |
| `--reminder` | Alarm ahead of the start: `15m`, `1h`, `1d`, `1d2h`. Repeatable for several. |

Any error goes to stderr and nothing is written — read it and fix the call
rather than falling back to writing the file yourself.

Reminders are a request, not a guarantee: some clients replace the organizer's
alarms with their own defaults when the invitation is accepted. Pass
`--reminder` when the user asks for one, and if they later say no reminder
appeared, tell them it is their client's setting, not a missing alarm in the
invitation.

## Step 1a — the organizer, once

The organizer must be the mailbox the invitation is sent **from**, or replies
to it go nowhere. The script cannot know that address, so the first `create`
fails until it is set:

```bash
bun /app/skills/calendar-invite/make-ics.ts config set \
  --organizer kail@example.org --organizer-name "KaiL01"
```

If it is not configured yet, ask the user which address you send mail from and
what name should appear as the organizer. Do not guess. It is stored in
`/workspace/agent/calendar/config.json` and needed only once.

## Step 2 — mail it

```
send_file({
  to: "<the email destination>",
  path: "<the path from the JSON>",
  subject: "Einladung: Zahnarzt Kontrolle, Mi 5.8. 14:00",
  text: "…"
})
```

- `to` must be an email destination. This does not work over chat channels —
  they show the file as a download, with no way to accept it.
- Always pass `subject`. An invitation opens its own topic, and setting a
  subject also keeps it out of an unrelated mail thread.
- The `text` is what the recipient reads before they look at the invitation.
  State the same facts as the invitation in one or two lines — title, date,
  time, place — so they can sanity-check it without opening the attachment,
  and so it is still readable if their client does not render invitations.
- Don't rename the file. The `.ics` extension is part of how the client
  recognises it.

## Confirm what you sent, ask when unsure

Before building the file, make sure you actually have a date, a time, and a
length. If the user said "nächste Woche mal zum Zahnarzt", you do not have an
appointment — ask. A confidently wrong invitation costs the user more than a
question does, because they have to notice the mistake, decline, and explain it.

Afterwards, tell them what went out and that it is waiting for their
acceptance.

## What this skill does not do

- **Changing or cancelling an invitation you already sent.** Not supported.
  Say so and let the user do it in their calendar.
- **Recurring appointments.** Not supported: repeating events need timezone
  rules this script does not write, and would drift by an hour across a
  daylight-saving change. Offer single appointments instead.
