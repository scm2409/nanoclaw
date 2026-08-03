---
name: email-formatting
description: >-
  How to write messages that leave the house as email rather than chat —
  subject lines, plain-text layout, quoting, and the hard attachment limits
  (10 MiB per file, 20 MiB total, 10 files) that make a send fail outright if
  exceeded. Use whenever a destination is an email address, or when a message
  you received came in by email.
metadata:
  author: nanoclaw
---

# Writing email

Some of your destinations are mailboxes, not chats. A message you send to one
becomes a real email: it lands in an inbox, sits there for years, gets
forwarded, and is read by someone who cannot ask you a follow-up question
without writing a whole new message. Write accordingly.

## Recognising an email destination

A destination is email when its address looks like `someone@example.org` — the
destination list shows the channel type. Mail you receive arrives with a
`subject` field and usually a `From` display name.

## Format

Email clients render plain text. They do not render Markdown.

- **Do**: short paragraphs, blank lines between them, plain hyphen lists,
  full sentences, a greeting and a sign-off.
- **Don't**: Markdown tables, `**bold**`, backtick code spans, heading
  syntax, emoji walls. They arrive as literal asterisks and pipes.
- Code or logs: indent the block and keep it short. If it's long, attach it as
  a `.txt` file instead of pasting it.
- Assume no shared context. "As discussed" means nothing three weeks later —
  restate the point in one line.

## Replies and subjects

By default, replies are threaded automatically onto the last mail from that
correspondent and the subject becomes `Re: <their subject>`. Leave it that way
in exactly one case: you are directly answering a mail that arrived in this
conversation.

Everything you start yourself — a task-run notification, a report, an
invitation, a reminder, anything the recipient did not just write to you about
— needs an explicit `subject` passed to `send_message` or `send_file`. It is
used verbatim **and starts a new thread**: the reply headers are dropped, so
the mail no longer hangs off an unrelated conversation. Write it like a mail
subject — short, specific, no `Re:`, and recognisable in a list months later
(`Einladung: Zahnarzt, Mi 5.8. 14:00`, not `Termin`).

Getting this wrong is not cosmetic. The default subject comes from whatever
that correspondent last mailed you, which may be weeks old and about something
else entirely — your report then arrives as `Re: <their unrelated subject>`,
buried in that old thread.

Don't quote the mail you're answering. The recipient has it.

## Attachments — hard limits

Attachments work in both directions. Outbound limits are enforced before
anything reaches the mail server, and a breach **fails the entire message** —
not just the attachment. The recipient gets nothing at all, and you will not
be told directly; it lands in the host's error log.

| Limit | Value |
|---|---|
| Per file | 10 MiB |
| All files in one message | 20 MiB |
| Number of files | 10 |

So before attaching:

1. Check the file size. `ls -l` or `du -h` — do it, don't estimate.
2. Over the limit? Do not try to send it and see. Instead: compress it, split
   it, send an excerpt, or tell the user it's too large for mail and ask how
   they want it delivered.
3. Prefer few, well-named files over many. `2026-q2-report.pdf` beats
   `output_final_v3.pdf`.

(An operator may have raised these limits for this install. Treat the numbers
above as the floor: if a send fails with a limit error, the real limit is what
the error says.)

Inbound, an attachment that was too large for the limit is replaced in the
message text by a line like `[attachment omitted: bericht.pdf, 34.2 MB > 10.0
MB limit]`. The sender does not know this happened — if you need that file,
ask them to send it another way.

## Who you may write to

The mailbox has an allowlist in both directions, maintained by the operator.
You can only address the destinations you already see; there is no way to mail
an arbitrary address, and attempting one fails. If a user asks you to write to
someone new, say that the operator has to allow that address first — don't
speculate about how.

For the same reason, never put a second recipient in the body ("please forward
this to…") as a workaround. If it needs to reach someone, it needs an
allowlist entry.
