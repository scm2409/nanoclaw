#!/usr/bin/env python3
"""Run Claude Code against OpenRouter models instead of Anthropic's, with the
caching actually paying off, and report what the session cost afterwards.

Standalone by design: one file, Python standard library only, no state outside
the process, and no dependency on the repository it happens to sit in. Copy it
anywhere and it works. The only external commands are `onecli` (for credentials)
and `claude` itself.

    ./claude_openrouter.py [any claude arguments]

    CLAUDE_EFFORT=max ./claude_openrouter.py     # heavier reasoning this session
    NO_SUMMARY=1 ./claude_openrouter.py          # skip the cost report

Three things it does beyond setting model names:

1. **Bounds the provider.** A gateway serves one model from many endpoints at up
   to twice the price, and a prompt cache lives on the endpoint that wrote it.
   `provider.only` over the cheapest tier of *every* model this session can
   reach goes into the request body via CLAUDE_CODE_EXTRA_BODY, which Claude
   Code merges verbatim. The union matters: a list containing no provider that
   serves the requested model is a 404, and `allow_fallbacks` does not rescue
   it — so if any model cannot be resolved, no provider field is sent at all.

2. **Pins one endpoint inside that tier**, with an `x-session-id` header keyed
   to the working directory, so this checkout's sessions share a warm prefix.

3. **States the context window.** Claude Code never learns the window of a model
   behind an Anthropic-compatible endpoint; it assumes 200k and auto-compacts
   against that, and compacting early is the wrong direction because every token
   below the threshold is re-paid on every turn. The value used is the smallest
   window among the endpoints actually reachable, because one setting applies to
   every model in the session.

Provider tiers are resolved fresh at every launch — a few hundred milliseconds
against a public endpoint — rather than cached. A day-old tier is a day-old
price, and this script keeping state on disk would be one more thing tying it to
one machine.

To re-pick the models below from current benchmark data, see the
`update-cli-models` skill; nothing here depends on it being present.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

# ---------------------------------------------------------------------------
# Models. Every one of these was verified to cache before adoption; never put a
# Gemini model here — through this gateway they bill a cache above their own
# uncached price.
#
#                        intel  coding  agentic   in/out $/M     warm
#   z-ai/glm-5.3-flash    57.5    71.5     58.2  0.075/0.250  $0.015/M
#   z-ai/glm-5.3          59.5    74.8     59.1  1.400/4.400  $0.143/M
#   x-ai/grok-4.6         60.9    76.8     58.7  2.000/6.000  $0.504/M
# ---------------------------------------------------------------------------
MODELS = {
    "ANTHROPIC_MODEL": "z-ai/glm-5.3-flash",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "z-ai/glm-5.3-flash",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "z-ai/glm-5.3-flash",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "z-ai/glm-5.3",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "x-ai/grok-4.6",
    "CLAUDE_CODE_SUBAGENT_MODEL": "z-ai/glm-5.3",
}

BASE_URL = "https://openrouter.ai/api"
# Take every endpoint within this factor of the cheapest, not just the single
# cheapest one. A tier of one provider is fragile: when it stalls,
# `allow_fallbacks` leaves the cheap class entirely. A 10% band typically yields
# three or four providers whose price difference is noise next to that risk.
PRICE_BAND = 1.10
# Skip endpoints that have been unreliable today. `status < 0` already catches
# what the gateway has deranked; this catches the merely flaky.
MIN_UPTIME_1D = 95.0
# Within the band, ignore endpoints that serve a much smaller context than the
# best one on offer for that model. A truncated window is a capability
# difference, not a price difference: it would drag the session-wide compaction
# threshold down for everyone.
MIN_CONTEXT_FRACTION = 0.5
DEFAULT_EFFORT = "high"
HTTP_TIMEOUT = 20
# Set on the re-exec so the child knows credentials are already available.
ONECLI_MARKER = "CLAUDE_OPENROUTER_WRAPPED"


def get_json(url: str, token: str | None = None) -> dict:
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as response:
        return json.load(response)


# ---------------------------------------------------------------------------
# Provider tiers
# ---------------------------------------------------------------------------
def endpoints_of(model: str) -> list[dict]:
    return get_json(f"{BASE_URL}/v1/models/{model}/endpoints")["data"]["endpoints"]


def cheapest_tier(endpoints: list[dict]) -> tuple[list[str], int | None]:
    """Provider slugs at the cheapest prompt price, and their smallest context.

    The slug `provider.only` accepts is the part of the endpoint's `tag` before
    the quantisation suffix (`z-ai/fp8` -> `z-ai`), never the display name
    (`Z.AI`). Deranked or flaky endpoints are skipped, and the result is a
    price *band* rather than the single cheapest: a price saving is worthless
    if the turn fails, and a one-provider tier has nowhere to fall back to
    without leaving the cheap class.
    """
    priced: list[tuple[str, float, int | None]] = []
    for e in endpoints:
        status = e.get("status")
        if isinstance(status, (int, float)) and status < 0:
            continue
        uptime = e.get("uptime_last_1d")
        if isinstance(uptime, (int, float)) and uptime < MIN_UPTIME_1D:
            continue
        try:
            price = float((e.get("pricing") or {}).get("prompt"))
        except (TypeError, ValueError):
            continue
        if price <= 0:
            continue
        slug = (e.get("tag") or "").split("/")[0].strip()
        if slug:
            priced.append((slug, price, e.get("context_length")))
    if not priced:
        return [], None
    floor = min(p for _, p, _ in priced)
    in_band = [(s, c) for s, p, c in priced if p <= floor * PRICE_BAND]
    best_window = max((c for _, c in in_band if c), default=None)
    if best_window:
        in_band = [(s, c) for s, c in in_band if not c or c >= best_window * MIN_CONTEXT_FRACTION]
    windows = [c for _, c in in_band if c]
    return sorted({s for s, _ in in_band}), (min(windows) if windows else None)


def resolve_tiers(models: list[str]) -> tuple[dict[str, list[str]], int | None]:
    """Cheapest tier per model and the smallest window across them all.

    Returns ({}, window) when any model cannot be resolved — the caller must
    then send no provider field rather than a partial union.
    """
    result: dict[str, list[str]] = {}
    windows: list[int] = []
    with ThreadPoolExecutor(max_workers=min(6, len(models))) as pool:
        for model, outcome in zip(models, pool.map(_safe_tier, models)):
            slugs, window = outcome
            if not slugs:
                return {}, None
            result[model] = slugs
            if window:
                windows.append(window)
    return result, (min(windows) if windows else None)


def _safe_tier(model: str) -> tuple[list[str], int | None]:
    try:
        return cheapest_tier(endpoints_of(model))
    except Exception as err:  # noqa: BLE001 — any failure means "cannot pin"
        print(f"[wrapper] tier lookup failed for {model}: {err}", file=sys.stderr)
        return [], None


def session_id_for(path: Path) -> str:
    """Stable per checkout, so its sessions share one warm endpoint."""
    scope = os.environ.get("CLAUDE_OPENROUTER_SESSION_SCOPE") or str(path)
    return "claude-cli-" + hashlib.sha256(scope.encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Session accounting
# ---------------------------------------------------------------------------
def transcript_dir(cwd: Path) -> Path:
    """Claude Code stores a session's transcript under an escaped cwd."""
    return Path.home() / ".claude" / "projects" / str(cwd).replace("/", "-").replace(".", "-")


