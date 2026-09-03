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

## Reading the numbers honestly

- **Coverage first.** A metric scoring 30 models is a different claim from one
  scoring 180. `--inventory` prints the count.
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
