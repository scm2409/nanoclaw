/**
 * Startup health probe for configured MCP servers.
 *
 * The SDK spawns an MCP server lazily and, if that process dies or never
 * completes its handshake, simply continues without the server's tools. No
 * error surfaces anywhere: the agent just finds itself without the tools it
 * was told it has, and reports that to the user as if it were a fact about the
 * world. That is exactly how a broken `nextcloud-mcp-server` install went
 * unnoticed for hours of scheduled runs — the runner had logged "Additional
 * MCP server: nextcloud" at startup and never checked it came up.
 *
 * This probe closes that gap: spawn each server the same way the SDK will,
 * drive a real `initialize` + `tools/list` handshake, and report what came
 * back. Best-effort and time-boxed — a probe failure never blocks startup, it
 * just gets logged loudly enough to be findable.
 */
import { spawn } from 'child_process';

export interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpProbeResult {
  name: string;
  ok: boolean;
  /** Number of tools the server advertised, when the handshake completed. */
  toolCount?: number;
  /** Failure reason — the decisive stderr line where the server produced one. */
  error?: string;
}

export interface ProbeOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** Keep log lines and error fields bounded — stderr can be a whole traceback. */
function lastMeaningfulLine(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1].slice(0, 300) : '';
}

/**
 * Spawn one MCP server, handshake, and resolve with what it advertised.
 * Never rejects: a probe is diagnostic, so every failure mode comes back as
 * `ok: false` with a reason.
 */
export function probeMcpServer(name: string, server: McpServerSpec, opts: ProbeOptions = {}): Promise<McpProbeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<McpProbeResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(server.command, server.args, {
        env: { ...process.env, ...server.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ name, ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    let settled = false;
    let stdout = '';
    let stderr = '';

    const finish = (result: Omit<McpProbeResult, 'name'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolve({ name, ...result });
    };

    const timer = setTimeout(() => {
      const tail = lastMeaningfulLine(stderr);
      finish({
        ok: false,
        error: `handshake timed out after ${timeoutMs}ms${tail ? ` — last stderr: ${tail}` : ''}`,
      });
    }, timeoutMs);

    child.on('error', (err: Error) => finish({ ok: false, error: err.message }));

    child.on('exit', (code) => {
      const tail = lastMeaningfulLine(stderr);
      finish({
        ok: false,
        error: `exited with code ${code ?? 'null'} before completing the handshake${tail ? ` — ${tail}` : ''}`,
      });
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      let nl: number;
      while ((nl = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, nl).trim();
        stdout = stdout.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: number; result?: { tools?: unknown[] }; error?: { message?: string } };
        try {
          msg = JSON.parse(line);
        } catch {
          // Servers are entitled to write non-JSON noise to stdout before the
          // stream settles; only well-formed JSON-RPC counts.
          continue;
        }
        if (msg.id === 1 && msg.result) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (msg.id === 2) {
          if (msg.error) {
            finish({ ok: false, error: msg.error.message ?? 'tools/list returned an error' });
          } else {
            finish({ ok: true, toolCount: msg.result?.tools?.length ?? 0 });
          }
          return;
        }
      }
    });

    const send = (payload: unknown): void => {
      try {
        child.stdin?.write(`${JSON.stringify(payload)}\n`);
      } catch {
        // Broken pipe means the child is already gone; the exit handler reports it.
      }
    };

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'nanoclaw-health-probe', version: '1' },
      },
    });
  });
}

/** Probe every server concurrently; one failure never masks another. */
export async function probeMcpServers(
  servers: Record<string, McpServerSpec>,
  opts: ProbeOptions = {},
): Promise<McpProbeResult[]> {
  return Promise.all(Object.entries(servers).map(([name, spec]) => probeMcpServer(name, spec, opts)));
}
