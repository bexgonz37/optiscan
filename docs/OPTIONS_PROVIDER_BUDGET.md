# OPTIONS_PROVIDER_BUDGET

## Staged funnel = few provider calls
- Stage 1: ONE whole-market snapshot per cycle (shared 5s cache across Tier-1/Tier-2) → most symbols
  rejected before any chain fetch.
- Stage 2: one `fetchOptionChain` (≤2 pages, 0–14 DTE) ONLY for symbols with an applicable strategy.
- Stage 3: detailed per-contract quotes only for the shortlisted contract (freshness recheck).

## Budget + tracking
`OPTIONS_PROVIDER_BUDGET_PER_MINUTE` (default 200) is a per-minute token pool; when exhausted, calls
are throttled and counted. Metrics track underlying/chain/detailed calls, provider failures, throttles,
circuit-breaker state, and (via cycle timing) latency. `candidatesPer100Calls` measures yield.

## Circuit breaker
After `OPTIONS_BREAKER_FAILS` consecutive provider failures the breaker OPENS for
`OPTIONS_BREAKER_COOLDOWN_MS`, then half-opens (one probe) → closes on success. While open, cycles skip
(throttle) so a provider outage can't hammer the API or burn quota.

## Defaults (conservative)
Tier-1 15s regular / 30s pre+after; Tier-2 60s regular / 120s pre+after; concurrency 3; ≤25 Tier-2
symbols/cycle; symbol cooldown 60s; strategy cooldown 120s; budget 200 calls/min.
