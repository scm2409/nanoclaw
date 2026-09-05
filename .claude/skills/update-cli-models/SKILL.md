---
name: update-cli-models
description: Re-pick the models behind claude_openrouter.py — the wrapper that runs your own interactive Claude Code sessions on non-Anthropic models — prove they cache, and make the caching actually pay off. Use when a CLI session feels expensive or slow, when a new model appears, or on a periodic review. For NanoClaw's agents use /update-agent-models instead.
---

# Update the CLI's models

`claude_openrouter.py` in the repo root runs **your own** Claude Code sessions
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
grep -E '^export (ANTHROPIC_|CLAUDE_CODE_)' claude_openrouter.py
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

**Expect this number to differ from the wrapper's, and trust the wrapper's.**
`provider-tiers.py` pins the exact cheapest price and takes whatever window that
endpoint has; the wrapper takes a 10% price band and then drops endpoints
serving less than half the band's best window, precisely so one cramped
endpoint cannot drag the whole session's compaction threshold down. On
`z-ai/glm-5.3` that is the difference between 262,144 and 1,048,576 tokens. Only
export the values above if the wrapper failed to resolve tiers at all — a value
you export wins over the one it derives (`env.setdefault`), so a stale export
caps the session for no reason.

## 2. Pull the benchmark data

```bash
bash .claude/skills/update-cli-models/scripts/fetch-benchmarks.sh /tmp/cli-review
python3 .claude/skills/update-cli-models/scripts/select-models.py \
  /tmp/cli-review --baseline <current-model-for-this-slot> --inventory
```

Three surfaces land in the work directory, none a superset of another:

| File | Source | What only it has |
|---|---|---|
| `models.json` | OpenRouter `/api/v1/models` | Authoritative pricing, the design-arena Elos, `benchmarks.artificial_analysis` for ~180 models |
| `bench.json` | OpenRouter `/api/v1/benchmarks` (auth, via container) | tau-bench, GPQA, the search suite |
| `aa.json` | artificialanalysis.ai leaderboard (no auth) | **Cost per indexed task**, time per task, and one row per reasoning-effort level |

The third is the one that answers "what does an actual task cost here". The
catalogue prices a token; a reasoning model's bill is decided by how many tokens
it spends thinking, which the price list cannot show. Two models at the same
$/M differ by 3x per task — `gpt-5.6-sol (medium)` costs $0.367 a task,
`(max)` $1.249, same id and same price list.

Its numbers are namespaced `aa:` in `--inventory` so they never silently
overwrite the catalogue's flattened figures; where both exist, disagreement
between them is worth a look rather than an average.

Two caveats the script prints for itself: cost-per-task exists for ~50 rows (the
current frontier, not the long tail), and the leaderboard is parsed out of the
page's own data payload, so a site redesign breaks the fetch loudly rather than
returning a short list.

## 3. Rank each slot on quality *and* measured cost

```bash
python3 .claude/skills/update-cli-models/scripts/select-models.py \
  /tmp/cli-review --score fable --min-metric 50 --baseline <slot's current model>
```

`--score` ranks every (model, effort) pair for one slot:

    score = quality_norm - weight_cost * log10(cost_per_task)_norm

Cost is normalized in log space because the field spans three orders of
magnitude; on a linear scale the cheapest model wins every slot by arithmetic
alone. The weights encode how often the slot runs and how much its output
matters:

| Slot | Metric | Cost weight | Reasoning |
|---|---|---|---|
| `main` / `sonnet` | `agentic_index` | 1.0 | Runs all session and re-sends the whole prompt each turn; cost weighs as heavily as capability |
| `opus` / subagent | `coding_index` | 0.6 | Delegated work arrives complete; raw ability carries it, and it runs less often |
| `haiku` | `agentic_index` | 2.0 | Highest-frequency, lowest-stakes slot — cheap beats clever |
| `fable` | `intelligence_index` | 0.35 | The escalation slot: allowed to be expensive, not allowed to be pointless |

