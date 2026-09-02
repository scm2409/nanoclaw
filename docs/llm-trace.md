# LLM wire trace

An opt-in, per-agent-group recorder for everything that goes over the wire
between the Claude Code CLI and the model endpoint. Off by default.

```bash
ncl groups config update --id <group-id> --llm-trace true
ncl groups restart --id <group-id>          # the proxy starts with the runner
```

Records land in the session directory, one file per UTC day:

```
data/v2-sessions/<agent-group>/<session>/llm-trace/<YYYY-MM-DD>.jsonl
```

Turn it off the same way (`--llm-trace false`). Files older than 7 days are
deleted when a traced container starts.

## Why it exists

The session transcripts under `.claude-shared/projects/` show the
*conversation* — messages, tool results, and a per-message `usage`. They do not
show what was actually sent, and the SDK drops fields on the way back. Three
things only the wire has:

- **The composed prompt.** System prompt, the appended standing instructions,
  and every tool schema — the fixed prefix that rides along on every single
  call. Measuring it any other way is arithmetic on guesses.
- **Cache-breakpoint placement.** Where `cache_control` actually landed, and
  therefore why `cache_read_input_tokens` does or does not grow across a
  multi-step tool loop.
- **Provider fields the Anthropic-compatible shim discards.** On OpenRouter
  that includes `usage.cost` (the real charge for the call) and
  `usage.output_tokens_details.thinking_tokens` (reasoning tokens, billed at
  the output rate). Neither reaches the transcript.

## How it is wired

```
claude CLI ──http──▶ trace proxy ──https──▶ [OneCLI gateway] ──▶ provider
           (127.0.0.1)   (in-container)
```

The runner starts the proxy before it creates the provider, points
`ANTHROPIC_BASE_URL` at it, and adds the loopback hosts to `NO_PROXY`. That
last part is load-bearing: the container runs with `HTTP(S)_PROXY` set to the
OneCLI gateway and `NODE_USE_ENV_PROXY=1`, so without it the CLI's hop to
`127.0.0.1` is dialled *from the host* by the gateway and resets.

Credentials are untouched. The CLI sends `Authorization: Bearer placeholder`;
the gateway on the outbound leg swaps in the real token, exactly as it does
without the proxy. The proxy never holds one — and redacts
`authorization`, `x-api-key`, `cookie` and friends before writing a record.

A failure to start is logged and skipped: the agent runs untraced rather than
not at all.

## Record shape

One JSON object per exchange:

| Field | Meaning |
|---|---|
| `ts`, `id`, `duration_ms` | When the request started, a per-process id, wall time to the last response byte |
| `method`, `path` | e.g. `POST`, `/v1/messages?beta=true` |
| `request.headers` | Redacted |
| `request.body` | Parsed JSON — the whole prompt, tools included |
| `request.bytes`, `request.truncated` | Full size, and whether the record holds all of it |
| `response.status`, `response.headers` | Redacted headers |
| `response.body` / `response.sse` | Parsed JSON, or the raw event stream for a streamed call |
| `response.model`, `response.stop_reason`, `response.usage` | Lifted out of either shape so a reader needs no branch |
| `response.bytes`, `response.truncated` | As above |
| `error` | Present instead of a response when the upstream call failed (the client gets a 502) |

Bodies past 4 MiB are recorded truncated as `body_text`, flagged with
`truncated: true`. The client always gets the full body — truncation only ever
affects the record.

## Cost of the trace itself

Nothing at the API level: the proxy adds one local hop and no tokens. On disk
it is roughly the size of the traffic — a busy agent group can write hundreds
of MB a day, since every step of a tool loop re-sends the whole conversation
and the trace keeps each copy. Turn it on to answer a question, then turn it
off.

## Privacy

A record holds the full conversation in plain text: user messages, tool
results, file contents the agent read. That is the point, and it is why the
flag is per-group and defaults to off. Treat the files like the session DBs
they sit next to.
