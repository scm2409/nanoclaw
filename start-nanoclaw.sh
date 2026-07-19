#!/bin/bash
# start-nanoclaw.sh — Start NanoClaw without systemd
# To stop: kill \$(cat /home/nano-01/nanoclaw/nanoclaw.pid)
#
# Guarded: on this machine NanoClaw is normally supervised by a systemd
# --user service (Restart=always). Running this script alongside that
# service starts a second process that fights the systemd-managed one over
# the webhook port and the same session state — refuse to start if that
# service exists and is active.

set -euo pipefail

cd "/home/nano-01/nanoclaw"

SYSTEMD_UNIT=$(systemctl --user list-units --all --no-legend --plain 2>/dev/null | awk '{print $1}' | grep '^nanoclaw' || true)

if [ -n "$SYSTEMD_UNIT" ] && systemctl --user is-active --quiet "$SYSTEMD_UNIT"; then
  echo "ERROR: NanoClaw is managed by systemd on this machine (unit: $SYSTEMD_UNIT)." >&2
  echo "Do not start it manually — use systemd instead:" >&2
  echo "" >&2
  echo "  systemctl --user restart $SYSTEMD_UNIT" >&2
  echo "" >&2
  echo "(status: systemctl --user status $SYSTEMD_UNIT | logs: journalctl --user -u $SYSTEMD_UNIT -f)" >&2
  exit 1
fi

# Stop existing instance if running
if [ -f "/home/nano-01/nanoclaw/nanoclaw.pid" ]; then
  OLD_PID=$(cat "/home/nano-01/nanoclaw/nanoclaw.pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing NanoClaw (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi

echo "Starting NanoClaw..."
nohup "/usr/bin/node" "/home/nano-01/nanoclaw/dist/index.js" \
  >> "/home/nano-01/nanoclaw/logs/nanoclaw.log" \
  2>> "/home/nano-01/nanoclaw/logs/nanoclaw.error.log" &

echo $! > "/home/nano-01/nanoclaw/nanoclaw.pid"
echo "NanoClaw started (PID $!)"
echo "Logs: tail -f /home/nano-01/nanoclaw/logs/nanoclaw.log"
