---
name: update-cli-models
description: Re-pick the models behind claude_openrouter.sh — the wrapper that runs your own interactive Claude Code sessions on non-Anthropic models — prove they cache, and make the caching actually pay off. Use when a CLI session feels expensive or slow, when a new model appears, or on a periodic review. For NanoClaw's agents use /update-agent-models instead.
---

# Update the CLI's models

`claude_openrouter.sh` in the repo root runs **your own** Claude Code sessions
against OpenRouter instead of Anthropic. This skill re-picks the models it
targets, proves they cache, and adds the two things that decide whether that
caching is worth anything.

**Not the same as `/update-agent-models`.** That one covers NanoClaw's agent
containers: different models, different metrics, different verification. This
one covers the interactive CLI you type into. They share the probe scripts and
nothing else.

Work in a git worktree; the wrapper is a tracked file.

## Can caching even work here? Yes — measured

Same CLI, same request shape as the agents, so the same two failure modes and
the same two fixes. Every model the wrapper currently targets passes the cache
gate:

| Model | slot | cold | warm |
|---|---|---|---|
| `z-ai/glm-5.3-flash` | haiku alias | $0.075/M | **$0.015/M** |
| `openai/gpt-5.6-luna` | sonnet alias, main | — | **$0.097/M** |
| `z-ai/glm-5.3` | opus alias, subagents | $1.400/M | **$0.143/M** |
| `openai/gpt-5.6-sol` | fable alias | — | **$0.967/M** |

The one family that does **not** work is Gemini through OpenRouter: it returns
`cache_read == cache_creation` and bills above its own uncached list price. Do
not put a Gemini model in any slot here. The reasoning and the numbers are in
`references/why-caching-gates-this.md`.

Caching matters more here than for a chat agent, not less: a coding session's
prompt carries file contents and tool results, and all of it is re-sent every
turn.

## 1. Read what the wrapper targets now

```bash
grep -E '^export (ANTHROPIC_|CLAUDE_CODE_)' claude_openrouter.sh
```

Five slots decide everything, and one env applies to all of them:

| Variable | What uses it |
|---|---|
| `ANTHROPIC_MODEL` | new sessions, the model you actually talk to |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | anything addressing `sonnet` |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | anything addressing `opus` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `ANTHROPIC_SMALL_FAST_MODEL` work, cheap internal calls |
| `ANTHROPIC_DEFAULT_FABLE_MODEL` | anything addressing `fable` |
| `CLAUDE_CODE_SUBAGENT_MODEL` | subagents with no model of their own |

Note whether `--effort` is pinned in the `exec` line. `max` on every session is
a real cost lever, and unlike an agent executor a coding session sometimes
earns it — decide, do not inherit.

**Also check the context window.** Claude Code never learns the window of a
model behind an Anthropic-compatible endpoint; it assumes 200k, says so on
startup, and auto-compacts far too early. Compacting early is exactly the wrong
direction, because every token below the threshold is re-paid on every turn.
Set both to the **smallest** window among the endpoints the session can reach —
one value applies to every model:

```bash
python3 .claude/skills/update-cli-models/scripts/provider-tiers.py --context <model> [more models...]
export CLAUDE_CODE_MAX_CONTEXT_TOKENS=<that minimum>
export CLAUDE_CODE_AUTO_COMPACT_WINDOW=<that minimum>
```

The minimum, not the largest: a model whose real window is smaller will simply
fail once the session passes it. And the window depends on the *pinned*
providers, not on the model in general — the same model is served with wildly
different windows by different endpoints.

## 2. Pull the benchmark data

Reuse the sibling skill's fetcher; there is no second copy to keep in sync.

```bash
bash .claude/skills/update-cli-models/scripts/fetch-benchmarks.sh /tmp/cli-review
python3 .claude/skills/update-cli-models/scripts/select-models.py \
  /tmp/cli-review --baseline <current-model-for-this-slot> --inventory
```

## 3. Choose per slot — the requirements differ from the agents'

This is a **coding** harness, so the metrics differ from the chat agents':

| Slot | Metric | Why |
|---|---|---|
| `ANTHROPIC_MODEL` / `sonnet` | `arena:agents:fullstack`, then `agentic_index` | It reads files, runs commands and drives subagents. Head-to-head agentic coding beats a static index for this. |
| `opus` / `CLAUDE_CODE_SUBAGENT_MODEL` | `coding_index`, cross-check `intelligence_index` | Delegated work arrives as a complete task with no conversation around it, so raw capability carries it. |
| `haiku` | `agentic_index` at the lowest price that clears it | Small internal calls. Cheap matters more than clever; it is the highest-frequency slot. |
| `fable` | `intelligence_index` | The escalation slot. Allowed to be expensive; that is its job. |

Two rules that are not negotiable here:

- **Keep the slot count of distinct models low.** Every additional model is
  another entry in the provider union (step 5) and another thing to re-validate.
  Two or three distinct models across five slots is a good shape.
- **Every model must clear the cache gate in step 4.** A model that wins its
  benchmark and does not cache is not a candidate; over 99% of a turn is prompt.

Run the selection per slot with that slot's current model as the baseline:

```bash
python3 .claude/skills/update-cli-models/scripts/select-models.py \
  /tmp/cli-review --baseline <slot's current model> --usecases /tmp/cli-review/usecases.json
```

## 4. Prove every candidate caches

