---
name: add-email
description: Configure the email channel (IMAP in, SMTP out) against an existing mailbox, with a per-address allowlist in both directions. Use for "add email", "agent should read mail", "let the agent send email", or managing who the agent may correspond with by mail.
---

# Add the email channel

Connects an agent group to an ordinary IMAP/SMTP mailbox. Every correspondent
is wired individually: the agent can only receive mail from addresses you
allow, and can only send to addresses you allow. Enforcement is entirely local
— it does not depend on anything the mail provider can or cannot do.

The adapter ships in this fork (`src/channels/email.ts`), so there is nothing
to copy from a branch. This skill is credentials, allowlist, and verification.

## What you need first

An existing mailbox with IMAP and SMTP access, and its password (or an
app-specific password — required for Gmail, Outlook, and most providers with
2FA). Do **not** use your main personal mailbox: the agent will mark mail as
`\Seen` and reply from that address. A dedicated address or alias is the right
shape.

Typical hosts:

| Provider | IMAP | SMTP |
|---|---|---|
| Mailbox.org | `imap.mailbox.org:993` (SSL) | `smtp.mailbox.org:587` (STARTTLS) |
| Gmail | `imap.gmail.com:993` (SSL) | `smtp.gmail.com:587` (STARTTLS) |
| Fastmail | `imap.fastmail.com:993` (SSL) | `smtp.fastmail.com:587` (STARTTLS) |
| Own domain / mailcow | usually `mail.<domain>:993` | usually `mail.<domain>:587` |

## Apply

### 1. Collect the credentials

Ask the operator for the address, the two hostnames, and the password. **Never
put the password on a command line** — it would land in shell history and in
the process list. Read it interactively:

```bash
read -rp "Email address: " EMAIL_ADDRESS
read -rp "IMAP host: " EMAIL_IMAP_HOST
read -rp "SMTP host: " EMAIL_SMTP_HOST
read -rsp "Password (app password if 2FA is on): " EMAIL_PASSWORD; echo
```

### 2. Write them to `.env`

```bash
{
  echo "EMAIL_ADDRESS=$EMAIL_ADDRESS"
  echo "EMAIL_PASSWORD=$EMAIL_PASSWORD"
  echo "EMAIL_IMAP_HOST=$EMAIL_IMAP_HOST"
  echo "EMAIL_IMAP_PORT=993"
  echo "EMAIL_IMAP_SECURE=true"
  echo "EMAIL_SMTP_HOST=$EMAIL_SMTP_HOST"
  echo "EMAIL_SMTP_PORT=587"
  echo "EMAIL_SMTP_SECURE=false"
  echo "EMAIL_FROM_NAME=<agent display name>"
} >> .env
unset EMAIL_PASSWORD
```

`EMAIL_SMTP_SECURE=false` with port 587 means STARTTLS, which is what nearly
every provider wants. Use `true` with port 465 only for implicit TLS.

Optional keys, all with sane defaults: `EMAIL_USER` (login, when it differs
from the address), `EMAIL_MAILBOX` (default `INBOX`),
`EMAIL_POLL_INTERVAL_MS` (default 60000 — the adapter also uses IMAP IDLE, so
this is only the fallback), and the six attachment limits below.

These credentials stay in the **host** process. They are never passed into an
agent container: IMAP and SMTP aren't HTTP, so the OneCLI gateway can't inject
them per request, and the agent doesn't need them — it reads mail as ordinary
chat messages. Do not add them to any container config.

### 3. Restart the service

Resolve the unit name rather than assuming it:

```bash
systemctl --user list-units --type=service 'nanoclaw*' --no-legend   # Linux
```

