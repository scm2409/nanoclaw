/**
 * Is the cache stable across turns, or does provider routing keep losing it?
 *
 * A gateway serves one model from many provider endpoints — a popular open
 * model can have twenty-plus, in two price tiers — and a cache lives on the
 * endpoint that wrote it. A turn routed elsewhere pays full price. OpenRouter
 * recognises a conversation by hashing its first system message, which never
 * matches for an agent whose system prompt carries a per-turn runtime
 * addendum, so the pinning has to be explicit: an `x-session-id` header.
 *
 * Run inside a running agent container:
 *
 *   docker cp sticky-probe.ts <container>:/tmp/sticky-probe.ts
 *   docker exec -e NO_PROXY=127.0.0.1,localhost,::1 <container> \
 *     bun /tmp/sticky-probe.ts <model-id>
 *
 * Both arms use the same prefix, so the second inherits whatever the first
 * warmed; the meaningful comparison is the *first* arm's hit count and total,
 * plus whether either arm shows a rate excursion onto a pricier endpoint.
 * Re-run with the arms reversed (`--per-agent-first`) to see the other side
 * cold.
 *
 * Check `ncl groups config get --id <group>` afterwards: if the install
 * already sets the header, the "no session id" arm is the counterfactual.
 */
const BASE = process.env.ANTHROPIC_BASE_URL;
const AUTH = process.env.ANTHROPIC_AUTH_TOKEN;
if (!BASE || !AUTH) {
  console.error('ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN must be set — run this inside an agent container.');
  process.exit(2);
}

const MODEL = process.argv[2];
if (!MODEL) {
  console.error('usage: bun sticky-probe.ts <model-id> [--per-agent-first]');
  process.exit(2);
}
const PER_AGENT_FIRST = process.argv.includes('--per-agent-first');
const NONCE = process.env.PROBE_NONCE ?? String(Date.now());
const ROUNDS = 4;

const line = (tag: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${tag} line ${i}: stable prefix for this agent, never changes.`).join('\n');
const cc = { cache_control: { type: 'ephemeral' } };

// Two distinct prefixes standing in for two subagents with different system
// prompts — the case where you might wrongly assume one shared id makes them
// evict each other.
const PREFIX: Record<'A' | 'B', string> = {
  A: `probe ${NONCE} AGENT-A\n` + line('AAA', 700),
  B: `probe ${NONCE} AGENT-B\n` + line('BBB', 700),
};

async function ask(agent: 'A' | 'B', n: number, sessionId?: string) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${AUTH}`,
    'anthropic-version': '2023-06-01',
  };
  if (sessionId) headers['x-session-id'] = sessionId;
  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8,
      system: [{ type: 'text', text: PREFIX[agent], ...cc }],
      messages: [{ role: 'user', content: [{ type: 'text', text: `Agent ${agent} question ${n}.`, ...cc }] }],
    }),
  });
  const body = (await res.json()) as {
    usage?: Record<string, number> & { cost_details?: Record<string, number> };
  };
  const u = body.usage;
  if (!u) return { rate: NaN, hit: false, cost: 0 };
  const prompt = u.cost_details?.upstream_inference_prompt_cost ?? 0;
  const billed = (u.cache_read_input_tokens ?? 0) + (u.input_tokens ?? 0);
  return {
    rate: billed ? (prompt / billed) * 1e6 : 0,
    hit: (u.cache_read_input_tokens ?? 0) > 1000,
    cost: prompt,
  };
}

async function arm(label: string, idFor: (a: 'A' | 'B') => string | undefined) {
  const log: string[] = [];
  let hits = 0;
  let total = 0;
  for (let round = 1; round <= ROUNDS; round++) {
    for (const agent of ['A', 'B'] as const) {
      const r = await ask(agent, round, idFor(agent));
      log.push(`${agent}:$${r.rate.toFixed(3)}`);
      if (r.hit) hits++;
      total += r.cost;
    }
  }
  console.log(`${label.padEnd(24)} ${log.join('  ')}   hits ${hits}/${ROUNDS * 2}  total $${total.toFixed(5)}`);
}

console.log(`model: ${MODEL} — two distinct prefixes, ${ROUNDS} rounds alternating\n`);
const shared = () => `probe-shared-${NONCE}`;
const perAgent = (a: 'A' | 'B') => `probe-${a}-${NONCE}`;
if (PER_AGENT_FIRST) {
  await arm('one id per agent', perAgent);
  await arm('one shared id', shared);
} else {
  await arm('one shared id', shared);
  await arm('one id per agent', perAgent);
}
await arm('no session id', () => undefined);
console.log('\nA rate well above the others on some turns is a routing excursion onto a');
console.log('pricier endpoint, not a model property.');
console.log('\nDo not read this as a verdict on which id scheme wins: a pin sticks to');
console.log('whatever endpoint it first lands on, so the run-to-run spread is larger than');
console.log('the difference between the arms. An arm flat at a high rate with no hits was');
console.log('pinned to an expensive endpoint — informative about the spread, not the id.');
console.log('What settles the question is the live trace after the change (trace-cost.py).');
