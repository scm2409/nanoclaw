#!/usr/bin/env python3
"""Merge OpenRouter's two benchmark surfaces and, per use case, list every
model at least as good as a baseline and no more expensive.

    select-models.py <work-dir> --baseline <model-id> [--usecases <file>]
    select-models.py <work-dir> --baseline <model-id> --inventory

`--inventory` prints every metric with its coverage and the baseline's score,
which is how you pick a metric for a use case in the first place.

    select-models.py <work-dir> --score <slot> [--weight-cost <w>]

`--score` ranks the field for one wrapper slot by Artificial Analysis' measured
quality *and* its measured cost per indexed task, which is the only surface that
prices a whole task rather than a token. It needs `aa.json` in the work dir
(fetch-benchmarks.sh writes it).

Candidates are ranked by a 4:1 prompt-to-completion price blend, which suits
agent traffic: the prompt is re-sent whole on every turn, the completion is a
few hundred tokens. `:batch` (not usable interactively) and `:free` (rate
limits, training-data terms) variants are excluded.
"""
import argparse
import json
import math
import os
import sys
from collections import defaultdict

PROMPT_TO_COMPLETION_BLEND = 4

# Gemini through OpenRouter returns cache_read == cache_creation and bills above
# its own uncached list price, so a Gemini pick is a cost regression however good
# its benchmarks look. See references/why-caching-gates-this.md; --include-gemini
# overrides this for the day that changes.
CACHE_BROKEN_VENDORS = ("google/",)

# Empty here on purpose. A NanoClaw group may legitimately run an Anthropic model
# — that is the default provider — so nothing is excluded on vendor grounds
# beyond the cache-broken case above. (The sibling /update-cli-models skill does
# exclude Anthropic ids, because the wrapper it maintains exists specifically to
# replace them.) --include-anthropic therefore changes nothing here; it is kept
# so the two copies of this script stay diffable.
REPLACED_VENDORS = ()

# Per-role weighting for --score. `quality` names the metric that decides the
# role; `weight_cost` is how hard measured cost-per-task pulls against it, on the
# same 0..1 normalized scale.
#
#   score = quality_norm - weight_cost * log10(cost_per_task)_norm
#
# Cost is normalized in log space because the field spans three orders of
# magnitude: without it the cheapest model wins every role by arithmetic alone.
PROFILES = {
    # Decides which subagent or tool to call next. Runs on every turn of every
    # conversation, so cost weighs as heavily as capability.
    "orchestrator": {"quality": "agentic_index", "weight_cost": 1.0},
    # Already told what to do; the job is driving an API correctly. Judged on
    # multi-turn tool calling, and cheap because it is the highest-frequency
    # shape in a roster.
    "executor": {"quality": "tau_bench_verified_airline", "weight_cost": 1.5},
    # Writes and verifies code from a complete task description.
    "coder": {"quality": "coding_index", "weight_cost": 0.8},
    # Multi-hop web research. Ranked on orchestration because the search family
    # is scored for a handful of models; cross-check with
    # `--metric search_browsecomp` and believe it only if the coverage line is
    # not two.
    "researcher": {"quality": "agentic_index", "weight_cost": 1.0},
    # The escalation agent: allowed to be expensive, not allowed to be pointless.
    "escalation": {"quality": "intelligence_index", "weight_cost": 0.35},
}
AA_METRICS = ("intelligence_index", "coding_index", "agentic_index")


def load(work: str):
    models = json.load(open(os.path.join(work, "models.json")))["data"]
    try:
        bench = json.load(open(os.path.join(work, "bench.json")))["data"]
    except (FileNotFoundError, KeyError):
        bench = []
    try:
        aa = json.load(open(os.path.join(work, "aa.json")))["data"]
    except (FileNotFoundError, KeyError):
        aa = []
    return models, bench, aa


def build_index(models):
    price, by_canon = {}, {}
    for m in models:
        price[m["id"]] = m.get("pricing") or {}
        if m.get("canonical_slug"):
            by_canon.setdefault(m["canonical_slug"], m["id"])
    return price, by_canon


