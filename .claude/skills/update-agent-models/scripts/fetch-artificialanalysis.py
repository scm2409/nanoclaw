#!/usr/bin/env python3
"""Pull Artificial Analysis' model leaderboard into a normalized JSON file.

    fetch-artificialanalysis.py <out-file> [--url <page>] [--quiet]

Why this exists: OpenRouter's catalogue carries only three AA numbers
(`intelligence_index`, `coding_index`, `agentic_index`) for ~180 models. The
leaderboard page carries ~640 rows with the two figures this skill actually
needs — `intelligenceIndexCostPerTask` (what one indexed task costs, cache
behaviour included) and per-reasoning-effort variants of the same model — plus
time-per-task and the individual evals behind the index.

There is a documented API at /api/v2/data/llms/models, but it requires a key.
The public leaderboard page ships the same rows inside its React streaming
payload, so this parses that instead: no auth, no key to store.

That payload is an implementation detail of someone else's site. The parse is
therefore loud, not lenient — it fails rather than returning a short list, so a
selection is never quietly built on three models that happened to survive a
layout change.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request

URL = "https://artificialanalysis.ai/leaderboards/models"
# Below this the page changed shape; a partial parse is worse than no data.
MIN_ROWS = 200
CHUNK_RE = re.compile(r'self\.__next_f\.push\(\[1,(".*?")\]\)</script>', re.S)
# Effort tokens as they appear in the parenthetical of a model's display name:
# "Muse Spark 1.3 (max)", "Claude Opus 5 (Adaptive Reasoning, Max Reasoning)".
EFFORTS = ("non-reasoning", "minimal", "medium", "xhigh", "high", "max", "low")


def flight_payload(html: str) -> str:
    """Concatenate the React streaming chunks back into one text buffer."""
    chunks = CHUNK_RE.findall(html)
    if not chunks:
        raise SystemExit("no __next_f chunks in the page — the site no longer streams its data this way")
    return "".join(json.loads(c) for c in chunks)


def model_objects(buf: str) -> list[dict]:
    """Every JSON object in the buffer that carries an intelligence index.

    The buffer is React flight text, not JSON, so the objects are found by
    anchoring on a field name and decoding outwards from the enclosing brace.
    """
    decoder = json.JSONDecoder()
    found: dict[str, dict] = {}
    for anchor in re.finditer(r'"intelligenceIndex":', buf):
        depth, i = 0, anchor.start()
        while i > 0:
            i -= 1
            ch = buf[i]
            if ch == "}":
                depth += 1
            elif ch == "{":
                if depth == 0:
                    try:
                        obj, _ = decoder.raw_decode(buf, i)
                    except ValueError:
                        break
                    if isinstance(obj, dict) and "intelligenceIndex" in obj:
                        found[obj.get("slug") or obj.get("name") or str(i)] = obj
                    break
                depth -= 1
    return list(found.values())


def num(value):
    """AA serializes absent values as the string "$undefined"."""
    return value if isinstance(value, (int, float)) else None


def split_effort(name: str) -> tuple[str, str | None]:
    """"Muse Spark 1.3 (max)" -> ("Muse Spark 1.3", "max").

    The family name is the join key for reasoning variants: AA lists each effort
    level as its own row, and only some of those rows carry the OpenRouter id.
    Splitting on the parenthetical rather than on a slug suffix avoids merging
    two genuinely different models whose slugs happen to differ by "-max".
    """
    head, sep, tail = name.partition("(")
    if not sep:
        return name.strip(), None
    inside = tail.rstrip(") ").lower()
    for effort in EFFORTS:
        if re.search(rf"\b{re.escape(effort)}\b", inside):
            return head.strip(), effort
    return head.strip(), None


def normalize(raw: list[dict]) -> list[dict]:
    rows = []
    for m in raw:
        family, effort = split_effort(m.get("name") or m.get("slug") or "")
        cost = m.get("intelligenceIndexCostPerTask")
        cost = cost.get("cost", {}) if isinstance(cost, dict) else {}
        rows.append(
            {
                "slug": m.get("slug"),
                "name": m.get("name"),
                "family": family,
                "effort": effort,
                "openrouter_id": m.get("openrouterApiId") or None,
                "creator": m.get("modelCreatorName"),
                "release_date": m.get("releaseDate"),
                "is_reasoning": m.get("isReasoning"),
                "deprecated": bool(m.get("deprecated")),
                "intelligence_index": num(m.get("intelligenceIndex")),
                "intelligence_is_estimated": bool(m.get("intelligenceIndexIsEstimated")),
                "coding_index": num(m.get("codingIndex")),
                "agentic_index": num(m.get("agenticIndex")),
                # What one task of the index costs end to end, at AA's measured
                # cache hit rate — the figure OpenRouter's surface cannot give.
                "cost_per_task": num(cost.get("total")),
                "cost_per_task_input": num(cost.get("input")),
                "cost_per_task_cache_read": num(cost.get("cacheRead")),
                "cost_per_task_cache_write": num(cost.get("cacheWrite")),
                "cost_per_task_reasoning": num(cost.get("reasoning")),
                "sec_per_task": num(m.get("intelligenceIndexTimePerTask")),
                "output_tokens_per_task": num(m.get("intelligenceIndexOutputTokensPerTask")),
                "price_in": num(m.get("price1mInputTokens")),
                "price_out": num(m.get("price1mOutputTokens")),
                "cache_hit_price": num(m.get("cacheHitPrice")),
                "cache_hit_discount": num(m.get("cacheHitDiscountPercent")),
                "context_window": num(m.get("contextWindowTokens")),
                "evals": {
                    k: num(m.get(v))
                    for k, v in (
                        ("terminalbench_v2_1", "terminalbenchV21"),
                        ("scicode", "scicode"),
                        ("tau_banking", "tauBanking"),
                        ("hle", "hle"),
                        ("gpqa", "gpqa"),
                        ("lcr", "lcr"),
                        ("cwe_bench", "cweBench"),
                        ("gdpval_normalized", "gdpvalNormalized"),
                        ("omniscience", "omniscience"),
                    )
                    if num(m.get(v)) is not None
                },
            }
        )
    # Carry the OpenRouter id across a family's effort rows: effort is a request
    # parameter, not a separate endpoint, so every variant is reachable under
    # whichever id the family exposes.
    by_family: dict[str, str] = {}
    for r in rows:
        if r["openrouter_id"]:
            by_family.setdefault(r["family"], r["openrouter_id"])
    for r in rows:
        if not r["openrouter_id"]:
            r["openrouter_id"] = by_family.get(r["family"])
            r["openrouter_id_inherited"] = bool(r["openrouter_id"])
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--url", default=URL)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    req = urllib.request.Request(args.url, headers={"User-Agent": "nanoclaw-update-cli-models"})
    with urllib.request.urlopen(req, timeout=60) as response:
        html = response.read().decode("utf-8", "replace")

    rows = normalize(model_objects(flight_payload(html)))
    if len(rows) < MIN_ROWS:
        raise SystemExit(
            f"parsed only {len(rows)} models from {args.url} (expected >= {MIN_ROWS}) — "
            "the page structure changed; fix the parser rather than trusting this"
        )
    json.dump({"source": args.url, "data": rows}, open(args.out, "w"))

    if not args.quiet:
        linked = sum(1 for r in rows if r["openrouter_id"])
        costed = sum(1 for r in rows if r["cost_per_task"] is not None)
        variants = sum(1 for r in rows if r["effort"])
        print(f"    {len(rows)} models, {linked} with an OpenRouter id, {costed} with cost-per-task")
        print(f"    {variants} are reasoning-effort variants of another row")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