def newest_transcript(directory: Path, newer_than: float) -> Path | None:
    try:
        files = [f for f in directory.glob("*.jsonl") if f.stat().st_mtime >= newer_than]
    except OSError:
        return None
    return max(files, key=lambda f: f.stat().st_mtime, default=None)


def usage_by_model(transcript: Path) -> dict[str, dict[str, int]]:
    """Per-model token totals, read from what the CLI wrote locally.

    This is the only per-model breakdown available: the gateway's own activity
    endpoint needs a management key, and the Anthropic-compatible response drops
    `usage.cost` before it reaches the transcript.
    """
    agg: dict[str, dict[str, int]] = defaultdict(lambda: dict(calls=0, input=0, cached=0, written=0, output=0))
    for line in transcript.read_text(errors="ignore").splitlines():
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        message = record.get("message") or {}
        usage, model = message.get("usage"), message.get("model")
        if not usage or not model or model == "<synthetic>":
            continue
        row = agg[model]
        row["calls"] += 1
        for key, field in (
            ("input", "input_tokens"),
            ("cached", "cache_read_input_tokens"),
            ("written", "cache_creation_input_tokens"),
            ("output", "output_tokens"),
        ):
            value = usage.get(field)
            if isinstance(value, int):
                row[key] += value
    return dict(agg)


def total_usage(token: str) -> float | None:
    try:
        return float(get_json(f"{BASE_URL}/v1/credits", token)["data"]["total_usage"])
    except Exception:  # noqa: BLE001 — the report degrades, the session does not
        return None


def price_table(models: list[str]) -> dict[str, dict[str, float]]:
    try:
        catalogue = get_json(f"{BASE_URL}/v1/models?limit=1000")["data"]
    except Exception:  # noqa: BLE001
        return {}
    wanted = set(models)
    out: dict[str, dict[str, float]] = {}
    for entry in catalogue:
        if entry["id"] not in wanted:
            continue
        pricing = entry.get("pricing") or {}

        def rate(key: str) -> float:
            try:
                return float(pricing.get(key)) * 1e6
            except (TypeError, ValueError):
                return 0.0

        out[entry["id"]] = {
            "prompt": rate("prompt"),
            "completion": rate("completion"),
            "cache_read": rate("input_cache_read"),
            "cache_write": rate("input_cache_write"),
        }
    return out


