/**
 * LLM wire trace — an opt-in localhost HTTP proxy that sits between the Claude
 * Code CLI and whatever `ANTHROPIC_BASE_URL` points at, and records every
 * request and response verbatim.
 *
 * Why this exists: the session transcripts under `.claude-shared/projects/`
 * show the *conversation* (messages, tool results, a per-message `usage`), but
 * not what actually went over the wire — the composed system prompt, the tool
 * schemas, where the `cache_control` breakpoints landed, or any provider field
 * the Anthropic-compatible shim drops on the way back (reasoning-token counts
 * among them). Cost analysis that can't see those is guesswork. This closes
 * that gap: the trace is the wire.
 *
 * Where it sits:
 *
 *   claude CLI ──http──▶ this proxy ──https──▶ [OneCLI gateway] ──▶ provider
 *
 * The proxy never sees, needs, or writes a real credential. The CLI sends
 * `Authorization: Bearer placeholder`; the OneCLI gateway on the outbound leg
 * swaps in the real token. Credential-bearing headers are redacted before a
 * record is written, in both directions.
 *
 * Off unless a group opts in (`ncl groups config update --llm-trace true`) —
 * records carry the full conversation content, so turning it on is a
 * deliberate act, and the files are pruned on the same policy as container
 * logs.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Headers whose values never reach a trace file. */
const REDACTED_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'cookie',
  'set-cookie',
  'x-onecli-key',
]);

/**
 * Request headers we must not forward: `host` belongs to the proxy, not the
 * upstream, and the body framing headers are recomputed by fetch. Content
 * negotiation for compression is dropped so the captured bytes are the same
 * bytes the client gets — otherwise we'd log a gzip blob and have to re-encode
 * to keep the response header honest.
 */
const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'accept-encoding',
  'proxy-authorization',
  'proxy-connection',
  'keep-alive',
  'upgrade',
]);

/** Response headers that describe a framing we no longer reproduce verbatim. */
const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_KEEP_DAYS = 7;
const TRACE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export interface LlmTraceOptions {
  /** Where the real API lives, path prefix included (e.g. `https://openrouter.ai/api`). */
  upstreamBaseUrl: string;
  /** Directory the `<YYYY-MM-DD>.jsonl` files are appended to. Created if absent. */
  traceDir: string;
  /** Outbound proxy for the upstream leg — the OneCLI gateway in a real container. */
  proxyUrl?: string;
  /** Per-body cap for what gets *recorded*; the client always gets the full body. */
  maxBodyBytes?: number;
  /** Trace files older than this are deleted at startup. */
  keepDays?: number;
  /** Injectable clock, for tests. */
  now?: () => Date;
  /** Called when a trace write fails. Tracing must never take the agent down. */
  onError?: (err: unknown) => void;
}

export interface LlmTraceHandle {
  /** What `ANTHROPIC_BASE_URL` should be set to. */
  baseUrl: string;
  port: number;
  /** Directory the records land in. */
  traceDir: string;
  /** Resolves once every record for a completed exchange has hit disk. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

interface CapturedBody {
  /** Byte length of the whole body, whether or not it was recorded in full. */
  bytes: number;
  truncated?: boolean;
  /** Parsed JSON, when the body was complete and parseable. */
  body?: unknown;
  /** Raw text, when the body was truncated or not JSON. */
  body_text?: string;
}

/** What an Anthropic-shaped response tells us about the model and its billing. */
interface ResponseFacts {
  model?: string;
  stop_reason?: string;
  usage?: Record<string, unknown>;
}

function headerRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = REDACTED_HEADERS.has(key.toLowerCase()) ? '<redacted>' : value;
  });
  return out;
}

function captureBody(raw: Uint8Array, maxBodyBytes: number): CapturedBody {
  const bytes = raw.byteLength;
  if (bytes > maxBodyBytes) {
    return {
      bytes,
      truncated: true,
      body_text: new TextDecoder().decode(raw.subarray(0, maxBodyBytes)),
    };
  }
  const text = new TextDecoder().decode(raw);
  if (!text) return { bytes };
  try {
    return { bytes, body: JSON.parse(text) };
  } catch {
    return { bytes, body_text: text };
  }
}

/**
 * Pull the billing-relevant facts out of a non-streamed Anthropic response.
 */
function factsFromJson(body: unknown): ResponseFacts {
  if (!body || typeof body !== 'object') return {};
  const b = body as Record<string, unknown>;
  const facts: ResponseFacts = {};
  if (typeof b.model === 'string') facts.model = b.model;
  if (typeof b.stop_reason === 'string') facts.stop_reason = b.stop_reason;
  if (b.usage && typeof b.usage === 'object') facts.usage = b.usage as Record<string, unknown>;
  return facts;
}

