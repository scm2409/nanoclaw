/**
 * Runner config — reads /workspace/agent/container.json at startup.
 *
 * This file is mounted read-only inside the container. The host writes it;
 * the runner only reads. All NanoClaw-specific configuration lives here
 * instead of environment variables.
 */
import fs from 'fs';

const CONFIG_PATH = '/workspace/agent/container.json';

export interface RunnerConfig {
  provider: string;
  assistantName: string;
  groupName: string;
  agentGroupId: string;
  maxMessagesPerPrompt: number;
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  model?: string;
  effort?: string;
  logSubagents?: boolean;
  showTokenUsage?: boolean;
  /** Days before a chat transcript rotates. Undefined = provider default. */
  transcriptRotateDays?: number;
  /** Record every LLM request/response to /workspace/llm-trace. Off by default. */
  llmTrace?: boolean;
  /** Days a trace file is kept. Undefined = the trace module's own default. */
  llmTraceKeepDays?: number;
  /**
   * Which upstream provider endpoints the gateway may route to. Built by the
   * host as the union of every model this container runs; absent means leave
   * the choice to the gateway.
   */
  providerPin?: { only: string[]; allow_fallbacks: boolean };
}

const DEFAULT_MAX_MESSAGES = 10;

/** A pin is only usable if it names at least one provider — see providerPinEnv. */
function isProviderPin(value: unknown): value is { only: string[]; allow_fallbacks: boolean } {
  if (!value || typeof value !== 'object') return false;
  const v = value as { only?: unknown; allow_fallbacks?: unknown };
  return (
    Array.isArray(v.only) &&
    v.only.length > 0 &&
    v.only.every((s) => typeof s === 'string' && s.length > 0) &&
    typeof v.allow_fallbacks === 'boolean'
  );
}

let _config: RunnerConfig | null = null;

/**
 * Load config from container.json. Called once at startup.
 * Falls back to sensible defaults for any missing field.
 */
export function loadConfig(): RunnerConfig {
  if (_config) return _config;

  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    console.error(`[config] Failed to read ${CONFIG_PATH}, using defaults`);
  }

  _config = {
    provider: (raw.provider as string) || 'claude',
    assistantName: (raw.assistantName as string) || '',
    groupName: (raw.groupName as string) || '',
    agentGroupId: (raw.agentGroupId as string) || '',
    maxMessagesPerPrompt: (raw.maxMessagesPerPrompt as number) || DEFAULT_MAX_MESSAGES,
    mcpServers: (raw.mcpServers as RunnerConfig['mcpServers']) || {},
    model: (raw.model as string) || undefined,
    effort: (raw.effort as string) || undefined,
    logSubagents: raw.logSubagents === true,
    showTokenUsage: raw.showTokenUsage === true,
    transcriptRotateDays: typeof raw.transcriptRotateDays === 'number' ? raw.transcriptRotateDays : undefined,
    llmTrace: raw.llmTrace === true,
    llmTraceKeepDays: typeof raw.llmTraceKeepDays === 'number' ? raw.llmTraceKeepDays : undefined,
    providerPin: isProviderPin(raw.providerPin) ? raw.providerPin : undefined,
  };

  return _config;
}

/** Get the loaded config. Throws if loadConfig() hasn't been called. */
export function getConfig(): RunnerConfig {
  if (!_config) throw new Error('Config not loaded — call loadConfig() first');
  return _config;
}
