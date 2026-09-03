#!/usr/bin/env bash
# What a Claude Code session actually cost, from the gateway's own counter.
#
# There is no wire trace for the standalone CLI the way there is for NanoClaw's
# containers, so the measurement is a before/after on `total_usage` — the
# gateway's cumulative spend for the key. Cruder than a per-request cost, but
# it is the gateway's own number rather than a price table multiplied by token
# counts, and those two disagreed by 2.5x the first time they were compared.
#
#   spend-delta.sh mark            # note the counter before a session
#   spend-delta.sh diff            # report what has been spent since
#
# Nothing else may use the same key in between, or the delta absorbs it.
set -euo pipefail

STATE="${XDG_CACHE_HOME:-$HOME/.cache}/claude-openrouter/spend-mark"
CONTAINER="${CLAUDE_OPENROUTER_PROBE_CONTAINER:-$(docker ps --format '{{.Names}}' 2>/dev/null | grep -m1 nanoclaw || true)}"

usage() { printf 'usage: %s {mark|diff}\n' "${0##*/}" >&2; exit 2; }

read_usage() {
  # The credits endpoint needs auth. Borrow it from a running agent container,
  # where the OneCLI gateway supplies the key on the outbound leg — no
  # credential is handled here. Falls back to a local key if one is exported.
  local json
  if [ -n "${OPENROUTER_API_KEY:-}" ]; then
    json=$(curl -fsS --max-time 20 -H "Authorization: Bearer $OPENROUTER_API_KEY" \
             https://openrouter.ai/api/v1/credits)
  elif [ -n "$CONTAINER" ]; then
    json=$(docker exec "$CONTAINER" curl -fsS --max-time 20 \
             -H "Authorization: Bearer placeholder" https://openrouter.ai/api/v1/credits)
  else
    echo "No running agent container and no OPENROUTER_API_KEY — cannot read the counter." >&2
    exit 1
  fi
  printf '%s' "$json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["total_usage"])'
}

case "${1:-}" in
  mark)
    mkdir -p "$(dirname "$STATE")"
    read_usage > "$STATE"
    printf 'marked at total_usage = %s\n' "$(cat "$STATE")"
    ;;
  diff)
    [ -f "$STATE" ] || { echo "No mark yet — run '${0##*/} mark' first." >&2; exit 1; }
    before=$(cat "$STATE")
    after=$(read_usage)
    python3 - "$before" "$after" <<'PY'
import sys
before, after = float(sys.argv[1]), float(sys.argv[2])
print(f"before ${before:.6f}\nafter  ${after:.6f}\nspent  ${after - before:.6f}")
PY
    ;;
  *) usage ;;
esac
