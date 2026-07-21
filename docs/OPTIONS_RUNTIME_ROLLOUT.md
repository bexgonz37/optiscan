# OPTIONS_RUNTIME_ROLLOUT

## Flags (all OFF)
| Flag | Observes | Creates paper | Sends Discord | Provider cost | AI cost |
|---|---|---|---|---|---|
| INDEPENDENT_OPTIONS_DISCOVERY_ENABLED | yes (monitor + candidates) | no | no | 1 snapshot/cycle + chains for justified symbols | no |
| REAL_OPTION_PAPER_ENABLED | no | YES (regular session, fresh quote) | no | exit-quote fetch per open trade | no |
| EARLY_OPTIONS_CALLOUTS_ENABLED | unused this step | no | not wired | no | no |
| AI_SHADOW_ENABLED / ANALOG_LIVE_SHADOW_ENABLED | shadow-only, off critical path | no | no | AI: Anthropic key | AI: yes |

## Activation order
1. INDEPENDENT_OPTIONS_DISCOVERY_ENABLED → observe.
2. REAL_OPTION_PAPER_ENABLED → paper collection.
3. (later, explicit approval + gated delivery layer) EARLY_OPTIONS_CALLOUTS_ENABLED.

## Rollback
Unset flags; Railway redeploys; monitor stops cleanly (no child process, no schema change).

## Railway safety
In-process loop; unref'd timers; singleton; circuit breaker; bounded concurrency + provider budget.
No child process (avoids the prior seed-worker deployment issues). If a future enrichment makes the
loop CPU-heavy, revisit a supervised worker with the role-guard/backoff/heartbeat pattern from the seed
worker — not needed now.

## Expected provider usage
~1 snapshot call per Tier-1/Tier-2 cycle + one chain call per justified symbol (bounded by cooldowns,
budget, and `OPTIONS_MAX_SYMBOLS_PER_TIER2_CYCLE`). Conservative defaults keep this well within quota.

## Evidence required before public Discord delivery
- meaningful forward REAL_OPTION_PAPER sample per strategy/side/DTE with win/expectancy;
- measured detection→decision + freshness latency in production;
- calls AND puts validated (puts stay RESEARCH_ONLY for public);
- a gated, approved delivery layer that never sends a research-only put publicly and never past a
  strategy's chase limit. NONE of this is claimed yet.
