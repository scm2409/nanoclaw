#!/usr/bin/env bash
set -euo pipefail

# Route Claude Code's Anthropic-compatible requests through OpenRouter.
# OneCLI supplies and rewrites the Authorization header; no API key belongs here.
export ANTHROPIC_BASE_URL="https://openrouter.ai/api"
export ANTHROPIC_AUTH_TOKEN="placeholder"
export ANTHROPIC_API_KEY=""

# Claude Code alias targets. Picked from OpenRouter's benchmark data against the
# metrics that match a coding harness, and every one of them proved it caches
# before being adopted — see /update-cli-models. Never a Gemini model here: they
# bill a cache above their own uncached price through this gateway.
#
#                        intel  coding  agentic   in/out $/M   warm
#   z-ai/glm-5.3-flash    57.5    71.5     58.2  0.075/0.250  $0.015/M
#   z-ai/glm-5.3          59.5    74.8     59.1  1.400/4.400  $0.143/M
#   x-ai/grok-4.6         60.9    76.8     58.7  2.000/6.000  $0.504/M
export ANTHROPIC_DEFAULT_SONNET_MODEL="z-ai/glm-5.3-flash"
export ANTHROPIC_DEFAULT_FABLE_MODEL="x-ai/grok-4.6"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="z-ai/glm-5.3-flash"
export ANTHROPIC_DEFAULT_OPUS_MODEL="z-ai/glm-5.3"

# New sessions and unspecified subagents use the requested main model / Opus model.
export ANTHROPIC_MODEL="z-ai/glm-5.3-flash"
export CLAUDE_CODE_SUBAGENT_MODEL="z-ai/glm-5.3"

# Reasoning effort is one value for the whole session, not per model, so it
# cannot follow the slots. `high` suits interactive coding without paying
# reasoning tokens on every trivial turn; raise it per session when the work
# earns it:  CLAUDE_EFFORT=max ./claude_openrouter.sh
CLAUDE_EFFORT="${CLAUDE_EFFORT:-high}"

# Make the caching actually pay off. This emits two exports:
#   CLAUDE_CODE_EXTRA_BODY  — a provider.only union over the cheapest endpoint
#                             tier of EVERY model above. The gateway serves one
#                             model from many endpoints at up to twice the
#                             price, and a cache lives on the endpoint that
#                             wrote it. Pass every model id: a union missing one
#                             is a 404 for that model, and allow_fallbacks does
#                             not rescue it.
#   ANTHROPIC_CUSTOM_HEADERS — an x-session-id keyed to this directory, so the
#                             checkout's sessions share one warm prefix.
# Provider tiers are cached for a day; a warm start costs ~90ms. Either
# variable you set yourself is left alone.
eval "$(python3 "$(dirname "$0")/.claude/skills/update-cli-models/scripts/openrouter-env.py" \
  "$ANTHROPIC_MODEL" \
  "$ANTHROPIC_DEFAULT_SONNET_MODEL" \
  "$ANTHROPIC_DEFAULT_FABLE_MODEL" \
  "$ANTHROPIC_DEFAULT_HAIKU_MODEL" \
  "$ANTHROPIC_DEFAULT_OPUS_MODEL" \
  "$CLAUDE_CODE_SUBAGENT_MODEL")"

exec onecli run -- env \
  ANTHROPIC_BASE_URL="$ANTHROPIC_BASE_URL" \
  ANTHROPIC_AUTH_TOKEN="$ANTHROPIC_AUTH_TOKEN" \
  ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  ANTHROPIC_DEFAULT_SONNET_MODEL="$ANTHROPIC_DEFAULT_SONNET_MODEL" \
  ANTHROPIC_DEFAULT_FABLE_MODEL="$ANTHROPIC_DEFAULT_FABLE_MODEL" \
  ANTHROPIC_DEFAULT_HAIKU_MODEL="$ANTHROPIC_DEFAULT_HAIKU_MODEL" \
  ANTHROPIC_DEFAULT_OPUS_MODEL="$ANTHROPIC_DEFAULT_OPUS_MODEL" \
  ANTHROPIC_MODEL="$ANTHROPIC_MODEL" \
  CLAUDE_CODE_SUBAGENT_MODEL="$CLAUDE_CODE_SUBAGENT_MODEL" \
  ANTHROPIC_CUSTOM_HEADERS="${ANTHROPIC_CUSTOM_HEADERS:-}" \
  CLAUDE_CODE_EXTRA_BODY="${CLAUDE_CODE_EXTRA_BODY:-}" \
  claude --effort "$CLAUDE_EFFORT" "$@"
