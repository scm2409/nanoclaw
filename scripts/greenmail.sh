#!/usr/bin/env bash
# Local throwaway mail server for the email channel's live suite.
#
# GreenMail speaks real SMTP and real IMAP, keeps everything in memory, and
# (with auth disabled) creates any account on first login. That makes the full
# round trip testable without a real mailbox: inject a message over SMTP, let
# the adapter read it over IMAP, and read the adapter's reply back out of the
# recipient's own IMAP mailbox.
#
# Deliberately NOT a mail-testing SaaS: Mailtrap's sandbox cannot be read over
# IMAP at all (web UI / REST only), so it can verify the outbound half and none
# of the inbound half — which is the half where the allowlist lives.
#
#   scripts/greenmail.sh up      start (idempotent, waits until reachable)
#   scripts/greenmail.sh down    stop and remove
#   scripts/greenmail.sh logs    tail the server log
set -euo pipefail

NAME=nanoclaw-greenmail
IMAGE=greenmail/standalone:2.0.1
SMTP_PORT=3025
IMAP_PORT=3143

case "${1:-up}" in
  up)
    if [ -n "$(docker ps -q -f "name=^${NAME}$")" ]; then
      echo "GreenMail already running (smtp ${SMTP_PORT}, imap ${IMAP_PORT})"
      exit 0
    fi
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" \
      -e GREENMAIL_OPTS='-Dgreenmail.setup.test.all -Dgreenmail.auth.disabled -Dgreenmail.hostname=0.0.0.0' \
      -p "${SMTP_PORT}:${SMTP_PORT}" -p "${IMAP_PORT}:${IMAP_PORT}" \
      "$IMAGE" >/dev/null

    for _ in $(seq 1 30); do
      if (exec 3<>"/dev/tcp/127.0.0.1/${IMAP_PORT}") 2>/dev/null; then
        echo "GreenMail up (smtp ${SMTP_PORT}, imap ${IMAP_PORT})"
        exit 0
      fi
      sleep 1
    done
    echo "GreenMail did not become reachable on port ${IMAP_PORT}" >&2
    docker logs "$NAME" >&2 || true
    exit 1
    ;;
  down)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    echo "GreenMail down"
    ;;
  logs)
    docker logs -f "$NAME"
    ;;
  *)
    echo "usage: scripts/greenmail.sh [up|down|logs]" >&2
    exit 2
    ;;
esac
