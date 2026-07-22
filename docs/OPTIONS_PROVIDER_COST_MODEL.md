# OPTIONS_PROVIDER_COST_MODEL

Per cycle: 1 underlying batch snapshot + (1 bars call per Stage-1 survivor) + (1 chain call per
justified/escalated symbol) + (detailed quote per shortlisted contract, real-option paper only).

## Worst-case per cycle
- Tier-1 (14 core): 1 snapshot + ≤14 bars + ≤14 chains = ≤29 calls.
- Tier-2 (≤`OPTIONS_MAX_SYMBOLS_PER_TIER2_CYCLE`=25): 1 snapshot + ≤25 bars + (chains only for
  justified/escalated) = typically far fewer, because Stage 1.5 rejects most before Stage 2.

## Expected daily (defaults: Tier-1 15s regular / Tier-2 60s)
- Regular session ~6.5h. Tier-1 cycles ~1560/day. With cooldowns (symbol 60s) and Stage-1.5 rejection,
  realistic calls are a fraction of worst-case; the per-minute budget (`OPTIONS_PROVIDER_BUDGET_PER_MINUTE`
  =200) is the hard ceiling and throttles beyond it (counted).
- Stage 2 chains dominate cost; keeping Stage-1.5 selective (real strategy signals) is the lever.

## Controls
OPTIONS_TIER1_INTERVAL_MS / OPTIONS_TIER2_INTERVAL_MS (+ premarket/afterhours variants),
OPTIONS_MAX_CONCURRENCY, OPTIONS_MAX_SYMBOLS_PER_TIER2_CYCLE, OPTIONS_SYMBOL_COOLDOWN_MS,
OPTIONS_STRATEGY_COOLDOWN_MS, OPTIONS_PROVIDER_BUDGET_PER_MINUTE, OPTIONS_BREAKER_FAILS/COOLDOWN.

Track actual usage at `GET /api/research/options` → `monitor.providerCalls` (underlying/bars/chain/
detailed/total), throttles, breaker state, candidatesPer100Calls. Tune cadence/budget from real data;
no cost is claimed without measurement.
