/**
 * Claude provider container config — only registered when the user has
 * configured a custom Anthropic-compatible endpoint via setup. Setup
 * appends `import './claude.js'` to providers/index.ts at that point;
 * standard installs hitting api.anthropic.com don't need this file
 * loaded.
 *
 * The real auth token never enters the container. Setup creates an
 * OneCLI generic secret (host-pattern = base URL hostname, header-name
 * = Authorization, value-format = "Bearer {value}") so the proxy
 * rewrites the Authorization header on the wire. The container only
 * needs:
 *   - ANTHROPIC_BASE_URL — so the SDK knows where to call
 *   - ANTHROPIC_AUTH_TOKEN=placeholder — so the SDK adds an
 *     Authorization: Bearer header for OneCLI to overwrite
 *
 * The one other var this passes through is
 * CLAUDE_CODE_AUTO_COMPACT_WINDOW: the container's Claude provider
 * documents it as an operator override, and only reaches the container
 * if the host forwards it — nothing else in the spawn path carries host
 * environment. See container/agent-runner/src/providers/claude.ts.
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

/** Host env vars this provider forwards verbatim (after validation). */
const AUTO_COMPACT_WINDOW = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';

/**
 * Build the container env from the host process env and `.env`. Pure, so the
 * precedence and validation rules are testable without touching the filesystem.
 * Process env wins over `.env` — an operator emergency-tuning a running service
 * shouldn't have their shell override silently lose to a stale file.
 */
export function resolveClaudeContainerEnv(
  hostEnv: NodeJS.ProcessEnv,
  dotenv: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};

  if (dotenv.ANTHROPIC_BASE_URL) {
    env.ANTHROPIC_BASE_URL = dotenv.ANTHROPIC_BASE_URL;
    env.ANTHROPIC_AUTH_TOKEN = 'placeholder';
  }

  const window = hostEnv[AUTO_COMPACT_WINDOW] || dotenv[AUTO_COMPACT_WINDOW];
  if (window) {
    if (/^\d+$/.test(window) && Number(window) > 0) {
      env[AUTO_COMPACT_WINDOW] = window;
    } else {
      log.warn(`Ignoring non-numeric ${AUTO_COMPACT_WINDOW}`, { value: window });
    }
  }

  return env;
}

registerProviderContainerConfig('claude', ({ hostEnv }) => ({
  env: resolveClaudeContainerEnv(hostEnv, readEnvFile(['ANTHROPIC_BASE_URL', AUTO_COMPACT_WINDOW])),
}));
