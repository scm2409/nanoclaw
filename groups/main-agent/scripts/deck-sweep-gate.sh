#!/usr/bin/env bash
#
# Pre-agent gate for the Deck sweep.
#
# Runs inside the agent container before any model call. Its last stdout line
# is the contract: {"wakeAgent": false} ends the run with zero model tokens,
# {"wakeAgent": true, "data": {...}} wakes the agent and appends data to the
# prompt. See docs/scheduled-tasks.md.
#
# Why: the sweep woke a model 24x/day to learn that a two-card board had not
# changed. This asks the Deck REST API the same question for free.
#
# Watched stacks are "To do" and "Doing" only. Review is an automation gate --
# a card parked there is deliberately off-limits until a human moves it -- and
# Done is finished work, so a change in either must never wake anything.
#
# Credentials: the OneCLI gateway rewrites the Authorization header at request
# time, so the password sent here is a placeholder and never a real secret.
#
# Install-specific values (wiki host, account, board and stack ids) live in an
# untracked `deck-sweep-gate.env` beside this file, not in it. This script is
# committed to a public repo; the same reason `instructions.prepend.md` names
# no hosts applies here.
#
# Note on convergence: the agent's own edits change lastModified, so acting on
# a card produces exactly one extra wake on the following tick. That is
# intended -- it is how the agent picks work back up -- and it terminates,
# because finished or blocked cards leave the watched stacks for Review.
#
# Why a delta gate is not enough on its own: a card can carry an unexecuted
# next step -- a GO, a hand-off note, an uncollected harvest -- without ever
# changing again. Pure delta delivers such a card exactly once; if the woken
# instance does not act on it (deferred, cut off, container gone), no later
# tick ever mentions it and the card waits forever. So every FORCE_FULL_EVERY
# ticks the gate wakes the agent regardless of the fingerprint and hands it
# every card in the watched stacks, not just the moved ones.
set -uo pipefail

# deck-sweep-gate.env defines: NC_HOST, NC_USER, BOARD_ID, WATCHED_STACKS, and
# optionally FORCE_FULL_EVERY.
# Missing config is a hard failure, not a quiet "nothing to do" -- see the
# fetch guard below for why that distinction matters here.
# Not derived from BASH_SOURCE: the runner copies this script to /tmp before
# executing it, so the path it runs from says nothing about where it lives.
CONFIG_FILE=${DECK_GATE_CONFIG:-/workspace/agent/scripts/deck-sweep-gate.env}
if [ ! -r "$CONFIG_FILE" ]; then
  echo "deck-sweep-gate: missing config $CONFIG_FILE (see deck-sweep-gate.env.example)" >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$CONFIG_FILE"

for required in NC_HOST NC_USER BOARD_ID WATCHED_STACKS; do
  if [ -z "${!required:-}" ]; then
    echo "deck-sweep-gate: $required not set in $CONFIG_FILE" >&2
    exit 1
  fi
done

# Ticks between forced full sweeps; 0 disables them and leaves a pure delta
# gate. Defaulted here rather than required, so an existing config file keeps
# working across this change.
FORCE_FULL_EVERY=${FORCE_FULL_EVERY:-8}

# Overridable so the script can be exercised outside the container
# (`DECK_GATE_STATE=/tmp/x onecli run -- bash deck-sweep-gate.sh`).
STATE_FILE=${DECK_GATE_STATE:-/workspace/agent/deck-sweep-gate.state}
API="$NC_HOST/index.php/apps/deck/api/v1.0/boards/$BOARD_ID/stacks"

# A failed fetch must NOT be reported as "nothing to do": exiting non-zero
# marks the run failed, which backs the series off (2/4/8/16/32/60 min) and
# auto-pauses it after 8 consecutive failures instead of silently going blind.
body=$(curl -sS --fail --max-time 20 \
  -u "$NC_USER:onecli-managed" \
  -H 'Content-Type: application/json' \
  "$API") || { echo "deck-sweep-gate: fetch failed" >&2; exit 1; }

