/**
 * NanoClaw Agent Runner v2
 *
 * Runs inside a container. All IO goes through the session DB.
 * No stdin, no stdout markers, no IPC files.
 *
 * Config is read from /workspace/agent/container.json (mounted RO).
 * Only TZ and OneCLI networking vars come from env.
 *
 * Mount structure:
 *   /workspace/
 *     inbound.db        ← host-owned session DB (container reads only)
 *     outbound.db       ← container-owned session DB
 *     .heartbeat        ← container touches for liveness detection
 *     outbox/           ← outbound files
 *     agent/            ← agent group folder (CLAUDE.md, container.json, working files)
 *       container.json  ← per-group config (RO nested mount)
 *     global/           ← shared global memory (RO)
 *   /app/src/           ← shared agent-runner source (RO)
 *   /app/skills/        ← shared skills (RO)
 *   /home/node/.claude/ ← Claude SDK state + skill symlinks (RW)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadConfig } from './config.js';
import { buildSystemPromptAddendum } from './destinations.js';
import { getTaskSeriesId } from './db/session-routing.js';
import { ensureMemoryScaffold } from './memory/scaffold.js';
import { MEMORY_SESSION_HOOK } from './memory/session-hook.js';
// Providers barrel — each enabled provider self-registers on import.
// Provider skills append imports to providers/index.ts.
import './providers/index.js';
import { createProvider, type ProviderName } from './providers/factory.js';
import { probeMcpServers } from './mcp-health.js';
import { startLlmTraceProxy, traceEnvOverrides } from './llm-trace.js';
import { runPollLoop } from './poll-loop.js';

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

const CWD = '/workspace/agent';

async function main(): Promise<void> {
  const config = loadConfig();
  const providerName = config.provider.toLowerCase() as ProviderName;

  log(`Starting v2 agent-runner (provider: ${providerName})`);

  // Every provider shares one persistent memory tree. Legacy imports are an
  // operator-run migration and never happen in this normal startup path.
  ensureMemoryScaffold();

  // Runtime-generated system-prompt addendum: agent identity (name) plus
  // the live destinations map. Everything else (capabilities, per-module
  // instructions, per-channel formatting) is loaded by Claude Code from
  // /workspace/agent/CLAUDE.md — the composed entry imports the shared
  // base (/app/CLAUDE.md) and each enabled module's fragment. Memory is
  // supplied separately by each provider's native lifecycle hook.
  const taskId = getTaskSeriesId();
  const instructions = buildSystemPromptAddendum(
    config.assistantName || undefined,
    taskId ? { kind: 'task', taskId } : { kind: 'chat' },
  );

  // Discover additional directories mounted at /workspace/extra/*
  const additionalDirectories: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        additionalDirectories.push(fullPath);
      }
    }
    if (additionalDirectories.length > 0) {
      log(`Additional directories: ${additionalDirectories.join(', ')}`);
    }
  }

  // MCP server path — bun runs TS directly; no tsc build step in-image.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'mcp-tools', 'index.ts');

  // Build MCP servers config: nanoclaw built-in + any from container.json
  const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {
    nanoclaw: {
      command: 'bun',
      args: ['run', mcpServerPath],
      env: {},
    },
  };

  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    mcpServers[name] = serverConfig;
    log(`Additional MCP server: ${name} (${serverConfig.command})`);
  }

  // The line above only says a server was *configured*. The SDK spawns it
  // lazily and, when it dies or never handshakes, drops it without an error —
  // leaving the agent to report "I have no such tools" as if that were a fact
  // about the world. Probe them for real so the failure is visible in the log.
  // Deliberately not awaited: this is diagnostic, and the poll loop must not
  // wait on a Nextcloud round-trip before it can answer the first message.
  if (Object.keys(config.mcpServers).length > 0) {
    void probeMcpServers(config.mcpServers).then((results) => {
      for (const r of results) {
        if (r.ok) {
          log(`MCP server "${r.name}" healthy (${r.toolCount} tools)`);
        } else {
          log(
            `WARNING: MCP server "${r.name}" failed its health probe — ${r.error}. ` +
              `Any subagent claiming it will run without its tools.`,
          );
        }
      }
    });
  }

  // Wire trace: point the CLI at a local recording proxy instead of the real
  // endpoint. The overrides are merged into the provider's env below rather
  // than written to process.env — Bun drops writes to the proxy env vars, so
  // NO_PROXY would silently never reach the CLI. See traceEnvOverrides.
  // A failure here is diagnostic-only: the agent runs untraced, not not at all.
  let traceEnv: Record<string, string> = {};
  if (config.llmTrace) {
    try {
      const upstream = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
      const trace = await startLlmTraceProxy({
        upstreamBaseUrl: upstream,
        traceDir: '/workspace/llm-trace',
        proxyUrl: process.env.HTTPS_PROXY || process.env.https_proxy,
        onError: (err) => log(`LLM trace write failed: ${err instanceof Error ? err.message : String(err)}`),
      });
      traceEnv = traceEnvOverrides(trace.baseUrl, process.env.NO_PROXY);
      log(`LLM trace ON — recording ${upstream} to ${trace.traceDir} via ${trace.baseUrl}`);
    } catch (err) {
      log(`LLM trace failed to start, continuing untraced: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const provider = createProvider(providerName, {
    assistantName: config.assistantName || undefined,
    mcpServers,
    env: { ...process.env, ...traceEnv },
    additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
    model: config.model,
    effort: config.effort,
    transcriptRotateDays: config.transcriptRotateDays,
  });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);

  await runPollLoop({
    provider,
    providerName,
    cwd: CWD,
    systemContext: { instructions },
    logSubagents: config.logSubagents,
    showTokenUsage: config.showTokenUsage,
  });
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