def make_resolver(price, by_canon):
    """benchmarks-endpoint `model_permaslug` -> catalogue model id.

    The permaslug is the dated canonical slug (google/gemini-3.7-flash-20260813);
    most match directly, the rest need the date suffix stripped.
    """

    def resolve(permaslug: str):
        if permaslug in by_canon:
            return by_canon[permaslug]
        tail = permaslug.rsplit("-", 1)[-1]
        bare = permaslug.rsplit("-", 1)[0] if tail.isdigit() else permaslug
        if bare in price:
            return bare
        for canon, mid in by_canon.items():
            if canon.startswith(bare):
                return mid
        return None

    return resolve


def collect_scores(models, bench, resolve):
    """metric -> {model id: score}, merged from both surfaces."""
    scores = defaultdict(dict)

    # The catalogue's own block: better coverage, and the only place the
    # `agents` design-arena appears.
    for m in models:
        bm = m.get("benchmarks") or {}
        for key, value in (bm.get("artificial_analysis") or {}).items():
            if isinstance(value, (int, float)):
                scores[key][m["id"]] = value
        for row in bm.get("design_arena") or []:
            if row.get("elo") is not None:
                scores[f"arena:{row.get('arena')}:{row.get('category')}"][m["id"]] = row["elo"]

    # OpenRouter's own runs: the only source for tau-bench, GPQA, search.
    for r in bench:
        if r.get("source") != "openrouter":
            continue
        mid = resolve(r["model_permaslug"])
        if not mid:
            continue
        if r.get("accuracy") is not None:
            scores[r["benchmark_type"]].setdefault(mid, r["accuracy"] * 100)
        elif r.get("primary_score") is not None:
            scores[r["benchmark_type"]].setdefault(mid, r["primary_score"])
    return scores


def aa_by_model(aa, price):
    """OpenRouter model id -> its Artificial Analysis rows, best variant first.

    AA lists every reasoning-effort level of a model as its own row while the
    whole family is reachable under one OpenRouter id, because effort is a
    request parameter. Rows for ids the catalogue does not serve are dropped:
    an unbuyable model is not a candidate.
    """
    out = defaultdict(list)
    for r in aa:
        mid = r.get("openrouter_id")
        if mid and mid in price and not r.get("deprecated"):
            out[mid].append(r)
    for rows in out.values():
        rows.sort(key=lambda r: -(r.get("intelligence_index") or 0))
    return out


def merge_aa_scores(scores, aa_index):
    """Add `aa:<metric>` to the metric table, taking each model's best variant.

    Namespaced because these are not the same numbers as the catalogue's
    `intelligence_index`: AA's leaderboard tracks the current index version and
    splits by reasoning effort, the catalogue carries one flattened figure per
    model and covers far fewer of them. Keeping both lets a pick be cross-checked
    instead of silently depending on which surface was fresher.
    """
    for mid, rows in aa_index.items():
        for metric in AA_METRICS:
            values = [r[metric] for r in rows if r.get(metric) is not None]
            if values:
                scores[f"aa:{metric}"][mid] = max(values)
        costs = [r["cost_per_task"] for r in rows if r.get("cost_per_task") is not None]
        if costs:
            scores["aa:cost_per_task"][mid] = min(costs)


