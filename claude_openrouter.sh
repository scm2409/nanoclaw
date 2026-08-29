#!/usr/bin/env bash
set -euo pipefail

# Route Claude Code's Anthropic-compatible requests through OpenRouter.
# OneCLI supplies and rewrites the Authorization header; no API key belongs here.
export ANTHROPIC_BASE_URL="https://openrouter.ai/api"
export ANTHROPIC_AUTH_TOKEN="placeholder"
export ANTHROPIC_API_KEY=""

# Claude Code alias targets.
export ANTHROPIC_DEFAULT_SONNET_MODEL="openai/gpt-5.6-luna"
export ANTHROPIC_DEFAULT_FABLE_MODEL="openai/gpt-5.6-sol"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="z-ai/glm-5.3-flash"
export ANTHROPIC_DEFAULT_OPUS_MODEL="z-ai/glm-5.3"

# New sessions and unspecified subagents use the requested main model / Opus model.
export ANTHROPIC_MODEL="openai/gpt-5.6-luna"
export CLAUDE_CODE_SUBAGENT_MODEL="z-ai/glm-5.3"

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
  claude --effort max "$@"
