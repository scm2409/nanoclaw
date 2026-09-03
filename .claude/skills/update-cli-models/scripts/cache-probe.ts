/**
 * Does prompt caching actually pay off for a model, under the request shape
 * the Claude Code CLI really sends?
 *
 * This is the gate a candidate must pass. A model can win every benchmark and
 * still cost five times its list price, because the agent's prompt is re-sent
 * whole on every turn and the discount is what makes that affordable. It has
 * to be measured per model: gateways translate `cache_control` differently per
 * upstream, and one translation turns the discount into a surcharge.
 *
 * Run it inside a running agent container, where the OneCLI gateway supplies
 * the credential on the outbound leg:
 *
 *   docker cp cache-probe.ts <container>:/tmp/cache-probe.ts
 *   docker exec -e NO_PROXY=127.0.0.1,localhost,::1 <container> \
 *     bun /tmp/cache-probe.ts <model-id> [more model ids...]
 *
 * NO_PROXY matters: the container routes egress through the gateway, and
 * without it a localhost hop would be dialled from the host.
 *
 * Read the output like this:
 *   turn 1 writes the cache, turns 2 and 3 should be much cheaper.
 *   `read` climbing while `write` stays 0 is caching working.
 *   `read == write == the whole prompt`, every turn, at a rate at or above the
 *   list input price, is a cache that is being rewritten and never read — the
 *   disqualifying result.
 */
const BASE = process.env.ANTHROPIC_BASE_URL;
const AUTH = process.env.ANTHROPIC_AUTH_TOKEN;
if (!BASE || !AUTH) {
  console.error('ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN must be set — run this inside an agent container.');
  process.exit(2);
}

const NONCE = process.env.PROBE_NONCE ?? String(Date.now());
const line = (tag: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${tag} line ${i}: stable prefix content that does not change between turns.`).join(
    '\n',
  );

// ~6k tokens: above every provider's minimum cacheable prefix, so a miss means
// the cache did not work rather than that the prompt was too small to qualify.
const SYSTEM = `probe ${NONCE}\n` + line('SYS', 700);
const HIST = line('HIST', 200);
const cc = { cache_control: { type: 'ephemeral' } };

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cost_details?: Record<string, number>;
}

async function turn(model: string, tail: string) {
  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${AUTH}`,
      'anthropic-version': '2023-06-01',
      // Pin one provider endpoint, as the runner does in production. Without
      // it the probe measures the routing lottery instead of the model, and a
      // model that caches fine reads as a failure because one turn landed on a
      // pricier endpoint. See sticky-probe.ts for measuring the lottery itself.
      'x-session-id': `cache-probe-${NONCE}-${model}`.slice(0, 256),
    },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      system: [{ type: 'text', text: SYSTEM, ...cc }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: HIST }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Understood.' }] },
        // The CLI puts its trailing breakpoint on the newest message. Keep it
        // here: the point is to measure the shape actually shipped, not an
        // idealised one.
        { role: 'user', content: [{ type: 'text', text: tail, ...cc }] },
      ],
    }),
  });
  const body = (await res.json()) as { usage?: Usage; error?: { message?: string } };
  if (!body.usage) return { line: `  error: ${body.error?.message ?? JSON.stringify(body).slice(0, 120)}` };
  const u = body.usage;
  const prompt = u.cost_details?.upstream_inference_prompt_cost ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const billed = read + (u.input_tokens ?? 0);
  const rate = billed ? (prompt / billed) * 1e6 : 0;
  return {
    rate,
    share: billed ? read / billed : 0,
    // The disqualifying shape: the whole prompt reported as both read and
    // written, every turn. That is a cache rewritten and never read.
    rewriteOnly: read > 0 && read === write && billed > 0 && read >= billed,
    line:
      `  in=${String(u.input_tokens ?? 0).padStart(6)} ` +
      `read=${String(read).padStart(6)} ` +
      `write=${String(write).padStart(6)} ` +
      `prompt$=${prompt.toFixed(6)}  effective=$${rate.toFixed(3)}/M` +
      `  cached ${(billed ? (100 * read) / billed : 0).toFixed(0)}%`,
  };
}

const models = process.argv.slice(2);
if (models.length === 0) {
  console.error('usage: bun cache-probe.ts <model-id> [more model ids...]');
  process.exit(2);
}

const TURNS = 5;

for (const model of models) {
  console.log(`\n=== ${model}`);
  const rates: number[] = [];
  const shares: number[] = [];
  let rewriteOnly = 0;
  for (let i = 1; i <= TURNS; i++) {
    const r = await turn(model, `Question ${i}, different every turn.`);
    console.log(`  turn ${i}${r.line}`);
    if (typeof r.rate === 'number') {
      rates.push(r.rate);
      shares.push(r.share ?? 0);
      if (r.rewriteOnly) rewriteOnly += 1;
    }
  }
  if (rates.length < TURNS) {
    console.log('  -> incomplete run; re-run before judging this model');
    continue;
  }
  const bestShare = Math.max(...shares);
  const best = Math.min(...rates);
  const worst = Math.max(...rates);
  const summary = `  -> best $${best.toFixed(3)}/M, worst $${worst.toFixed(3)}/M, best cached share ${(
    100 * bestShare
  ).toFixed(0)}%`;
  if (rewriteOnly >= TURNS - 1) {
    console.log(`${summary}\n     REJECT: cache rewritten every turn and never read.`);
  } else if (bestShare >= 0.5 && best < worst * 0.8) {
    console.log(`${summary}\n     PASS: the prefix is being read back at a discount.`);
  } else if (bestShare >= 0.5) {
    console.log(`${summary}\n     PASS (weak): reads happen, but the rate barely moves — check the model's`);
    console.log("     cache-read price in the catalogue before adopting.");
  } else {
    console.log(`${summary}\n     INCONCLUSIVE: little or nothing was read back. Re-run once — a single`);
    console.log('     cold or mis-routed run looks the same. Two inconclusive runs is a reject.');
  }
}
