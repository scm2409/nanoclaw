#!/usr/bin/env python3
"""Emit the two env exports that make Claude Code's caching pay off through a
multi-provider gateway. Source it from the wrapper script:

    eval "$(python3 .claude/skills/update-cli-models/scripts/openrouter-env.py \\
              "$ANTHROPIC_MODEL" "$ANTHROPIC_DEFAULT_SONNET_MODEL" ... )"

What it emits and why:

* `CLAUDE_CODE_EXTRA_BODY` with a `provider.only` union over **every** model the
  session can reach. The CLI merges that JSON into the request body, so the
  gateway may only route to the cheapest endpoint tier. Measured over five
  turns: bounding the tier and pinning inside it cost $0.00143 against $0.00286
  for leaving the router alone.

  The union is not optional. `provider.only` containing no provider that serves
  the requested model is a 404, and `allow_fallbacks: true` does **not** rescue
  it — one env applies to the main model, every alias target and the subagent
  model alike. If any model cannot be resolved, nothing is emitted: failing
  open costs money, failing closed breaks a model mid-session.

* `ANTHROPIC_CUSTOM_HEADERS` with an `x-session-id`. A cache lives on the
  endpoint that wrote it, and the gateway's own conversation detection hashes
  the first system message — useless for a CLI whose prompt shifts per run. The
  id is derived from the working directory, so every session in one checkout
  shares a warm tools+system prefix instead of each warming its own.

An operator who already set either variable is never overridden.

The provider tiers are cached for a day under
`~/.cache/claude-openrouter/`: the endpoint listing needs no credentials, but
four HTTP calls on every shell start is rude, and a stale-by-hours tier costs
nothing.
"""
import hashlib
import json
import os
import shlex
import sys
import time
import urllib.request
from pathlib import Path

TTL_SECONDS = 24 * 3600
TIMEOUT = 15
CACHE = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "claude-openrouter" / "provider-tiers.json"


def load_cache() -> dict:
    try:
        raw = json.loads(CACHE.read_text())
    except (OSError, ValueError):
        return {}
    return raw if isinstance(raw, dict) else {}


def save_cache(cache: dict) -> None:
    try:
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        CACHE.write_text(json.dumps(cache, indent=1, sort_keys=True))
    except OSError:
        pass  # a cache we cannot write is a slow start, not a failure


def cheapest_tier(model: str) -> list[str]:
    """Provider slugs serving `model` at its cheapest prompt price, or []."""
    url = f"https://openrouter.ai/api/v1/models/{model}/endpoints"
    with urllib.request.urlopen(url, timeout=TIMEOUT) as response:
        endpoints = json.load(response)["data"]["endpoints"]
    priced = []
    for e in endpoints:
        status = e.get("status")
        if isinstance(status, (int, float)) and status < 0:
            continue  # deranked or down: cheap is no use if the turn fails
        try:
            price = float(e.get("pricing", {}).get("prompt"))
        except (TypeError, ValueError):
            continue
        if price <= 0:
            continue
        # `provider.only` wants the slug before the quantisation suffix
        # (`z-ai/fp8` -> `z-ai`), never the display name (`Z.AI`).
        slug = (e.get("tag") or "").split("/")[0].strip()
        if slug:
            priced.append((slug, price))
    if not priced:
        return []
    floor = min(p for _, p in priced)
    return sorted({s for s, p in priced if p == floor})


def tiers_for(models: list[str]) -> dict[str, list[str]] | None:
    """Cached cheapest tiers, or None if any model could not be resolved."""
    cache = load_cache()
    now = time.time()
    out: dict[str, list[str]] = {}
    dirty = False
    for model in models:
        entry = cache.get(model)
        if isinstance(entry, dict) and now - entry.get("at", 0) < TTL_SECONDS and entry.get("providers"):
            out[model] = entry["providers"]
            continue
        try:
            providers = cheapest_tier(model)
        except Exception:  # noqa: BLE001 — any failure means "cannot pin"
            providers = []
        if not providers:
            # Keep a previous good answer if there is one; otherwise give up on
            # the whole pin rather than emit a partial union.
            if isinstance(entry, dict) and entry.get("providers"):
                out[model] = entry["providers"]
                continue
            return None
        cache[model] = {"providers": providers, "at": now}
        out[model] = providers
        dirty = True
    if dirty:
        save_cache(cache)
    return out


def session_id() -> str:
    """Stable per checkout, so its sessions share one warm endpoint."""
    root = os.environ.get("CLAUDE_OPENROUTER_SESSION_SCOPE") or os.getcwd()
    digest = hashlib.sha256(root.encode()).hexdigest()[:16]
    return f"claude-cli-{digest}"


def main() -> int:
    models = [m for m in sys.argv[1:] if m and "/" in m]
    if not models:
        print("# no vendor/model ids given — nothing to pin", file=sys.stderr)
        return 0

    if not os.environ.get("ANTHROPIC_CUSTOM_HEADERS"):
        header = f"x-session-id: {session_id()}"
        print(f"export ANTHROPIC_CUSTOM_HEADERS={shlex.quote(header)}")

    if os.environ.get("CLAUDE_CODE_EXTRA_BODY"):
        print("# CLAUDE_CODE_EXTRA_BODY already set — leaving the operator's routing alone", file=sys.stderr)
        return 0

    tiers = tiers_for(sorted(set(models)))
    if tiers is None:
        print(
            "# could not resolve every model's provider tier — sending no provider field.\n"
            "#   A partial provider.only union 404s whichever model it omits.",
            file=sys.stderr,
        )
        return 0

    union = sorted({slug for slugs in tiers.values() for slug in slugs})
    body = json.dumps({"provider": {"only": union, "allow_fallbacks": True}}, separators=(",", ":"))
    print(f"export CLAUDE_CODE_EXTRA_BODY={shlex.quote(body)}")
    print(f"# pinned to {len(union)} provider(s) across {len(tiers)} model(s): {', '.join(union)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