then restart that unit (macOS: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`).
Confirm the adapter came up:

```bash
grep -i 'email' logs/nanoclaw.log | tail -20
```

A missing or wrong credential makes the factory return `null` and log
`Email: credentials incomplete, skipping channel` — the host starts normally
without the channel. An unreachable IMAP host is retried three times before
the channel is dropped for this process lifetime.

### 4. Allow the first correspondent

Nothing can be sent or received until an address is wired. One command per
person, in both directions at once:

```bash
pnpm exec tsx scripts/email-allow.ts add someone@example.org --name "Their Name"
pnpm exec tsx scripts/email-allow.ts list
pnpm exec tsx scripts/email-allow.ts remove someone@example.org
```

**The two directions are separate decisions.** "May write to the agent" and
"the agent may write to them" are not the same permission, and an asymmetric
setup is the normal case — several people may report in, while the agent only
ever answers to one address:

```bash
pnpm exec tsx scripts/email-allow.ts add kollege@example.org  --direction in
pnpm exec tsx scripts/email-allow.ts add report@example.org   --direction out
pnpm exec tsx scripts/email-allow.ts remove alt@example.org   --direction out
```

`--direction` defaults to `both`, and `add` is declarative rather than
additive: re-running it with a narrower direction closes the other half. A
wrong entry is therefore fixable in place, which matters on a surface where
being wrong means mail reaching someone it shouldn't.

Add `--group <id-or-name>` when the install has more than one agent group.

Each address gets a user row, a messaging group (strict, DM) and a wiring; the
membership row is the inbound gate and the `agent_destinations` row the
outbound one, which is why the two can be set independently. Everything is
idempotent, so re-running repairs a half-configured address, and destinations
are projected into any running container so a fresh recipient works
immediately rather than after the next wake.

### 5. Verify

Run the unit tests, then the live suite — it exercises both allowlist
directions, attachments both ways, both size refusals and the loop guard
against a real local mail server, without touching your mailbox:

```bash
pnpm exec vitest run src/channels/email
bash scripts/greenmail.sh up
pnpm test:email-live
bash scripts/greenmail.sh down
```

Then confirm the real mailbox works end to end:

- Mail from the allowed address → the agent answers.
- Mail from an address you did **not** allow → no answer, no new
  `messaging_groups` row, and a `sender not on inbound allowlist, dropped`
  line in `logs/nanoclaw.log`.
- Ask the agent to mail the allowed address → arrives, threaded onto the
  previous mail.
- Ask it to mail some other address → nothing is sent,
  `messages_out.status='failed'`, and `unauthorized channel destination` or
  `recipient not on outbound allowlist` in `logs/nanoclaw.error.log`.

## How the allowlist works

There is no allowlist table. An address is allowed because it is wired exactly
like any other chat, and the existing enforcement does the work:

- **Inbound** — the messaging group is created with
  `unknown_sender_policy='strict'`, and the `agent_group_members` row is what
  `canAccessAgentGroup` checks. The adapter additionally checks the same rows
  before handing the mail to the router, so a stranger's mail never becomes a
  NanoClaw message at all (no messaging group, no `unregistered_senders` row
  filling up with spam).
- **Outbound** — `src/delivery.ts` re-validates every send against
  `agent_destinations` in the central DB and throws when there is no row. The
  adapter checks again immediately before SMTP.

Both directions fail closed. See `src/channels/email-allowlist.ts`.

## Attachment limits

Enforced in the adapter, overridable in `.env`:

| Key | Default |
|---|---|
| `EMAIL_MAX_OUTBOUND_FILE_BYTES` | 10 MiB |
| `EMAIL_MAX_OUTBOUND_TOTAL_BYTES` | 20 MiB |
| `EMAIL_MAX_OUTBOUND_FILE_COUNT` | 10 |
| `EMAIL_MAX_INBOUND_FILE_BYTES` | 10 MiB |
| `EMAIL_MAX_INBOUND_TOTAL_BYTES` | 20 MiB |
| `EMAIL_MAX_INBOUND_FILE_COUNT` | 20 |

A junk value (`0`, `unlimited`, `10MB`) falls back to the default rather than
disabling the limit. Outbound breaches fail the **whole** message — a mail
whose attachment was silently dropped is worse than one that never arrived.
Inbound breaches skip the part and leave an `[attachment omitted: …]` note in
the message text.

Defaults sit below the ~25 MB most providers accept *after* base64 encoding
(+37% overhead). Raise them only if you know your provider's real limit.

The `email-formatting` container skill tells the agent these numbers so it
checks file sizes before attaching instead of discovering the limit by
failing.

## First-run behaviour

On the first scan the adapter records the mailbox's current end position and
processes **nothing** — a fresh install does not answer years of archived
mail. Only mail arriving after that point is seen. The same happens if the
server renumbers the mailbox (`uidValidity` change). The watermark lives in
`data/email-state.json`, alongside the per-correspondent threading state.

Delete that file to make the adapter re-baseline; there is no way to make it
walk backwards through history.

## Channel Info

- **type**: `email`
- **platform-id-format**: `email:<address>`, lowercase (e.g.
  `email:freund@example.org`). One correspondent = one messaging group.
- **user-id-format**: the same string — the address is the identity.
- **supports-threads**: no. RFC 5322 threading is reproduced with
  `In-Reply-To`/`References` so replies land in the right thread in the other
  person's mail client, but the router does not treat it as a thread axis.
- **default-isolation**: one agent group per mailbox. Several correspondents
  can share one agent group (each gets its own session under the default
  `shared` session mode).
- **unknown senders**: `strict` — dropped, never escalated into an approval
  card. A mailbox is a personal identity, not a public room.

### Features

- Plain-text and HTML mail (HTML is converted to text).
- Quoted history and signatures are stripped from replies.
- Attachments both directions, within the limits above.
- Loop protection: mail from our own address, and anything marked
  `Auto-Submitted`, `Precedence: bulk|list|junk`, `List-Id`,
  `List-Unsubscribe`, or `X-Auto-Response-Suppress`, is ignored. This is
  checked *before* the allowlist, because the loop risk comes precisely from
  an allowed correspondent's own out-of-office responder.
- Inline images referenced from HTML (signature logos) are dropped rather than
  delivered as attachments.

Not supported: several recipients per message, CC/BCC (exactly one recipient,
by design — the agent cannot smuggle extra recipients into a mail), mailing
lists, PGP/S-MIME, and read receipts.

### Diagnostic notices are suppressed here

If `show_token_usage` or `log_subagents` is on for the agent group, the
container emits "📊 Tokens: …" / "🔎 Subagent: …" lines after a turn. On chat
channels they arrive as an extra message; on email they would be an extra
*mail* each, and a mail to a correspondent who isn't the operator would carry
the install's model choice and running cost. The email adapter therefore
declares `deliversNotices: false` and the host drops those rows before they
reach SMTP. Chat channels are unaffected — the same turn still shows them on
Matrix, CLI, and anywhere else.

## Removing the channel

Remove the `EMAIL_*` keys from `.env` and restart: the factory returns `null`
and the channel is simply absent. The wirings survive, so re-adding the
credentials restores the previous allowlist. To clear the allowlist too, run
`scripts/email-allow.ts remove` for each address.
