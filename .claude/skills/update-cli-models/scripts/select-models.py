#!/usr/bin/env python3
"""Merge OpenRouter's two benchmark surfaces and, per use case, list every
model at least as good as a baseline and no more expensive.

    select-models.py <work-dir> --baseline <model-id> [--usecases <file>]
    select-models.py <work-dir> --baseline <model-id> --inventory

`--inventory` prints every metric with its coverage and the baseline's score,
which is how you pick a metric for a use case in the first place.

Candidates are ranked by a 4:1 prompt-to-completion price blend, which suits
agent traffic: the prompt is re-sent whole on every turn, the completion is a
few hundred tokens. `:batch` (not usable interactively) and `:free` (rate
limits, training-data terms) variants are excluded.
"""
import argparse
import json
import os
import sys
from collections import defaultdict

PROMPT_TO_COMPLETION_BLEND = 4


def load(work: str):
    models = json.load(open(os.path.join(work, "models.json")))["data"]
    try:
        bench = json.load(open(os.path.join(work, "bench.json")))["data"]
    except (FileNotFoundError, KeyError):
        bench = []
    return models, bench


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


def usable(mid: str) -> bool:
    return not mid.endswith((":batch", ":free"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("work")
    ap.add_argument("--baseline", required=True, help="model id to beat, e.g. google/gemini-3.7-flash")
    ap.add_argument("--usecases", help="JSON list of {agent, metric, why}")
    ap.add_argument("--inventory", action="store_true", help="list every metric and its coverage")
    ap.add_argument("--top", type=int, default=10)
    args = ap.parse_args()

    models, bench = load(args.work)
    price, by_canon = build_index(models)
    scores = collect_scores(models, bench, make_resolver(price, by_canon))

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