/**
 * Pull the same facts out of an SSE stream. `message_start` carries the prompt
 * side of the usage and the model; `message_delta` carries the final
 * `output_tokens` and the stop reason, and overrides what `message_start`
 * guessed — that first `output_tokens` is always 1-ish, never the total.
 */
export function summarizeSse(raw: string): ResponseFacts {
  const facts: ResponseFacts = {};
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === 'message_start') {
      const message = event.message as Record<string, unknown> | undefined;
      if (message) {
        if (typeof message.model === 'string') facts.model = message.model;
        if (message.usage && typeof message.usage === 'object') {
          facts.usage = { ...(message.usage as Record<string, unknown>) };
        }
      }
    } else if (event.type === 'message_delta') {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (delta && typeof delta.stop_reason === 'string') facts.stop_reason = delta.stop_reason;
      if (event.usage && typeof event.usage === 'object') {
        facts.usage = { ...(facts.usage ?? {}), ...(event.usage as Record<string, unknown>) };
      }
    }
  }
  return facts;
}

/**
 * Delete `<YYYY-MM-DD>.jsonl` files older than `keepDays`. Anything that isn't
 * a dated trace file is left alone — the directory is ours, but a human may
 * well have parked notes in it. Returns the names removed.
 */
export function pruneTraceFiles(dir: string, keepDays: number, now: Date = new Date()): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const cutoff = now.getTime() - keepDays * 86_400_000;
  const removed: string[] = [];
  for (const entry of entries.sort()) {
    const match = TRACE_FILE_RE.exec(entry);
    if (!match) continue;
    if (Date.parse(`${match[1]}T00:00:00Z`) >= cutoff) continue;
    try {
      fs.unlinkSync(path.join(dir, entry));
      removed.push(entry);
    } catch {
      // A file we can't remove is not worth failing startup over.
    }
  }
  return removed;
}

/**
 * The container runs with `HTTP_PROXY`/`HTTPS_PROXY` pointed at the OneCLI
 * gateway and `NODE_USE_ENV_PROXY=1`, so an unqualified localhost URL would be
 * dialled *from the host* by the gateway and never reach us. Adding the
 * loopback names to `NO_PROXY` is what keeps the CLI's hop to the trace proxy
 * local; everything else still goes through the gateway and gets its
 * credentials injected.
 */
export function noProxyWithLoopback(current?: string): string {
  const entries = (current ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    if (!entries.includes(host)) entries.push(host);
  }
  return entries.join(',');
}

/**
 * The env the agent's CLI subprocess needs so its calls land here.
 *
 * This is returned rather than written into `process.env` for a measured
 * reason: **Bun silently drops writes to the proxy env vars.** Assigning
 * `process.env.NO_PROXY` and reading it back in the next statement yields
 * `undefined` — Bun owns those names for its own fetch configuration — while an
 * ordinary variable set the same way survives. Routing them through
 * `process.env` therefore looks correct and fails in production: the base URL
 * arrives, `NO_PROXY` does not, and every call the CLI makes to `127.0.0.1`
 * gets dialled from the host by the OneCLI gateway and reset. Merge these into
 * the env object handed to the provider instead.
 */
export function traceEnvOverrides(baseUrl: string, currentNoProxy?: string): Record<string, string> {
  const noProxy = noProxyWithLoopback(currentNoProxy);
  return { ANTHROPIC_BASE_URL: baseUrl, NO_PROXY: noProxy, no_proxy: noProxy };
}

/**
 * Start the proxy. Resolves once it is listening; the returned `baseUrl` is
 * what the CLI must be pointed at.
 */