def print_summary(usage: dict[str, dict[str, int]], spent: float | None) -> None:
    if not usage:
        print("\n[wrapper] no transcript found for this session — no token summary.", file=sys.stderr)
        return
    prices = price_table(list(usage))
    print("\n── session summary " + "─" * 52, file=sys.stderr)
    print(
        f"{'model':<24}{'calls':>7}{'prompt':>11}{'cached':>11}{'output':>9}{'est.':>10}",
        file=sys.stderr,
    )
    estimated = 0.0
    for model, row in sorted(usage.items(), key=lambda kv: -kv[1]["calls"]):
        prompt = row["input"] + row["cached"] + row["written"]
        price = prices.get(model)
        cost = None
        if price:
            cost = (
                row["input"] * price["prompt"]
                + row["cached"] * price["cache_read"]
                + row["written"] * price["cache_write"]
                + row["output"] * price["completion"]
            ) / 1e6
            estimated += cost
        shown = f"${cost:.4f}" if cost is not None else "  —"
        print(
            f"{model:<24}{row['calls']:>7}{prompt:>11,}{row['cached']:>11,}{row['output']:>9,}{shown:>10}",
            file=sys.stderr,
        )
    print("─" * 69, file=sys.stderr)
    print(f"{'price-table estimate':<52}{'$%.4f' % estimated:>17}", file=sys.stderr)
    if spent is not None:
        print(f"{'actually billed by the gateway':<52}{'$%.4f' % spent:>17}", file=sys.stderr)
        if estimated > 0 and (spent > estimated * 1.3 or spent < estimated * 0.7):
            print(
                "\n[wrapper] estimate and bill disagree by more than 30%. The estimate assumes\n"
                "          the cache rates in the catalogue; a large gap usually means caching\n"
                "          is not working the way the price list implies. Worth investigating.",
                file=sys.stderr,
            )
    else:
        print(f"{'actually billed':<52}{'unavailable':>17}", file=sys.stderr)


# ---------------------------------------------------------------------------
def main() -> int:
    # Everything that needs a credential — the gateway-authenticated calls and
    # `claude` itself — has to run inside `onecli run`. Re-exec once into it
    # rather than wrapping only the child, so this script's own requests are
    # covered too.
    if not os.environ.get(ONECLI_MARKER):
        os.environ[ONECLI_MARKER] = "1"
        argv = ["onecli", "run", "--", sys.executable, os.path.abspath(__file__), *sys.argv[1:]]
        try:
            return subprocess.call(argv)
        except FileNotFoundError:
            print("[wrapper] `onecli` not found — it supplies the API credentials.", file=sys.stderr)
            return 127

    cwd = Path.cwd()
    env = dict(os.environ)
    env.update(MODELS)
    env["ANTHROPIC_BASE_URL"] = BASE_URL
    env["ANTHROPIC_AUTH_TOKEN"] = "placeholder"  # the gateway rewrites this
    env["ANTHROPIC_API_KEY"] = ""

    distinct = sorted(set(MODELS.values()))
    tiers, window = resolve_tiers(distinct)

    if tiers:
        union = sorted({slug for slugs in tiers.values() for slug in slugs})
        if not env.get("CLAUDE_CODE_EXTRA_BODY"):
            env["CLAUDE_CODE_EXTRA_BODY"] = json.dumps(
                {"provider": {"only": union, "allow_fallbacks": True}}, separators=(",", ":")
            )
        print(f"[wrapper] providers: {', '.join(union)}", file=sys.stderr)
    else:
        print(
            "[wrapper] could not resolve every model's provider tier — routing left to the\n"
            "          gateway. A partial provider list would 404 whichever model it omits.",
            file=sys.stderr,
        )

    if not env.get("ANTHROPIC_CUSTOM_HEADERS"):
        env["ANTHROPIC_CUSTOM_HEADERS"] = f"x-session-id: {session_id_for(cwd)}"

    # Smallest reachable window, not the largest: one value applies to every
    # model, and a model whose real window is smaller simply fails past it.
    resolved_window = window or 200_000
    env.setdefault("CLAUDE_CODE_MAX_CONTEXT_TOKENS", str(resolved_window))
    env.setdefault("CLAUDE_CODE_AUTO_COMPACT_WINDOW", str(resolved_window))
    print(f"[wrapper] context window: {resolved_window:,} tokens", file=sys.stderr)

    effort = env.get("CLAUDE_EFFORT", DEFAULT_EFFORT)

    directory = transcript_dir(cwd)
    started = time.time()
    before = total_usage(env["ANTHROPIC_AUTH_TOKEN"])

    try:
        code = subprocess.call(["claude", "--effort", effort, *sys.argv[1:]], env=env)
    except FileNotFoundError:
        print("[wrapper] `claude` not found on PATH.", file=sys.stderr)
        return 127

    if not env.get("NO_SUMMARY"):
        after = total_usage(env["ANTHROPIC_AUTH_TOKEN"])
        spent = (after - before) if (before is not None and after is not None) else None
        transcript = newest_transcript(directory, started)
        print_summary(usage_by_model(transcript) if transcript else {}, spent)

    return code


if __name__ == "__main__":
    raise SystemExit(main())
