# OPTIONS_STAGE_FUNNEL

Provider-efficient staged funnel (`lib/research/options/monitor.ts runOptionsMonitorCycle`). Full
chains are NEVER fetched for every symbol.

## Stage 1 — cheap (1 call/cycle)
ONE whole-set underlying batch snapshot. Reject on price/dollar-volume/freshness/session — no bars, no
chain. Counter: `stage1Pass`, `stage1PassRate`.

## Stage 1.5 — compact bars (1 call per Stage-1 survivor)
`getBars(symbol)` → `computeOptionsFeatures` (rvol/VWAP/levels/compression/expansion/acceleration/
momentum/ATR/gap). STALE bars reject safely (no chain). Counter: `stage15Enrich`; distributions for
rvol / VWAP-distance / compression sampled.

## Stage 2 — option chain (1 call, only when justified)
A chain is fetched ONLY when a strategy is plausible from the enriched underlying, OR (when
`OPTIONS_ACTIVITY_DISCOVERY_ENABLED`) to let abnormal chain activity INDEPENDENTLY escalate the symbol.
`summarizeChainFeatures` computes vol/OI + skew; escalation requires the chain to be genuinely abnormal
(non-ambiguous). Counters: `stage2Chain`, `optionsActivityEscalations`.

## Stage 3 — detailed contract/Greeks (shortlisted only)
Detailed per-contract data/Greeks are fetched only for the shortlisted contract during the freshness
recheck (real-option paper). Counter: `stage3Detailed`.

## Cost tracking
Provider calls tracked by stage (underlying/bars/chain/detailed) + total; `candidatesPer100Calls` is the
yield. Budget (`OPTIONS_PROVIDER_BUDGET_PER_MINUTE`), per-symbol/strategy cooldowns, bounded
concurrency, and a circuit breaker cap total usage.
