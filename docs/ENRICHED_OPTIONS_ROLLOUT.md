# ENRICHED_OPTIONS_ROLLOUT

## What is active
Nothing by default — all flags OFF. Stock Momentum Radar unchanged. No public Discord. No real money.

## What remains paper/shadow
The whole independent options monitor (discovery, enrichment, strategy selection, real-option paper) is
paper/shadow only. Public callout DELIVERY is unwired.

## Flags (all OFF)
- INDEPENDENT_OPTIONS_DISCOVERY_ENABLED — observe + enrich + record candidates (Stage 1/1.5/2).
- OPTIONS_ACTIVITY_DISCOVERY_ENABLED — lets abnormal chain activity independently escalate a symbol.
- REAL_OPTION_PAPER_ENABLED — real-option paper (regular session, fresh quote, conservative fill).
- ANALOG_LIVE_SHADOW_ENABLED / AI_SHADOW_ENABLED — consume the enriched snapshot, off the critical path.
- EARLY_OPTIONS_CALLOUTS_ENABLED — unused/unwired (no Discord).
- EARNINGS_DISCOVERY_ENABLED — BLOCKED (no authoritative earnings feed; classifier stays inert).

## Safest activation order
1. INDEPENDENT_OPTIONS_DISCOVERY_ENABLED → watch monitor stages + candidate quality + earliness.
2. OPTIONS_ACTIVITY_DISCOVERY_ENABLED → add chain-activity escalation.
3. REAL_OPTION_PAPER_ENABLED → collect forward REAL_OPTION_PAPER evidence.
4. (later) ANALOG/AI shadow for comparison. Public callouts remain OFF.

## Expected provider usage
See OPTIONS_PROVIDER_COST_MODEL. Bounded by budget + cooldowns + Stage-1.5 rejection.

## Rollback
Unset the flag(s); Railway redeploys; the in-process monitor stops cleanly (no child process, additive
schema only). Stock radar unaffected throughout.

## Remaining blockers before public Discord delivery
- forward REAL_OPTION_PAPER win/expectancy per strategy/side/DTE/core-vs-broad;
- measured production detection→decision + freshness latency + earliness distribution;
- calls AND puts validated (puts stay RESEARCH_ONLY for public);
- a real earnings feed for earnings strategies;
- richer level/market-context feeds for fuller strategy coverage;
- a gated, approved delivery layer (never a research-only put publicly, never past the chase limit).
