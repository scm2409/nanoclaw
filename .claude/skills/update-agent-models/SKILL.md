---
name: update-agent-models
description: Re-pick the LLM behind each agent and subagent from current benchmark data, prove the candidates actually cache, then apply and measure the change. Use when models feel expensive or outdated, when a new model appears, after a provider changes pricing, or on a periodic review.
---

# Update agent models

Nine steps: measure what you have, pull the benchmark data, map each agent to
the metric that matches its job, shortlist, **prove the shortlist caches**,
apply, verify against the trace, test the risky executors for real, and write
it down.

The gate is step 5. A model that wins every benchmark and does not cache is not
a candidate — over 99% of an agent turn's bill is prompt, re-sent whole every
turn, so the cache rate decides the cost by an order of magnitude and list
price barely matters. See `references/why-caching-gates-this.md` for the
measurements behind that.

Work in a git worktree; the changes touch tracked files.

## 1. Establish the baseline

You cannot report an improvement without a before. Turn the wire trace on for
the group if it is off, run a couple of ordinary turns, and read the cost:

```bash
ncl groups config get --id <group-id>          # note model, effort, llm_trace
ncl groups config update --id <group-id> --llm-trace true --llm-trace-keep-days 3
ncl groups restart --id <group-id>
pnpm run chat "kurzer Test, bitte nur bestaetigen"
pnpm exec python3 .claude/skills/update-agent-models/scripts/trace-cost.py <group-id>
```

Record cost per turn, prompt tokens, and the cached share. Keep the numbers:
step 7 compares against them.

Then read the agent roster — the subagents are most of the spend:

```bash
grep -H "^model:\|^effort:\|^description:" groups/<folder>/.claude/agents/*.md
```

**Note which subagents declare no `effort:`.** They inherit the group's, and if
the group is on `max` then a subagent whose whole job is to call one tool and
report back is running maximum reasoning on every call. That is usually the
cheapest thing to fix in this whole workflow.

## 2. Pull both benchmark surfaces

```bash
bash .claude/skills/update-agent-models/scripts/fetch-benchmarks.sh /tmp/model-review
```

Two endpoints, and **neither is a superset of the other**:

- `/api/v1/models` — the catalogue, plus `benchmarks.artificial_analysis` for
  more models than the other surface has, plus the `agents` design-arena, which
  the other surface omits entirely. Public. Also the authoritative pricing.
- `/api/v1/benchmarks` — OpenRouter's own runs, and the **only** source for
  `tau_bench_verified_airline`, `gpqa_diamond` and the search suite. Needs
  auth, so the script fetches it from inside a running agent container where
  the OneCLI gateway supplies the credential.

Merged, that is ~34 metrics. Building on one alone silently shortens the
candidate field.

## 3. Map each agent to the metric that matches its job

```bash
python3 .claude/skills/update-agent-models/scripts/select-models.py \
  /tmp/model-review --baseline <current-or-reference-model> --inventory
```

This prints every metric, how many models are scored on it, and the baseline's
score. Pick per agent from what its *description* says it does, not from what
it is called. `references/benchmarks.md` explains what each metric measures and
which agent shape it fits.

Copy `scripts/usecases.example.json`, adjust it to this install's roster, and
keep the `why` fields honest — they are what a reviewer checks.

The choice that matters most: an **orchestrator** (decides which subagent or
tool to call) is judged on `agentic_index`; an **executor** (already told what
to do, must drive an API correctly) is judged on `tau_bench_verified_airline`.
Those two rankings differ sharply, and picking the wrong one moves the answer.

## 4. Shortlist

```bash
python3 .claude/skills/update-agent-models/scripts/select-models.py \
  /tmp/model-review --baseline <baseline-model> --usecases /tmp/model-review/usecases.json
```

The rule: **at least as good on the metric, and no more expensive**, on both
prompt and completion price. Cheaper is better when the score holds.
`:batch` (not usable interactively) and `:free` (rate limits, training-data
terms) variants are excluded.

