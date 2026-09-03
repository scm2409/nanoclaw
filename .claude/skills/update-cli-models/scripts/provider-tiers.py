#!/usr/bin/env python3
"""Cheapest-tier provider slugs per model, and the union across models.

    provider-tiers.py <model-id> [more model ids...]

The gateway serves one model from many endpoints at different prices, and it
picks per request unless told otherwise. `provider.only` bounds that choice;
this prints what to bound it to.

Two things this exists to get right:

* The slug `provider.only` accepts is the part of the endpoint's `tag` before
  the quantisation suffix (`z-ai/fp8` -> `z-ai`), NOT the display
  `provider_name` (`Z.AI`). The wrong form is a 404.
* One container's env applies to every model it runs, subagents included, so
  the pin must be the **union** across all of them. A list containing no
  provider that serves a requested model is a 404 even with
  `allow_fallbacks: true` — measured. Pass every model the group runs.

NanoClaw maintains this automatically (`src/provider-pins.ts`, refreshed daily
from the host sweep). Use this to inspect what it will produce, or to check a
candidate before adopting it.
"""
import json
import sys
import urllib.request

TIMEOUT = 25


def endpoints(model: str):
    url = f"https://openrouter.ai/api/v1/models/{model}/endpoints"
    with urllib.request.urlopen(url, timeout=TIMEOUT) as r:
        return json.load(r)["data"]["endpoints"]


def cheapest_tier(eps):
    priced = []
    for e in eps:
        if isinstance(e.get("status"), (int, float)) and e["status"] < 0:
            continue  # deranked or down: a price saving is not worth failed turns
        try:
            price = float(e.get("pricing", {}).get("prompt"))
        except (TypeError, ValueError):
            continue
        if price <= 0:
            continue
        slug = (e.get("tag") or "").split("/")[0].strip()
        if slug:
            priced.append((slug, price))
    if not priced:
        return [], None
    floor = min(p for _, p in priced)
    return sorted({s for s, p in priced if p == floor}), floor


def main() -> int:
    models = sys.argv[1:]
    if not models:
        print(__doc__)
        return 2
    union: set[str] = set()
    complete = True
    for model in models:
        try:
            eps = endpoints(model)
        except Exception as err:  # noqa: BLE001 — any failure means "cannot pin"
            print(f"{model:<34} lookup failed: {err}")
            complete = False
            continue
        slugs, floor = cheapest_tier(eps)
        tiers = sorted({float(e.get('pricing', {}).get('prompt') or 0) for e in eps if e.get('pricing', {}).get('prompt')})
        print(
            f"{model:<34} {len(eps):>3} endpoints, "
            f"{len(tiers)} price levels, cheapest ${(floor or 0) * 1e6:.4f}/M -> {slugs}"
        )
        if not slugs:
            complete = False
        union |= set(slugs)

    print()
    if not complete:
        print("Incomplete: at least one model has no usable tier, so NO pin should be sent.")
        print("A partial provider.only union 404s whichever model it omits.")
        return 1
    print("provider field to send:")
    print(json.dumps({"provider": {"only": sorted(union), "allow_fallbacks": True}}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