`--metric <name>` scores any metric from the merged table instead of the slot's
default, so the main slot can be ranked on `arena:agents:fullstack` — the
head-to-head that step 4 calls for — and still priced on cost-per-task. Only
AA's own indices are per-effort; anything else is one figure per model, ranked
once and priced at its cheapest measured variant, and the table says which case
it is in.

**Always pair a low cost weight with `--min-metric`.** A quality-minus-cost
ranking with a light cost weight still floats cheap mid-tier models into the top
of the escalation slot, because a small quality deficit is bought off by a large
price gap. The floor is what makes the slot mean anything: for `fable`, 50 on
the AA intelligence index is the current frontier's edge.

Two vendor classes are excluded by default and the script says so in its header
line: `google/*` (their cache bills above uncached list price through this
gateway — `references/why-caching-gates-this.md`) and `anthropic/*` (the models
this wrapper exists to replace; `--include-anthropic` ranks them anyway, which
is the honest way to see what the substitution costs).

**Effort is a request parameter, not a model id.** All of `meta/muse-spark-1.3`'s
rows are one endpoint; AA scores them separately because the effort level moves
both the score and the bill. The wrapper sets effort per session
(`claude --effort`, `DEFAULT_EFFORT`), not per slot, so a pick validated at one
effort is a claim about that effort only — record which one.

## 4. Choose per slot — the requirements differ from the agents'

`--score` above already ranks each slot on the AA surface. This table is the
cross-check: the head-to-head arena Elos live only in the catalogue, and for a
coding harness a head-to-head beats a static index.

This is a **coding** harness, so the metrics differ from the chat agents':

| Slot | Metric | Why |
|---|---|---|
| `ANTHROPIC_MODEL` / `sonnet` | `arena:agents:fullstack`, then `agentic_index` | It reads files, runs commands and drives subagents. Head-to-head agentic coding beats a static index for this. |
| `opus` / `CLAUDE_CODE_SUBAGENT_MODEL` | `coding_index`, cross-check `intelligence_index` | Delegated work arrives as a complete task with no conversation around it, so raw capability carries it. |
| `haiku` | `agentic_index` at the lowest price that clears it | Small internal calls. Cheap matters more than clever; it is the highest-frequency slot. |
| `fable` | `intelligence_index` | The escalation slot. Allowed to be expensive; that is its job. |

Three rules that are not negotiable here:

- **Keep the slot count of distinct models low.** Every additional model is
  another entry in the provider union (step 6) and another thing to re-validate.
  Two or three distinct models across five slots is a good shape.
- **Every model must clear the cache gate in step 5.** A model that wins its
  benchmark and does not cache is not a candidate; over 99% of a turn is prompt.

- **A pick must win on both surfaces or the disagreement must be explained.** A
  model that tops `--score` and sits mid-field on `arena:agents:fullstack` is
  cheap at reasoning, not good at driving a repo.

Run the selection per slot with that slot's current model as the baseline:

```bash
python3 .claude/skills/update-cli-models/scripts/select-models.py \
  /tmp/cli-review --baseline <slot's current model> --usecases /tmp/cli-review/usecases.json
```

## 5. Prove every candidate caches

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

## 6. Update the model list

The wrapper carries one `MODELS` dict near the top. Edit it; there is nothing
else to wire, because the wrapper already does at every launch what an operator
would otherwise have to remember:

- resolves each model's cheapest healthy provider band and sends it as
  `provider.only` — the union over **every** model, since a list omitting one is
  a 404 for that model and `allow_fallbacks` does not rescue it, and no provider
  field at all if any model fails to resolve;
- sets an `x-session-id` keyed to the working directory, pinning one endpoint
  inside that band;
- reads the smallest context window the band actually offers and states it, so
  the CLI stops assuming 200k and compacting far too early.

None of that is cached: a day-old tier is a day-old price, and the lookup costs
a few hundred milliseconds against a public endpoint.

Check what a launch would do without spending anything:

