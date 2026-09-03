#!/usr/bin/env bash
# Pull both of OpenRouter's benchmark surfaces into a work directory.
#
# Neither is a superset of the other, so a selection built on one alone is
# quietly short of candidates:
#
#   /api/v1/models      model catalogue + `benchmarks.artificial_analysis`
#                       (~179 models) + `benchmarks.design_arena` including the
#                       `agents` arena. Public, no auth. Also the authoritative
#                       pricing.
#   /api/v1/benchmarks  OpenRouter's own runs — the ONLY source for
#                       tau_bench_verified_airline, gpqa_diamond and the search
#                       suite. Requires auth.
#
# The second is fetched from inside a running agent container so the OneCLI
# gateway supplies the key on the outbound leg; no credential is handled here.
#
# Usage: fetch-benchmarks.sh <work-dir> [container-name]
set -euo pipefail

WORK="${1:?usage: fetch-benchmarks.sh <work-dir> [container-name]}"
CONTAINER="${2:-$(docker ps --format '{{.Names}}' | grep -m1 nanoclaw || true)}"
mkdir -p "$WORK"

echo "==> model catalogue -> $WORK/models.json"
curl -fsS --max-time 60 "https://openrouter.ai/api/v1/models?limit=1000" > "$WORK/models.json"
python3 - "$WORK/models.json" <<'PY'
import json, sys
j = json.load(open(sys.argv[1]))
n, total = len(j["data"]), j.get("total_count")
print(f"    {n} models (total_count {total})")
if total and n < total:
    raise SystemExit(f"    paginated: only {n} of {total} fetched — raise the limit")
PY

if [ -z "$CONTAINER" ]; then
  echo "!!  no running agent container found — skipping /api/v1/benchmarks."
  echo "!!  tau-bench, GPQA and the search benchmarks will be missing."
  echo '{"data":[]}' > "$WORK/bench.json"
  exit 0
fi

echo "==> OpenRouter's own runs via container $CONTAINER -> $WORK/bench.json"
docker exec "$CONTAINER" curl -fsS --max-time 60 \
  -H "Authorization: Bearer placeholder" \
  "https://openrouter.ai/api/v1/benchmarks" > "$WORK/bench.json"
python3 - "$WORK/bench.json" <<'PY'
import json, sys
from collections import Counter
rows = json.load(open(sys.argv[1]))["data"]
print(f"    {len(rows)} rows, sources: {dict(Counter(r.get('source') for r in rows))}")
PY