export async function startLlmTraceProxy(options: LlmTraceOptions): Promise<LlmTraceHandle> {
  const {
    upstreamBaseUrl,
    traceDir,
    proxyUrl,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    keepDays = DEFAULT_KEEP_DAYS,
    now = () => new Date(),
    onError,
  } = options;

  fs.mkdirSync(traceDir, { recursive: true });
  pruneTraceFiles(traceDir, keepDays, now());

  const upstreamRoot = upstreamBaseUrl.replace(/\/+$/, '');
  // Serialized so concurrent exchanges can't interleave half-written lines.
  let writeChain: Promise<void> = Promise.resolve();
  let counter = 0;
  // Response drains still reading their half of the tee. `flush` waits on
  // these before the write chain, so "settled" doesn't depend on timer order.
  const draining = new Set<Promise<void>>();

  const track = (task: Promise<void>): void => {
    draining.add(task);
    void task.finally(() => draining.delete(task));
  };

  const write = (record: Record<string, unknown>): void => {
    writeChain = writeChain
      .then(async () => {
        const file = path.join(traceDir, `${now().toISOString().slice(0, 10)}.jsonl`);
        await fs.promises.appendFile(file, `${JSON.stringify(record)}\n`);
      })
      .catch((err) => {
        onError?.(err);
      });
  };

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    // A turn can sit on one streamed response for minutes; the default idle
    // timeout would cut it off mid-answer.
    idleTimeout: 255,
    async fetch(req: Request): Promise<Response> {
      const started = Date.now();
      const url = new URL(req.url);
      const record: Record<string, unknown> = {
        ts: now().toISOString(),
        id: `${started.toString(36)}-${(counter += 1).toString(36)}`,
        method: req.method,
        path: `${url.pathname}${url.search}`,
      };

      const requestBytes = new Uint8Array(await req.arrayBuffer());
      record.request = {
        headers: headerRecord(req.headers),
        ...captureBody(requestBytes, maxBodyBytes),
      };

      const forwardHeaders = new Headers();
      req.headers.forEach((value, key) => {
        if (!HOP_BY_HOP_REQUEST_HEADERS.has(key.toLowerCase())) forwardHeaders.set(key, value);
      });

      let upstreamResponse: Response;
      try {
        upstreamResponse = await fetch(`${upstreamRoot}${url.pathname}${url.search}`, {
          method: req.method,
          headers: forwardHeaders,
          body: requestBytes.byteLength > 0 ? requestBytes : undefined,
          ...(proxyUrl ? { proxy: proxyUrl } : {}),
        });
      } catch (err) {
        record.error = err instanceof Error ? err.message : String(err);
        record.duration_ms = Date.now() - started;
        write(record);
        return new Response(JSON.stringify({ type: 'error', error: { message: String(record.error) } }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        });
      }

      const responseHeaders = new Headers();
      upstreamResponse.headers.forEach((value, key) => {
        if (!HOP_BY_HOP_RESPONSE_HEADERS.has(key.toLowerCase())) responseHeaders.set(key, value);
      });
      const isSse = (upstreamResponse.headers.get('content-type') ?? '').includes('text/event-stream');
      const baseResponseRecord = {
        status: upstreamResponse.status,
        headers: headerRecord(upstreamResponse.headers),
      };

      if (!upstreamResponse.body) {
        record.response = { ...baseResponseRecord, bytes: 0 };
        record.duration_ms = Date.now() - started;
        write(record);
        return new Response(null, { status: upstreamResponse.status, headers: responseHeaders });
      }

      // One half goes to the client untouched and unbuffered; the other is
      // drained into the trace. A slow reader on either side can't stall the
      // other, because they are independent streams.
      const [toClient, toTrace] = upstreamResponse.body.tee();
      track((async () => {
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        let kept = 0;
        try {
          const reader = toTrace.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (kept < maxBodyBytes) {
              const room = maxBodyBytes - kept;
              const slice = value.byteLength <= room ? value : value.subarray(0, room);
              chunks.push(slice);
              kept += slice.byteLength;
            }
          }
        } catch (err) {
          record.stream_error = err instanceof Error ? err.message : String(err);
        }
        const text = new TextDecoder().decode(Buffer.concat(chunks));
        const truncated = bytes > kept;
        const facts = isSse ? summarizeSse(text) : {};
        const payload: Record<string, unknown> = { ...baseResponseRecord, bytes, ...facts };
        if (truncated) payload.truncated = true;
        if (isSse) {
          payload.sse = text;
        } else if (truncated) {
          payload.body_text = text;
        } else {
          try {
            const parsed = JSON.parse(text) as unknown;
            payload.body = parsed;
            Object.assign(payload, factsFromJson(parsed));
          } catch {
            if (text) payload.body_text = text;
          }
        }
        record.response = payload;
        record.duration_ms = Date.now() - started;
        write(record);
      })());

      return new Response(toClient, { status: upstreamResponse.status, headers: responseHeaders });
    },
  });

  // `port: 0` means "pick one" — read back what was actually bound. `.port` is
  // optional in the type, so `url` is the reliable source.
  const port = server.port ?? Number(server.url.port);

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    traceDir,
    async flush(): Promise<void> {
      // Drains queue their write only once the whole body has arrived, so both
      // hops have to settle — and a drain can outlive the client's read.
      await Promise.allSettled([...draining]);
      await writeChain;
    },
    async close(): Promise<void> {
      await Promise.allSettled([...draining]);
      await writeChain;
      await server.stop(true);
    },
  };
}