```bash
NO_SUMMARY=1 ./claude_openrouter.py --print "ok"
```

The first two lines name the providers it picked and the window it derived.

**Verify the union serves every model** before trusting a new pick — this is the
failure that only shows up mid-session:

```bash
C=$(docker ps --format '{{.Names}}' | grep -m1 nanoclaw)
docker exec -e NO_PROXY=127.0.0.1,localhost,::1 "$C" sh -c \
  'for m in <model-1> <model-2> <model-3>; do
     curl -sS -o /dev/null -w "$m %{http_code}\n" -X POST "$ANTHROPIC_BASE_URL/v1/messages" \
       -H "authorization: Bearer $ANTHROPIC_AUTH_TOKEN" -H "anthropic-version: 2023-06-01" \
       -H "content-type: application/json" \
       -d "{\"model\":\"$m\",\"max_tokens\":32,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"provider\":{\"only\":[<the slugs>],\"allow_fallbacks\":true}}"
   done'
```

Anything but `200` means that model is not served by the union — with one
routing-unrelated exception: some providers reject a tiny `max_tokens` outright
(Meta wants `>= 16`) and answer `400` from inside the request they did accept.
Read the body before concluding anything; a real union miss says so in the
message.

## 7. Measure

The wrapper prints a per-model token breakdown and two cost figures when the
session ends: a price-table estimate, and what the gateway actually billed
(from the delta on its cumulative counter). Run a representative piece of work
before and after a change and compare like with like.

Watch for the two figures diverging by more than 30% — the wrapper says so. The
estimate assumes the catalogue's cache rates, so a large gap means caching is
not behaving the way the price list implies. That divergence is exactly how the
Gemini problem in `references/why-caching-gates-this.md` was found.

`NO_SUMMARY=1` skips the report; the token breakdown comes from the CLI's own
transcript under `~/.claude/projects/`, so it needs no gateway access.

## 8. Write it down

`FORK-CHANGELOG.md` — the wrapper is tracked, so the change belongs there.
Record what was measured, not only what was chosen: the cache-gate result per
model and the before/after spend. A future reader needs to know the pick was
validated, not guessed.

## Integration points

This skill edits one dict in a self-contained Python script and reads three
public HTTP surfaces (two OpenRouter APIs and one HTML page). It makes no reach-in into NanoClaw source and adds no dependency, so
it owes no integration test (`docs/skill-guidelines.md`, "When there is
genuinely nothing to test in-tree"). Its verification is steps 5, 6 and 7, each
of which produces numbers that are absent or wrong if the workflow was skipped.

The wrapper itself is standalone too: one file, Python standard library only, no
state on disk, and no reference back to this skill or this repository. The skill
maintains its `MODELS` dict; the wrapper never needs the skill to be present.

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

**The wrapper says it left routing to the gateway.** It could not resolve every
model's provider tier and refused to send a partial union. Re-run once, since a
transient lookup failure looks the same. Check the ids in `MODELS` are
`vendor/model`, not harness aliases like `sonnet`.

**The wrapper is slow to start.** It resolves provider tiers on every launch,
one HTTP call per distinct model, in parallel. A slow gateway shows up here.
That is the deliberate trade for never serving a stale price.

**A candidate returns `18+ age confirmation` on every probe turn.** Some
OpenRouter models are gated behind an account-level setting; the gateway cannot
answer it and every request fails identically until it is set at
<https://openrouter.ai/settings/preferences> on the account whose key OneCLI
holds. The cache gate cannot be run before that, so the model is not adoptable —
not because it failed, but because it was never measured.

**`fetch-artificialanalysis.py` exits with "parsed only N models".** The
leaderboard's data payload changed shape. That is a parser fix, not a retry: the
script refuses a partial list on purpose, because a selection built on whichever
few rows survived a layout change looks exactly like a valid one.

**Spend looks unchanged after the switch.** Check the wrapper's first two lines:
if it names no providers, the pin was skipped. If the session summary's two cost
figures are far apart, caching is not doing what the price list implies.
