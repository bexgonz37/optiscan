# ANALOG_SHADOW_BRIDGE

Connect the Analog Engine to LIVE candidates in **shadow only**. **Flag:
`ANALOG_LIVE_SHADOW_ENABLED` (default OFF).** Plus prospective market context
(`MARKET_CONTEXT_CAPTURE_ENABLED`, OFF). Everything recorded is `ANALOG_SHADOW_ONLY`.

## Flow — `lib/research/shadow/analog-bridge.ts`
1. `buildDecisionSnapshot(liveFeatures, t0Ms, id)` — a DECISION-TIME feature vector using the SAME keys
   the episode library uses (`velPct, accelPct, rvol, realizedVol, atrPct, posInRange, gapPct`, +
   `cmp_liquidity/direction/symbol`). Only data available at `t0Ms`; no future info.
2. `queryAnalogShadow(scorer, features, t0Ms, liveDecision, clock)` — runs the already-fitted
   `AnalogScorer.explain`, times it on one clock, and records: comparable count, effective sample,
   confidence/win-rate/dispersion/contradiction, forward-return p10/p50/p90, nearest distance,
   abstention reason, **agreement vs the live scanner** (agree_strong/agree_weak/disagree/abstain), and
   `lookupMs`. A throwing scorer is isolated (returns an abstain record).

## Hard guarantees (enforced by design)
The bridge produces a **record only**. It does NOT: block EARLY_WATCH, modify actionable scores, modify
thresholds, override `bearish-gate.ts`, make puts actionable, cause a Discord alert, or suppress a live
alert. It is never on the live decision path — the live scanner does not import it.

## Market context — `lib/research/context/market-context.ts`
`buildMarketContext(input)` captures, from decision time forward: regime (from SPY/QQQ/IWM trend + VIX
vol regime), index trends, vol regime, sector/industry + sector-relative strength, breadth,
catalyst category, earnings proximity, session, underlying/options liquidity, spread, IV rank (when
entitled). It **throws on look-ahead** (any component observed after `asOfMs`) and lists `missing[]`
fields rather than fabricating them.

## Measuring improvement — `lib/research/shadow/earliness.ts`
`computeEarliness` → fraction of the move already complete at detection, distance to the breakout
level, time lead before the first expansion, side-aware MFE/MAE, and price improvement vs a
momentum-only baseline (phase: before/during/after). `compareLanes` aggregates the three lanes
(baseline / broad-only / broad+analog): % found only by broad, % analog improved/worsened rank,
TOO_LATE rate, false-positive rate, average analog lookup latency.

## Storage + dashboard
`analog_shadow`, `market_context_shadow` (additive, repeat-safe). `GET /api/research/shadow`
(read-only, token-gated) reports discovery coverage + top exclusions, analog agree/disagree/abstain +
avg lookup latency, and market-context regime distribution, plus flag state. No claim of superiority is
made until forward evidence proves it.

## AI integration — safe design (DESIGNED, NOT ACTIVATED)
A future AI/advisory consumer MAY receive, at inference time only: live deterministic features, catalyst
provenance, analog **summary statistics** (from `analog_shadow`), paper-trade history, and explicit
uncertainty/missing-data fields. It MAY explain, summarize, classify catalyst type, and flag
contradictions. It MUST NOT: invent data, select nonexistent contracts, change hard gates, change live
thresholds, enable bearish-actionable alerts, turn research-only puts actionable, block EARLY_WATCH,
retrain itself automatically, or rewrite historical outcomes. These are enforced today by:
`lib/ai/safety.ts` (`screenProposalSafety` blocks proposals that would enable bearish-actionable or
change Discord actionable criteria), the architecture guard (no model calls outside `lib/ai/`), and the
fact that the AI layer reads only paper outcomes — never the live decision path. Not wired; documented
for a later, explicit, flag-gated step.