When nothing qualifies, the script prints the cheaper near misses with their
gap. Do not quietly relax the rule — say that nothing qualified, put the
trade in front of the user (a −1.9 gap for a 25× price cut is a real option; a
−7.3 gap on an executor's own metric is a real risk), and let them choose.

Prefer **few models over optimal ones**. Each additional model is another thing
to re-validate on every future run of this skill.

## 5. Prove the shortlist caches — the gate

```bash
C=$(docker ps --format '{{.Names}}' | grep -m1 nanoclaw)
docker cp .claude/skills/update-agent-models/scripts/cache-probe.ts "$C":/tmp/cache-probe.ts
docker exec -e NO_PROXY=127.0.0.1,localhost,::1 "$C" \
  bun /tmp/cache-probe.ts <candidate-1> <candidate-2> ...
```

It sends the request shape the CLI really sends — trailing `cache_control` on
the newest message included — three turns per model, and reports the effective
rate per turn.

**Reject a candidate whose warm turns are not clearly cheaper than its cold
turn.** The disqualifying signature is `read == write == the whole prompt` on
every turn, at a rate at or above the model's list input price: a cache being
rewritten and never read, costing *more* than no cache at all. It happens, it
is per-upstream, and no benchmark will warn you.

Also probe the incumbent. If it fails, that alone can justify the switch
regardless of scores.

Then, for any candidate served by many provider endpoints, check routing
stability:

```bash
docker cp .claude/skills/update-agent-models/scripts/sticky-probe.ts "$C":/tmp/sticky-probe.ts
docker exec -e NO_PROXY=127.0.0.1,localhost,::1 "$C" bun /tmp/sticky-probe.ts <candidate>
curl -s "https://openrouter.ai/api/v1/models/<candidate>/endpoints" | \
  python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]; print(len(d["endpoints"]), "endpoints")'
```

Rate excursions on some turns mean routing landed on a pricier endpoint. Read
the probe for the size of that spread, not as a verdict on the id scheme: a
session id sticks to whatever endpoint it first lands on, so run-to-run
variance exceeds the difference between its arms.

NanoClaw bounds this from two sides, and both are already wired:

- `stickySessionEnv` sends an `x-session-id` header, holding **one endpoint**.
- `providerPinEnv` sends `provider.only` via `CLAUDE_CODE_EXTRA_BODY`, bounding
  **which endpoints qualify** — the cheapest price tier, refreshed daily by the
  host sweep (`src/provider-pins.ts`).

They are complementary, not alternatives. Measured over five turns: neither
$0.00286, header alone $0.00462, pin alone $0.00222, both $0.00143. The pin
alone still bounces between equally-priced providers and splits the cache; the
header alone can stick to a dear endpoint.

Inspect what the pin will be for a group's models:

```bash
python3 .claude/skills/update-agent-models/scripts/provider-tiers.py <model> [more models...]
```

**Pass every model the group runs, main agent and subagents.** One container's
env applies to all of them, and `provider.only` containing no provider that
serves a requested model is a 404 — `allow_fallbacks: true` does not rescue
that (measured). That is why the pin is a union and why it is omitted entirely
when any model is uncovered. If you add a subagent on a new model, the pin
stays absent until the next daily refresh covers it: correct, and cheaper than
the alternative.

## 6. Apply

The main agent's model and effort live in the DB; subagents live in tracked
files. Both, or the group is inconsistent.

```bash
ncl groups config update --id <group-id> --model <picked> --effort <low|medium|high|max>
```

Subagent frontmatter in `groups/<folder>/.claude/agents/<name>.md`:

```yaml
model: <picked-model>
effort: low
```

Effort per job, not per taste: `low` for executors that call a tool and report;
`medium` where the agent must chain calls or judge sources; `high` only for a
deliberate escalation agent. **Set it explicitly on every subagent**, including
where it matches the group default — an inherited value is invisible and drifts
the next time the group changes.

```bash
ncl groups restart --id <group-id>
```

## 7. Verify against the trace

```bash
pnpm run chat "kurzer Test nach Modellwechsel, bitte bestaetigen"
pnpm run chat "und noch ein zweiter Turn"
pnpm exec python3 .claude/skills/update-agent-models/scripts/trace-cost.py <group-id> --since <today>
```

Two turns, because the first is cold. Compare against step 1's numbers and
report cold and warm separately — quoting only the warm figure overstates what
a real conversation costs.

`pnpm run chat` returns after a short silence, so a long turn's answer arrives
after it exits. Read the result from the container log
(`logs/containers/<session>/`) or `outbound.db` rather than assuming it failed.

## 8. Test the executors for real

Benchmarks rank; they do not certify. Exercise the integrations that would fail
quietly — the ones with the largest tool surface, or whose metric dropped:

- A wiki or document executor: have it find the largest page, produce the
  section outline, and read one middle section exactly. That exercises the
  range arithmetic a static benchmark never touches.
- A calendar/board executor: boards, stacks, oldest items, a date window.

Ask it to report honestly what did not fit. Then read the container log and
count the tool calls: a correct answer reached by flailing is a different
result from a correct answer reached in six calls.

## 9. Write it down

- **`FORK-CHANGELOG.md`** — subagent frontmatter and any code change. Say what
  was measured, not just what was chosen.
- **`CONFIG-CHANGELOG.md`** — the `ncl` commands, since DB config appears in no
  diff. Include the before/after cost.
- **`groups/<folder>/nanoclaw-overview.md`** — only if the agent's own
  self-description changed. A model swap usually does not change what the agent
  can do.
- Turn the trace back off when the question is answered:
  `ncl groups config update --id <group-id> --llm-trace false`.

## Integration points

This skill makes **no reach-in into NanoClaw source**. It reads two public HTTP
APIs, runs probes inside an existing container, and changes configuration —
`ncl` writes for the group, tracked frontmatter for the subagents. There is no
line in the tree whose deletion a test could catch, so a registration test is
structurally inapplicable (see `docs/skill-guidelines.md`, "When there is
genuinely nothing to test in-tree"). Its verification is step 5 and step 7:
both produce numbers that are wrong or absent if the workflow was not followed.

## Troubleshooting

**`fetch-benchmarks.sh` reports no running container.** `/api/v1/benchmarks`
needs auth. Send the group any message to spawn a container, then re-run. The
catalogue surface still works, but tau-bench, GPQA and search will be missing.

**A probe exits with `ANTHROPIC_BASE_URL must be set`.** It was run on the host.
Both probes must run inside an agent container.

**A probe hangs or resets.** `NO_PROXY=127.0.0.1,localhost,::1` is missing. The
container routes egress through the OneCLI gateway, which would otherwise try
to dial the loopback address from the host.

**The baseline id is rejected.** Use the catalogue id (`vendor/model`), not the
dated `canonical_slug`.

**`--inventory` shows no score for the model you run.** Recent releases are
often unbenchmarked. Pick an older sibling as the baseline to compare against,
and say plainly that the model in production is unmeasured.
