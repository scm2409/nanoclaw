// Host-side provider container-config barrel.
// Providers that need host-side container setup (extra mounts, env passthrough,
// per-session directories) self-register on import. Providers with no host
// needs (claude) don't appear here.
//
// Skills add a new provider by appending one import line below.
import './claude.js';

// Claude provider reads ANTHROPIC_BASE_URL from .env and passes a placeholder
// bearer token into containers so OneCLI can inject the configured secret.
// Keep this registration active for Anthropic-compatible endpoints such as
// OpenRouter; the provider itself remains NanoClaw's Claude Code harness.