# Line 1 is the fingerprint, line 2 the tick counter. A state file written by
# the pre-counter gate has only line 1, which reads as tick 0 -- the first run
# after the upgrade is then an ordinary delta run, not a forced sweep.
previous=""
ticks=0
if [ -f "$STATE_FILE" ]; then
  previous=$(head -1 "$STATE_FILE")
  ticks=$(sed -n 2p "$STATE_FILE")
fi

# node, not jq/python3 -- neither is in the agent image.
result=$(WATCHED="$WATCHED_STACKS" PREVIOUS="$previous" TICKS="$ticks" \
  FORCE_EVERY="$FORCE_FULL_EVERY" node -e '
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  const watched = new Set(process.env.WATCHED.split(/\s+/).filter(Boolean).map(Number));
  const stacks = JSON.parse(raw).filter((s) => watched.has(s.id));

  const cards = [];
  for (const s of stacks) {
    for (const c of s.cards || []) {
      if (c.archived || c.deletedAt) continue;
      cards.push({
        id: c.id,
        title: c.title,
        stack: s.title,
        // lastModified covers edits and moves; commentsCount covers a new
        // question on an otherwise untouched card; overdue changes on its own
        // as a due date passes, with no edit to notice.
        sig: [c.id, c.lastModified, c.commentsCount ?? 0, c.overdue ?? 0].join(":"),
      });
    }
  }
  cards.sort((a, b) => a.id - b.id);

  const fingerprint = cards.map((c) => c.sig).join("|");
  const before = new Map(
    process.env.PREVIOUS.split("|").filter(Boolean).map((s) => [s.split(":")[0], s]),
  );
  const changed = cards.filter((c) => before.get(String(c.id)) !== c.sig);
  const brief = (c) => ({ id: c.id, title: c.title, stack: c.stack });

  // An empty board is never worth a model call, even though going from
  // two cards to none is technically a change -- and a forced full sweep of
  // nothing is worth even less, so both wake paths require cards.
  const forceEvery = Number(process.env.FORCE_EVERY) || 0;
  const ticks = (Number(process.env.TICKS) || 0) + 1;
  const full = cards.length > 0 && forceEvery > 0 && ticks >= forceEvery;
  const delta = cards.length > 0 && fingerprint !== process.env.PREVIOUS;

  let decision = { wakeAgent: false };
  if (full) {
    // changed stays honest (it can be empty); cards is what makes this a full
    // sweep -- the agent is meant to re-read every one of them for an
    // unexecuted next step, not just the moved ones.
    decision = {
      wakeAgent: true,
      data: {
        watchedStacks: stacks.map((s) => s.title),
        fullSweep: true,
        cards: cards.map(brief),
        changed: changed.map(brief),
        unchanged: cards.length - changed.length,
      },
    };
  } else if (delta) {
    decision = {
      wakeAgent: true,
      data: {
        watchedStacks: stacks.map((s) => s.title),
        changed: changed.map(brief),
        unchanged: cards.length - changed.length,
      },
    };
  }

  // Only a forced sweep resets the counter. A delta wake shows the agent the
  // moved cards only, so it does not cover the gap the full sweep exists for
  // and must not postpone it.
  const nextTicks = full ? 0 : ticks;

  // Line 1 and 2 are the new state for bash to persist; line 3 is the contract.
  process.stdout.write(fingerprint + "\n" + nextTicks + "\n" + JSON.stringify(decision) + "\n");
});
' <<< "$body") || { echo "deck-sweep-gate: parse failed" >&2; exit 1; }

fingerprint=$(printf '%s\n' "$result" | head -1)
next_ticks=$(printf '%s\n' "$result" | sed -n 2p)
decision=$(printf '%s\n' "$result" | tail -1)

# Persist before deciding: a wake that isn't recorded repeats forever.
mkdir -p "$(dirname "$STATE_FILE")"
printf '%s\n%s' "$fingerprint" "$next_ticks" > "$STATE_FILE"

echo "$decision"