def score_slot(scores, aa_index, quality, weight_cost, include_gemini, include_anthropic, top,
               baseline=None, min_metric=None):
    """Rank candidates for one role by quality against measured cost per task.

    Two kinds of metric arrive here. AA's own indices are scored per
    reasoning-effort variant, so each variant is ranked separately — the effort
    level moves both the score and the bill. Every other metric (tau-bench, the
    arenas, GPQA) is one figure per model with no effort attached, so the model
    is ranked once, priced at its cheapest measured variant, and the table says
    so rather than implying the benchmark was run at that effort.
    """
    aa_native = quality in AA_METRICS
    rows = []
    for mid, variants in aa_index.items():
        if not usable(mid):
            continue
        if not include_gemini and mid.startswith(CACHE_BROKEN_VENDORS):
            continue
        if not include_anthropic and mid.startswith(REPLACED_VENDORS):
            continue
        costed = [r for r in variants if r.get("cost_per_task") is not None]
        if not costed:
            continue
        if aa_native:
            pairs = [(r[quality], r) for r in costed if r.get(quality) is not None]
        else:
            outside = scores.get(quality, {}).get(mid)
            pairs = [] if outside is None else [(outside, min(costed, key=lambda r: r["cost_per_task"]))]
        for value, variant in pairs:
            if min_metric is None or value >= min_metric:
                rows.append((mid, value, variant))

    if not rows:
        print(f"no model has both a score for {quality} and a measured cost per task.")
        print("aa.json missing or stale? run fetch-benchmarks.sh again.")
        return 1

    qs = [v for _, v, _ in rows]
    cs = [math.log10(r["cost_per_task"]) for _, _, r in rows if r["cost_per_task"] > 0]
    qlo, qhi, clo, chi = min(qs), max(qs), min(cs), max(cs)

    def norm(v, lo, hi):
        return 0.0 if hi == lo else (v - lo) / (hi - lo)

    ranked = sorted(
        (
            (
                norm(value, qlo, qhi)
                - weight_cost * norm(math.log10(max(r["cost_per_task"], 10 ** clo)), clo, chi),
                mid,
                value,
                r,
            )
            for mid, value, r in rows
        ),
        key=lambda x: -x[0],
    )

    floor = f", floor {min_metric}" if min_metric is not None else ""
    skipped = [w for w, on in ((CACHE_BROKEN_VENDORS, include_gemini),
                               (REPLACED_VENDORS, include_anthropic)) if not on]
    excluded = ", ".join(v.rstrip("/") for group in skipped for v in group) or "nothing"
    print(f"metric {quality}, cost weight {weight_cost}{floor}")
    print(f"{len(rows)} scored candidates across {len({m for m, _, _ in rows})} models "
          f"(excluded: {excluded})\n")
    print(f"  {'score':>6}  {'metric':>6}  {'$/task':>7}  {'s/task':>6}  model (effort)")

    def line(total, mid, value, r, suffix=""):
        secs = r.get("sec_per_task")
        effort = r.get("effort") or "default"
        est = " ~est" if aa_native and r.get("intelligence_is_estimated") else ""
        print(f"  {total:6.3f}  {value:6.1f}  {r['cost_per_task']:7.3f}  "
              f"{secs if secs is not None else float('nan'):6.0f}  {mid} ({effort}){est}{suffix}")

    for total, mid, value, r in ranked[:top]:
        line(total, mid, value, r, "   <= in place now" if mid == baseline else "")
    if baseline and baseline not in {mid for _, mid, _, _ in ranked[:top]}:
        for pos, (total, mid, value, r) in enumerate(ranked, 1):
            if mid == baseline:
                line(total, mid, value, r, f"   <= in place now, rank {pos}")
                break

    if aa_native:
        print("\nEffort is a request parameter, not a model id: every variant above is")
        print("reachable under the id shown, and the effort level moves both columns.")
    else:
        print(f"\n{quality} is not scored per reasoning effort, so each model appears once,")
        print("priced at its cheapest measured variant. The effort shown is where that")
        print("price came from, not the effort the benchmark was run at.")
    return 0


