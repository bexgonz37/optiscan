# CONTROLLED_OPTIONS_ROLLOUT

Flags (all default OFF). Classification:

| Flag | Collect-only | Affects paper | Could affect Discord | Needs provider entitlement | Incurs AI cost |
|---|---|---|---|---|---|
| BROAD_DISCOVERY_SHADOW_ENABLED | yes | no | no | no | no |
| ANALOG_LIVE_SHADOW_ENABLED | yes | no | no | no | no |
| MARKET_CONTEXT_CAPTURE_ENABLED | yes | no | no | partial (index/breadth feeds) | no |
| EARNINGS_DISCOVERY_ENABLED | yes | no | no | **YES** (earnings calendar) | no |
| OPTIONS_ACTIVITY_DISCOVERY_ENABLED | yes | no | no | uses present-time chain (existing) | no |
| EARLY_OPTIONS_DETECTION_ENABLED | yes (shadow) | no | no | no | no |
| REAL_OPTION_PAPER_ENABLED | no | **YES** | no | no | no |
| AI_SHADOW_ENABLED | yes | no | no | **Anthropic key** | **YES** |
| STRATEGY_IMPROVEMENT_LAB_ENABLED | yes (proposals) | no | no | no | maybe (if AI proposes) |
| TWO_SPEED_ALERTS_ENABLED / FORWARD_CAPTURE_ENABLED | Phase F | forward only | **two-speed could** (public alert) | no | no |

## Public Discord format (section J) — DESIGNED, not enabled
Internally track FORMING/READY/REJECTED/TOO_LATE/EXPIRED. Send ONE public callout only when credible
AND still early (not past the strategy chase limit):
```
HOOD CALL
$XX strike — MM/DD
Entry: $X.XX–$X.XX
Targets: $X.XX / $X.XX
Why: breakout forming with accelerating volume and liquid call activity.
```
This changes public Discord behavior and is therefore NOT auto-enabled. It ships behind the two-speed
layer (flag OFF) and requires explicit approval + forward validation.

## Rules
No real-money execution. BEARISH_ACTIONABLE stays off; bearish-gate.ts final authority; puts
RESEARCH_ONLY for public actionable delivery until validated. No new Discord behavior auto-enabled. No
improvement claimed until forward results prove it.

## Self-improvement (section K)
The Strategy Improvement Lab (flag OFF) lets AI PROPOSE threshold/DTE/ranking/chase/regime/symbol
rules. Each proposal must pass: safety validation → historical backtest → walk-forward → leakage
checks → baseline comparison → shadow mode → forward paper validation → latency comparison → explicit
approval. AI never edits or deploys production strategy code.
