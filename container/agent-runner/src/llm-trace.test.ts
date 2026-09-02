import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  noProxyWithLoopback,
  pruneTraceFiles,
  startLlmTraceProxy,
  traceEnvOverrides,
  type LlmTraceHandle,
} from './llm-trace.js';

let traceDir: string;
let upstream: ReturnType<typeof Bun.serve> | null = null;
let handle: LlmTraceHandle | null = null;

/** Read every record written so far, newest last. */
function records(): Array<Record<string, unknown>> {
  const files = fs.existsSync(traceDir) ? fs.readdirSync(traceDir).filter((f) => f.endsWith('.jsonl')) : [];
  return files
    .flatMap((f) => fs.readFileSync(path.join(traceDir, f), 'utf-8').split('\n'))
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

beforeEach(() => {
  traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-trace-'));
});

afterEach(async () => {
  await handle?.close();
  handle = null;
  upstream?.stop(true);
  upstream = null;
  fs.rmSync(traceDir, { recursive: true, force: true });
});

describe('startLlmTraceProxy', () => {
  it('forwards the request and returns the upstream response verbatim', async () => {
    let seenAuth: string | null = null;
    let seenBody: string | null = null;
    upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        seenAuth = req.headers.get('authorization');
        seenBody = await req.text();
        return new Response(JSON.stringify({ id: 'msg_1', ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    handle = await startLlmTraceProxy({ upstreamBaseUrl: upstream.url.origin, traceDir });

    const res = await fetch(`${handle.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer placeholder' },
      body: JSON.stringify({ model: 'test', messages: [] }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'msg_1', ok: true });
    // Credentials must reach the upstream untouched — OneCLI rewrites them further out.
    expect(seenAuth).toBe('Bearer placeholder');
    expect(JSON.parse(seenBody!)).toEqual({ model: 'test', messages: [] });
  });

  it('writes a trace record with method, path, parsed request body and status', async () => {
    upstream = Bun.serve({
      port: 0,
      fetch: () => new Response(JSON.stringify({ id: 'msg_2' }), { headers: { 'content-type': 'application/json' } }),
    });
    handle = await startLlmTraceProxy({ upstreamBaseUrl: upstream.url.origin, traceDir });

    await fetch(`${handle.baseUrl}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sonnet', system: 'you are a test' }),
    });
    await handle.flush();

    const [rec] = records();
    expect(rec.method).toBe('POST');
    expect(rec.path).toBe('/v1/messages?beta=true');
    expect((rec.request as { body: { system: string } }).body.system).toBe('you are a test');
    expect((rec.response as { status: number }).status).toBe(200);
    expect((rec.response as { body: { id: string } }).body.id).toBe('msg_2');
    expect(typeof rec.duration_ms).toBe('number');
    expect(typeof rec.ts).toBe('string');
  });

  it('redacts credential headers in the trace', async () => {
    upstream = Bun.serve({
      port: 0,
      fetch: () => new Response('{}', { headers: { 'content-type': 'application/json', 'set-cookie': 'a=b' } }),
    });
    handle = await startLlmTraceProxy({ upstreamBaseUrl: upstream.url.origin, traceDir });

    await fetch(`${handle.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer sk-super-secret',
        'x-api-key': 'sk-also-secret',
      },
      body: '{}',
    });
    await handle.flush();

    const line = fs.readFileSync(path.join(traceDir, fs.readdirSync(traceDir)[0]), 'utf-8');
    expect(line).not.toContain('sk-super-secret');
    expect(line).not.toContain('sk-also-secret');
    const [rec] = records();
    const reqHeaders = (rec.request as { headers: Record<string, string> }).headers;
    expect(reqHeaders.authorization).toBe('<redacted>');
    expect(reqHeaders['x-api-key']).toBe('<redacted>');
    const resHeaders = (rec.response as { headers: Record<string, string> }).headers;
    expect(resHeaders['set-cookie']).toBe('<redacted>');
  });

  it('streams an SSE response through and extracts model, usage and stop reason', async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"model":"google/gemini-3.7-flash","usage":{"input_tokens":11,"cache_read_input_tokens":22,"cache_creation_input_tokens":33,"output_tokens":1}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":44}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n');
    upstream = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(sse.slice(0, 120)));
              controller.enqueue(new TextEncoder().encode(sse.slice(120)));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    });
    handle = await startLlmTraceProxy({ upstreamBaseUrl: upstream.url.origin, traceDir });

    const res = await fetch(`${handle.baseUrl}/v1/messages`, { method: 'POST', body: '{"stream":true}' });
    expect(await res.text()).toBe(sse);
    await handle.flush();

    const [rec] = records();
    const response = rec.response as {
      model: string;
      stop_reason: string;
      usage: Record<string, number>;
      sse: string;
    };
    expect(response.model).toBe('google/gemini-3.7-flash');
    expect(response.stop_reason).toBe('end_turn');
    // message_delta's output_tokens is the authoritative final count.
    expect(response.usage).toEqual({
      input_tokens: 11,
      cache_read_input_tokens: 22,
      cache_creation_input_tokens: 33,
      output_tokens: 44,
    });
    expect(response.sse).toContain('content_block_delta');
  });

  it('truncates bodies past maxBodyBytes and flags it', async () => {
    const big = 'x'.repeat(5000);
    upstream = Bun.serve({
      port: 0,
      fetch: () => new Response(JSON.stringify({ big }), { headers: { 'content-type': 'application/json' } }),
    });
    handle = await startLlmTraceProxy({ upstreamBaseUrl: upstream.url.origin, traceDir, maxBodyBytes: 500 });

    const res = await fetch(`${handle.baseUrl}/v1/messages`, { method: 'POST', body: JSON.stringify({ big }) });
    // The client still gets the whole thing — truncation only affects the trace.
    expect(((await res.json()) as { big: string }).big.length).toBe(5000);
    await handle.flush();

    const [rec] = records();
    const req = rec.request as { truncated: boolean; bytes: number; body_text: string };
    expect(req.truncated).toBe(true);
    expect(req.bytes).toBeGreaterThan(5000);
    expect(req.body_text.length).toBeLessThanOrEqual(500);
    expect((rec.response as { truncated: boolean }).truncated).toBe(true);
  });

  it('records an upstream failure and answers the client with 502', async () => {
    // Nothing listening on this port — the fetch to upstream must fail.
    const dead = Bun.serve({ port: 0, fetch: () => new Response('') });
    const deadOrigin = dead.url.origin;
    dead.stop(true);
    handle = await startLlmTraceProxy({ upstreamBaseUrl: deadOrigin, traceDir });

    const res = await fetch(`${handle.baseUrl}/v1/messages`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(502);
    await handle.flush();

    const [rec] = records();
    expect(typeof rec.error).toBe('string');
  });
});

describe('pruneTraceFiles', () => {
  it('removes trace files older than keepDays and leaves the rest', () => {
    const now = new Date('2026-09-10T00:00:00Z');
    for (const day of ['2026-09-01', '2026-09-04', '2026-09-09']) {
      fs.writeFileSync(path.join(traceDir, `${day}.jsonl`), '{}\n');
    }
    fs.writeFileSync(path.join(traceDir, 'not-a-trace.txt'), 'keep me');

    const removed = pruneTraceFiles(traceDir, 7, now);

    expect(removed).toEqual(['2026-09-01.jsonl']);
    expect(fs.readdirSync(traceDir).sort()).toEqual(['2026-09-04.jsonl', '2026-09-09.jsonl', 'not-a-trace.txt']);
  });

  it('is a no-op on a missing directory', () => {
    expect(pruneTraceFiles(path.join(traceDir, 'nope'), 7, new Date())).toEqual([]);
  });
});

describe('noProxyWithLoopback', () => {
  it('adds the loopback hosts when NO_PROXY is unset', () => {
    expect(noProxyWithLoopback(undefined)).toBe('127.0.0.1,localhost,::1');
  });

  it('keeps existing entries and does not duplicate', () => {
    expect(noProxyWithLoopback('example.com, 127.0.0.1')).toBe('example.com,127.0.0.1,localhost,::1');
  });
});

describe('traceEnvOverrides', () => {
  it('carries the base URL and both NO_PROXY spellings', () => {
    expect(traceEnvOverrides('http://127.0.0.1:4242', 'example.com')).toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4242',
      NO_PROXY: 'example.com,127.0.0.1,localhost,::1',
      no_proxy: 'example.com,127.0.0.1,localhost,::1',
    });
  });

  /**
   * Regression guard for the failure this function exists to prevent. Bun owns
   * the proxy env names: a write to `process.env.NO_PROXY` is dropped, while an
   * ordinary variable set identically survives. Anything that routes NO_PROXY
   * through `process.env` on its way to the CLI therefore works in a Node test
   * and fails in the container. If this assertion ever flips, Bun changed and
   * the indirection can be revisited — but do not remove it on a hunch.
   */
  it('is needed because Bun drops process.env writes to the proxy vars', () => {
    process.env.LLM_TRACE_CANARY = 'kept';
    process.env.NO_PROXY = '127.0.0.1,localhost';
    const spread = { ...process.env };
    expect(spread.LLM_TRACE_CANARY).toBe('kept');
    expect(spread.NO_PROXY).toBeUndefined();
    delete process.env.LLM_TRACE_CANARY;
  });
});