def usable(mid: str) -> bool:
    return not mid.endswith((":batch", ":free"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("work")
    ap.add_argument("--baseline", help="model id to beat, e.g. google/gemini-3.7-flash; required unless --score")
    ap.add_argument("--usecases", help="JSON list of {agent, metric, why}")
    ap.add_argument("--inventory", action="store_true", help="list every metric and its coverage")
    ap.add_argument("--score", choices=sorted(PROFILES), help="rank the field for one agent role")
    ap.add_argument("--weight-cost", type=float, help="override the slot's cost weight")
    ap.add_argument("--include-gemini", action="store_true", help="stop excluding cache-broken vendors")
    ap.add_argument("--metric", help="score on this metric instead of the profile's")
    ap.add_argument("--min-metric", type=float, help="drop variants below this score before ranking")
    ap.add_argument("--include-anthropic", action="store_true",
                    help="rank Anthropic ids too — the models the wrapper replaces")
    ap.add_argument("--top", type=int, default=10)
    args = ap.parse_args()
    if not args.score and not args.baseline:
        ap.error("--baseline is required unless --score names a slot")

    models, bench, aa = load(args.work)
    price, by_canon = build_index(models)
    scores = collect_scores(models, bench, make_resolver(price, by_canon))
    aa_index = aa_by_model(aa, price)
    merge_aa_scores(scores, aa_index)

    if args.score:
        profile = PROFILES[args.score]
        weight = args.weight_cost if args.weight_cost is not None else profile["weight_cost"]
        if not aa_index:
            print("no aa.json in the work dir — run fetch-benchmarks.sh first", file=sys.stderr)
            return 2
        metric = args.metric or profile["quality"]
        return score_slot(scores, aa_index, metric, weight, args.include_gemini,
                          args.include_anthropic, args.top, args.baseline, args.min_metric)

    def rate(mid, key):
        try:
            return float(price.get(mid, {}).get(key)) * 1e6
        except (TypeError, ValueError):
            return None

    base = args.baseline
    if base not in price:
        print(f"baseline {base} is not in the catalogue — check the id", file=sys.stderr)
        return 2
    bp, bc = rate(base, "prompt"), rate(base, "completion")

    if args.inventory:
        print(f"{len(scores)} metrics merged from both surfaces\n")
        for metric in sorted(scores):
            b = scores[metric].get(base)
            shown = f"{b:>8.1f}" if b is not None else "       —"
            print(f"  {metric:<36} {len(scores[metric]):>4} models   baseline {shown}")
        return 0

    if not args.usecases:
        print("give --usecases <file> or --inventory", file=sys.stderr)
        return 2

    print(f"baseline {base}: ${bp}/M in, ${bc}/M out")
    for uc in json.load(open(args.usecases)):
        metric = uc["metric"]
        table = scores.get(metric, {})
        b = table.get(base)
        print(f"\n===== {uc['agent']} — {uc.get('why', '')}")
        print(f"      metric {metric} ({len(table)} models scored)")
        if b is None:
            print("      baseline is not scored here; ranking the field instead —")
            print("      a pick from this list is a judgement call, not a comparison.")
            ranked = [t for t in sorted(table.items(), key=lambda x: -x[1]) if usable(t[0])]
            for mid, sc in ranked[: args.top]:
                p, c = rate(mid, "prompt"), rate(mid, "completion")
                print(f"        {sc:8.2f}  ${p or float('nan'):8.4f}/${c or float('nan'):8.4f}  {mid}")
            continue
        rows = []
        for mid, sc in table.items():
            p, c = rate(mid, "prompt"), rate(mid, "completion")
            if p is None or c is None or not usable(mid):
                continue
            if sc >= b and p <= bp and c <= bc:
                rows.append((p + c / PROMPT_TO_COMPLETION_BLEND, sc, p, c, mid))
        rows.sort()
        others = [r for r in rows if r[4] != base]
        print(f"      baseline {b:.1f} — {len(others)} model(s) at least as good and no more expensive")
        for _, sc, p, c, mid in rows[: args.top]:
            mark = "   <= baseline" if mid == base else ""
            print(f"        {sc:8.2f}  ${p:8.4f}/${c:8.4f}  {mid}{mark}")
        if not others:
            print("      Nothing qualifies — the baseline is the best of its price class here.")
            print("      Keep it, or trade the gap deliberately. Cheaper near misses:")
            near = sorted(
                (
                    (sc, rate(mid, "prompt"), rate(mid, "completion"), mid)
                    for mid, sc in table.items()
                    if usable(mid)
                    and mid != base
                    and (rate(mid, "prompt") or 1e9) <= bp
                    and (rate(mid, "completion") or 1e9) <= bc
                ),
                reverse=True,
            )
            for sc, p, c, mid in near[:5]:
                print(f"        {sc:8.2f} ({sc - b:+6.1f})  ${p:8.4f}/${c:8.4f}  {mid}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
