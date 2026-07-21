# OPTIONS_MONITORING_RUNTIME

`lib/research/options/monitor.ts` — the dedicated INDEPENDENT options monitoring loop. In-process,
bounded, SEPARATE from the Stock Momentum Radar. Started from `ensureServerBoot` via
`startOptionsMonitor(buildLiveOptionsDeps())`; HARD no-op unless `INDEPENDENT_OPTIONS_DISCOVERY_ENABLED=1`.

## Process boundary (decision)
IN-PROCESS interval loop (like the existing scanner/tracker/paper loops) — NOT a child process. The
tick is periodic light provider+DB work (no CPU-heavy synchronous seeding), so a worker process would
add the prior seed-worker fragility with no benefit. Provider fetches are async (they yield); per-
candidate work is fast. Singleton via globalThis, unref'd timers, clean shutdown on SIGTERM/SIGINT.

## Per cycle (`runOptionsMonitorCycle`) — staged funnel
1. Stage 1: ONE cheap whole-set underlying batch snapshot (1 provider call). Rejects most symbols.
2. Per symbol (bounded concurrency `OPTIONS_MAX_CONCURRENCY`): cooldown + no-overlap check → Stage-1
   gate (a chain is fetched ONLY when a strategy is applicable).
3. Stage 2: fetch the option chain only for justified symbols.
4. `runOptionsCandidate` records the candidate (+ gated real-option paper). AI/analog shadow run
   AFTERWARD off the critical path.

## Guards
Bounded concurrency, provider budget/minute (`OPTIONS_PROVIDER_BUDGET_PER_MINUTE`), per-symbol +
per-strategy cooldowns, circuit breaker on provider failure (`OPTIONS_BREAKER_FAILS` →
`OPTIONS_BREAKER_COOLDOWN_MS`), dedup, no overlapping scan of the same symbol, fixed-width concurrency
workers (no unbounded promise creation), no dependency on the stock radar, no Discord.

## Health
`optionsMonitorHealth()` reports enabled/running/breaker/last-cycle/alive. A DISABLED loop is
`{enabled:false, alive:true}` — it NEVER fails the web health endpoint. `optionsMonitorMetrics()` +
`GET /api/research/options` expose symbols scanned, candidates created/rejected, chains fetched,
provider calls (underlying/chain/detailed), failures, throttles, cooldown skips, breaker state, active
paper positions, latest candidate, p50/p95 cycle duration + detection→decision, candidates/100 calls.

## Feature note (honest)
Live Stage-1 features today are snapshot-derived (price, dollar-vol, day-change + a cheap day-change
ACCELERATION from consecutive snapshots). Richer per-symbol features (rvol/VWAP/levels/options-
activity) are the next enrichment; until then the monitor is intentionally sparse.
