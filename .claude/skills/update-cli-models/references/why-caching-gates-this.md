# Why caching is the gate, not a footnote

An agent's prompt is re-sent whole on every turn: system prompt, tool schemas,
and the conversation so far. A typical turn here was ~25,000 prompt tokens
against ~20 output tokens — over 99% of the bill is prompt. Whether that prompt
is billed at the list rate or a cache rate therefore decides the cost of the
install, and it decides it by an order of magnitude. List price is close to
irrelevant next to it.

That is why a candidate that wins its benchmark is still only a candidate until
`cache-probe.ts` says its caching works.

## The two failure modes, both measured

**The gateway can translate `cache_control` wrongly for one upstream.** The
Claude Code CLI places its trailing breakpoint on the *newest* message. That is
correct for an API honouring several breakpoints and matching the longest
prefix. Where a gateway forwards only the final breakpoint, the cached segment
always contains the volatile new turn, can never be reused, and every request
pays a full write. Measured on one model, same prompt, breakpoint moved:

```
breakpoint on the last message    $0.867/M     <- what the CLI actually sends
on the last stable message        $0.075/M
no message breakpoint at all      $0.646/M
list input price                  $0.750/M
```

The shipped shape was the worst of the three and above the list price: a cache
that cost more than no cache. Every other model family tested returned real
cache reads under the identical request shape, so this is a per-upstream
property you must measure, not a property of caching.

**Routing loses the cache between turns.** One model may be served by twenty or
more provider endpoints in two price tiers, and a cache lives on the endpoint
that wrote it. The gateway's default conversation detection hashes the first
system message — which never matches for an agent whose system prompt carries a
per-turn runtime addendum. Measured over 8 alternating calls:

```
no session id     6/8 cache hits, $0.00316, including an excursion onto a 2x-priced endpoint
x-session-id      7/8 cache hits, $0.00194
```

The fix is a header, and NanoClaw sets it per agent group when a custom
endpoint is configured (`stickySessionEnv`, `container/agent-runner/src/providers/claude.ts`).

**One id per agent group, not per subagent.** The id routes; the prompt prefix
is what keys the cache. Two distinct prefixes under one id both cached
normally, so subagents sharing an id do not evict each other, and pinning a
group to one endpoint lets all its sessions share one warm tools+system prefix
instead of each warming its own.

**But a pin is a lottery you enter once and then live with.** Repeated runs of
`sticky-probe.ts` do not agree with each other, and the reason is which
endpoint the pin lands on. One run had the shared-id arm pinned to a
second-tier endpoint and take 0/8 hits at $0.150/M while the per-agent arm got
6/8 at $0.015/M; another run had them identical. A bad pin is stickier than no
pin, because without a pin a later turn can drift back onto a good endpoint.

Read the probe accordingly: it tells you whether excursions happen and roughly
what they cost, not which id scheme is better — the run-to-run spread is larger
than the difference between the arms.

**The stronger lever is bounding which endpoints qualify at all.** A
`provider` object in the request body does that, and the CLI will carry one:
anything in `CLAUDE_CODE_EXTRA_BODY` is merged into the body, so no proxy and
no request rewriting is involved. Measured over five turns of one conversation:

```
nothing                                     $0.00286
x-session-id only                           $0.00462   (stuck on a dear endpoint)
provider.only = cheapest tier only          $0.00222   (bounced within the tier)
provider.only + x-session-id                $0.00143
```

Complementary, not alternatives: the pin bounds the price tier, the header
holds one endpoint inside it.

**The trap.** `provider.only` containing no provider that serves the requested
model returns 404 — and `allow_fallbacks: true` does *not* rescue it, which is
the opposite of what the name suggests. Measured:

```
gpt-5.6-sol, only = glm's tier, allow_fallbacks:true    404
gpt-5.6-sol, only = union(glm tier + openai)            served
glm,         only = union(glm tier + openai)            served
```

One container's env applies to every model it runs, subagents included, so the
pin must be the union across all of them — the gateway intersects the list with
each model's own providers. NanoClaw builds that union daily
(`src/provider-pins.ts`) and omits the field entirely when any model is
uncovered: failing open costs money, failing closed breaks a subagent silently.
The refresh is daily rather than per container start for the same reason — a
spawn-time fetch that half-succeeds would emit exactly the broken shape.

## Do not price this from the transcripts

Session transcripts under `.claude-shared/projects/` record the conversation,
not the request. The Anthropic-compatible shim drops `usage.cost` and
`output_tokens_details.thinking_tokens` before they reach one. A price table
multiplied by transcript token counts understated real spend by ~2.5x the first
time the two were compared. Use the wire trace (`docs/llm-trace.md`), whose
records carry the gateway's own `usage.cost` — that is what `trace-cost.py`
reads.
