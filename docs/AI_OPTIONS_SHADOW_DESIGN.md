# AI_OPTIONS_SHADOW_DESIGN

AI runs AFTER deterministic candidate creation, asynchronously, on the bounded shadow queue, SHADOW
comparison only. Flag `AI_SHADOW_ENABLED` (OFF) + an injected model caller (no accidental spend).

## Wiring
- `lib/ai/shadow.ts enqueueAiShadow(input, deps)` — bounded queue, timeout, schema validation +
  deterministic post-validation (foreign-ticker / unprovenanced-institutional-flow ⇒ hallucination →
  ABSTAIN), metrics (latency, tokens, cost, schema failures, hallucinations, abstentions,
  agreement-with-scanner, agreement-with-analog).
- `lib/ai/shadow-model.ts` — `buildAiShadowPrompt` (authoritative-only fields) + `anthropicShadowCaller`
  wrapping the existing approved provider (`ai/provider.ts` schema/timeout/retry). The provider is
  INJECTED, so nothing calls Anthropic unless enabled + wired.

## Inputs (authoritative only)
ticker, direction, strategy candidate, underlying prices/timestamps, technical features, earnings
context + provenance, options-activity statistics + provenance, candidate contracts, bid/ask/spread,
volume/OI, IV/Greeks when available, analog summary, market context, missing-evidence, deterministic
gate results, prior paper outcomes.

## Outputs (advisory only)
strategy classification, concise reason, evidence-for/against, risk summary, preferred
CALL/PUT/STOCK/ABSTAIN, preferred contract style, suggested SEND/REJECT/ABSTAIN (shadow comparison).

## Must-not (enforced)
block the scanner; delay Discord; invent data; override hard gates; send alerts; change thresholds;
rewrite code/deploy; make puts actionable; call ordinary option volume institutional flow.

## Track
latency, token usage, cost, schema failures, hallucination downgrades, abstentions, agreement with
baseline, agreement with analog, later outcome.
