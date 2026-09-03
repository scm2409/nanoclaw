#!/usr/bin/env python3
"""Per-turn cost from the wire trace — the before/after number.

    trace-cost.py <agent-group-id> [--since 2026-09-03T05:00] [--session <id>]

Reads `data/v2-sessions/<group>/*/llm-trace/*.jsonl`, which exists only while
`--llm-trace true` is set for the group. Every record carries the gateway's own
`usage.cost`, so this reports what was actually charged rather than a price
table multiplied by token counts — the two disagreed by 2.5x the first time
they were compared here.

Rows with more than five tool schemas are real agent turns; the rest are
probes and health checks.
"""
import argparse
import glob
import json
import os


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("group", help="agent group id")
    ap.add_argument("--since", default="", help="ISO prefix, e.g. 2026-09-03T05")
    ap.add_argument("--session", help="limit to one session id")
    ap.add_argument("--root", default="data/v2-sessions")
    ap.add_argument("--all", action="store_true", help="include probe requests, not just agent turns")
    args = ap.parse_args()

    pattern = os.path.join(args.root, args.group, args.session or "*", "llm-trace", "*.jsonl")
    files = sorted(glob.glob(pattern))
    if not files:
        print(f"no trace files under {pattern}")
        print("enable it: ncl groups config update --id <group> --llm-trace true")
        return 1

    rows = []
    for path in files:
        for raw in open(path):
            if raw.strip():
                rows.append(json.loads(raw))

    rows = [r for r in rows if r.get("ts", "").startswith(args.since)]
    if not args.all:
        rows = [r for r in rows if len(((r.get("request") or {}).get("body") or {}).get("tools") or []) > 5]
    if not rows:
        print("no matching records")
        return 1

    print(f"{'time':<10}{'model':<28}{'tools':>6}{'prompt':>11}{'cached':>10}{'cost':>11}  session-id")
    total = 0.0
    cached = billed = 0
    for r in rows:
        response = r.get("response") or {}
        u = response.get("usage") or {}
        read = u.get("cache_read_input_tokens") or 0
        prompt = read + (u.get("input_tokens") or 0)
        cost = u.get("cost") or 0
        total += cost
        cached += read
        billed += prompt
        print(
            f"{r['ts'][11:19]:<10}{response.get('model', '?'):<28}"
            f"{len(((r.get('request') or {}).get('body') or {}).get('tools') or []):>6}"
            f"{prompt:>11,}{read:>10,}${cost:>10.5f}  "
            f"{(r.get('request') or {}).get('headers', {}).get('x-session-id', '—')}"
        )
    share = 100 * cached / billed if billed else 0
    print(f"\n{len(rows)} turns   prompt {billed:,} tokens, {share:.0f}% from cache   total ${total:.4f}")
    print(f"mean ${total / len(rows):.5f} per turn")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
