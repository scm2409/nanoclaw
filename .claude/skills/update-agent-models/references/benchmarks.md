# Which benchmark answers which question

The metric decides the outcome more than the threshold does. A tool executor
picked on `intelligence_index` and one picked on `tau_bench_verified_airline`
are different models, and only one of them is doing the job you have.

Run `select-models.py <work> --baseline <model> --inventory` for the live list
with coverage counts; this file explains what the entries mean.

## From the model catalogue (`/api/v1/models`, no auth)

Under each model's `benchmarks` key.

| Metric | Measures | Fits |
|---|---|---|
| `intelligence_index` | Artificial Analysis' general-capability composite | A floor for any conversational agent |
| `coding_index` | Static coding ability | A coding subagent |
| `agentic_index` | Multi-step planning and tool orchestration | The main agent, browser drivers — anything that decides *which* tool to call next |
| `arena:models:<category>` | Head-to-head Elo per output category (website, dataviz, svg, gamedev, 3d, uicomponent, asciiart …) | Generation tasks where the artefact is the output |
| `arena:agents:<category>` | Head-to-head Elo for *agentic* work (fullstack, webapps, mobileapps, androidnative, godotgamedev, slide variants) | Coding agents. Closer to real work than a static index, and absent from the other surface |

## From OpenRouter's own runs (`/api/v1/benchmarks`, auth required)

| Metric | Measures | Fits |
|---|---|---|
| `tau_bench_verified_airline` | Multi-turn tool calling against an API under policy constraints | MCP executors — the single most relevant metric for a subagent whose whole job is calling tools |
| `gpqa_diamond` | Graduate-level reasoning | An escalation agent |
| `search_browsecomp` | Multi-hop web research | A research subagent |
| `search_dsqa`, `search_hle`, `search_widesearch` | Other search shapes | Same, cross-check |

The search family is scored for only a handful of models. If the baseline is
not among them, the rule "at least as good as the baseline" has nothing to
compare against — say so and make a judgement call rather than pretending the
comparison happened.

## From the Artificial Analysis leaderboard (`aa.json`, no auth)

Written by `fetch-artificialanalysis.py`, merged into the metric table under an
`aa:` prefix and used by `select-models.py --score`.

| Metric | Measures | Fits |
|---|---|---|
| `aa:intelligence_index` | AA's general-capability composite, current index version, per reasoning effort | An escalation agent |
| `aa:coding_index` | Static coding ability, same split | A coding subagent |
| `aa:agentic_index` | Multi-step planning and tool orchestration, same split | The main agent, and any orchestrator |
| `aa:cost_per_task` | Dollars for one task of the index end to end, at the measured cache hit rate | Every agent — this is the number a price list cannot give you, and it is what settles the effort question |

Only `--score` uses the per-effort rows; the merged `aa:` metrics take each
model's best variant, since effort is chosen per session and not per model.

Also in each row, not merged into the metric table but printed by `--score` or
readable straight out of `aa.json`: `sec_per_task` (wall clock, which is what a
"max effort everywhere" session actually costs you in waiting), the cost split
across input / cache-read / cache-write / reasoning tokens, and the individual
evals behind the index (`terminalbench_v2_1`, `scicode`, `tau_banking`, `hle`,
`cwe_bench`, `lcr`, …).

### What this surface is for, and what it is not

- **It prices the task, not the token.** A reasoning model's bill is set by how
  many tokens it spends thinking, and no price list shows that.
  `openai/gpt-5.6-sol` costs $0.367 a task at `medium` and $1.249 at `max` —
  same id, same $/M.
- **Cost-per-task covers roughly 50 rows**, the current frontier. Quality
  indices cover ~630 rows, ~390 of them with an OpenRouter id. A model with an
  index score and no cost figure is not disqualified; it is unmeasured, and
  `--score` leaves it out rather than guessing.
- **`intelligence_is_estimated` marks a projected score.** Present in the JSON,
  flagged as `~est` in the `--score` table. An estimate is a reason to be
  careful, not to exclude — but never present one as measured.
- **AA's index version moves.** The leaderboard tracks the current version
  (evals are added, weights rebalanced); the catalogue's
  `benchmarks.artificial_analysis` block is a flattened figure that may lag.
  That is why they are kept as separate metrics — comparing them tells you
  whether a number is fresh.
- **The join key is `openrouterApiId`**, published by AA itself, so nothing here
  rests on name matching. Rows without it are unbuyable through this wrapper and
  are dropped, except where an effort variant inherits the id its own family row
  carries.

## Reading the numbers honestly

- **Coverage first.** A metric scoring 30 models is a different claim from one
  scoring 180. `--inventory` prints the count.
- **A cheap model is not a good model with a discount.** In a
  quality-minus-cost ranking, a large price gap buys off a small quality
  deficit, so cheap mid-tier models drift to the top of every role. That is what
  `--min-metric` is for: state the floor the role has to clear before price gets
  a vote.
- **A newly released model usually has no scores at all.** That is a reason for
  caution, not a reason to exclude it, but do not present it as validated.
- **Two metrics can disagree**, and the disagreement is information. A model
  well above baseline on `agentic_index` and well below on
  `tau_bench_verified_airline` is good at deciding and worse at executing —
  which matters enormously for an executor and barely at all for an
  orchestrator. Report both instead of averaging them away.
- **A benchmark is a proxy.** `tau_bench_verified_airline` is an airline
  booking scenario, not your wiki. It ranks; it does not certify. That is why
  the workflow ends with a practical test on the real integrations.