```bash
C=$(docker ps --format '{{.Names}}' | grep -m1 nanoclaw)
docker cp .claude/skills/update-cli-models/scripts/cache-probe.ts "$C":/tmp/cache-probe.ts
docker exec -e NO_PROXY=127.0.0.1,localhost,::1 "$C" \
  bun /tmp/cache-probe.ts <candidate-1> <candidate-2> ...
```

It needs a running agent container only to borrow the gateway's credential
injection on the outbound leg — no key is handled. Reject anything that does
not read its prefix back at a discount; reject outright the signature
`read == write == the whole prompt` at or above list input price.

## 5. Wire the two fixes into the wrapper

Without these, the caching you just validated mostly does not happen — the
gateway routes to a different endpoint next turn and the warm cache is
somewhere else. Add one line before the `exec`:

```bash
eval "$(python3 "$(dirname "$0")/.claude/skills/update-cli-models/scripts/openrouter-env.py" \
  "$ANTHROPIC_MODEL" \
  "$ANTHROPIC_DEFAULT_SONNET_MODEL" \
  "$ANTHROPIC_DEFAULT_OPUS_MODEL" \
  "$ANTHROPIC_DEFAULT_HAIKU_MODEL" \
  "$ANTHROPIC_DEFAULT_FABLE_MODEL" \
  "$CLAUDE_CODE_SUBAGENT_MODEL")"
```

and pass the two variables through the `exec ... env` list alongside the
others:

```bash
  ANTHROPIC_CUSTOM_HEADERS="${ANTHROPIC_CUSTOM_HEADERS:-}" \
  CLAUDE_CODE_EXTRA_BODY="${CLAUDE_CODE_EXTRA_BODY:-}" \
```

What that emits:

- **`CLAUDE_CODE_EXTRA_BODY`** — a `provider.only` union over the cheapest
  endpoint tier of **every** slot's model. The CLI merges the JSON into the
  request body, so nothing rewrites a request. **Pass every model id**: a union
  missing one is a 404 for that model, and `allow_fallbacks: true` does not
  rescue it. The script emits nothing at all rather than a partial union.
- **`ANTHROPIC_CUSTOM_HEADERS`** — an `x-session-id` derived from the working
  directory, so all sessions in one checkout share a warm tools+system prefix.
  Override the scope with `CLAUDE_OPENROUTER_SESSION_SCOPE` if a different
  grouping suits you better.

Provider tiers are cached for a day under `~/.cache/claude-openrouter/`, so the
wrapper starts in milliseconds after the first run. Both variables are left
untouched if you already set them yourself.

Verify what actually goes out, without spending anything:

```bash
eval "$(python3 .claude/skills/update-cli-models/scripts/openrouter-env.py <your model ids>)"
echo "$CLAUDE_CODE_EXTRA_BODY"; echo "$ANTHROPIC_CUSTOM_HEADERS"
```

## 6. Measure before and after

There is no wire trace for the standalone CLI, so use the gateway's own
cumulative counter:

```bash
bash .claude/skills/update-cli-models/scripts/spend-delta.sh mark
./claude_openrouter.sh          # do a representative piece of work, then exit
bash .claude/skills/update-cli-models/scripts/spend-delta.sh diff
```

Compare like with like: the same task, roughly the same number of turns.
Nothing else may use the key in between, or the delta absorbs it.

## 7. Write it down

`FORK-CHANGELOG.md` — the wrapper is tracked, so the change belongs there.
Record what was measured, not only what was chosen: the cache-gate result per
model and the before/after spend. A future reader needs to know the pick was
validated, not guessed.

## Integration points

This skill changes one tracked shell script and reads two public HTTP APIs. It
makes no reach-in into NanoClaw source and adds no dependency, so it owes no
integration test (`docs/skill-guidelines.md`, "When there is genuinely nothing
to test in-tree"). Its verification is steps 4 and 6, both of which produce
numbers that are absent or wrong if the workflow was skipped.

**This skill is deliberately standalone.** It carries its own copy of the
probes and references that `/update-agent-models` also has, rather than
reaching across to them. It lives in this repo by circumstance — the wrapper it
maintains is a personal tool, not a NanoClaw component — and is expected to move
out. A skill that reaches into a sibling cannot travel. When a probe changes in
one, port it deliberately; the duplication is the price of being movable, and
the alternative is a skill that breaks the day it is copied elsewhere.

Its only dependencies are `python3`, `curl`, `docker` (to borrow gateway
credentials for the probes), and `bun` inside that container.

## Troubleshooting

**`openrouter-env.py` prints only the header.** It could not resolve every
model's tier and refused to emit a partial union. Its stderr names the reason;
re-run once, since a transient lookup failure looks the same. Check the model
ids are `vendor/model`, not harness aliases like `sonnet`.

**A model 404s with "No allowed providers are available".** A `provider.only`
reached it that lists nobody serving it — a model id was left out of the
`openrouter-env.py` arguments. Add it and re-run; the error message lists the
model's real provider slugs.

**The wrapper got slow to start.** The tier cache is missing or unwritable;
check `~/.cache/claude-openrouter/`. It re-fetches four endpoint listings when
cold.

**Spend looks unchanged after the switch.** Confirm the variables actually
reach the CLI: `grep -c ANTHROPIC_CUSTOM_HEADERS claude_openrouter.sh` should
find them in both the `eval` block and the `exec ... env` list. Passing them
through the `env` list is the step most easily forgotten.
