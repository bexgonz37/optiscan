# Alert-Ranking Architecture — built vs designed (2026-07-09)

## Built and tested

| Piece | Where | Status |
|---|---|---|
| Root-cause diagnosis of the META miss (10-second burst gates cannot see hour-long grinds) | this doc §Root cause + tests | ✅ reproduced in tests |
| Day-timeframe major-move detector (market-cap + dollar-volume aware) | `lib/major-move.ts` → scanner loop → "Major moves" strip | ✅ |
| **Longer-dated position callouts** ("META mid-July 650C" ask): major move → 7–35 DTE chain → proven swing gates (spread ≤8%, OI ≥250, 0.40–0.70Δ, 21–28 DTE preferred) → WATCH-tier alert with entry/invalidation/extended status | `lib/position-callout.ts` | ✅ one per symbol/day, budget-aware, flows into tracker/quant/paper/Discord-WATCH automatically |
| Decision diagnostics (any ticker+timestamp, full rule transparency) | `GET /api/diagnostics/alert-decision` | ✅ |
| Hero stability (10-min sticky + material-superiority eviction) | `lib/discord-desk.ts`, live view | ✅ |
| Watchlist membership dwell, verdict hysteresis, near-miss panel | earlier sessions | ✅ |

## Root cause (recorded)

META was in the universe and data was live. Every trigger gate measures ~10-second
velocity (burst detection); a +3%/hour large-cap grind averages ~0.04%/min and can
never clear a 0.15%/min burst gate. Correct fix was a separate day-timeframe
detector + position-callout path — not lowered thresholds.

## Designed, NOT yet built (build order for next sessions)

### 1. Opportunity memory (prerequisite for everything below)
Table `opportunities`: `id, ticker, setup_type, first_detected_at, last_updated_at,
highest_score, current_score, initial_rank, current_rank, status
(DETECTED/CONFIRMING/ACTIONABLE/EXTENDED/WEAKENING/INVALIDATED/EXPIRED),
entry_zone, invalidation_level, target_levels_json, best_entry_at, alert_id,
discord_message_id, suppression_reason, expires_at`. Loop upserts by
(ticker, setup_type, trading_day) — repeated signals evolve ONE record; update
events (confirmed/new-high/weakened/invalidated) instead of duplicate alerts.
Lifecycle hysteresis: enter list ≥75 score; demote only after score <60 for 3–5
consecutive evaluations; ACTIONABLE minimum visibility 20–30 min; rank moves
capped per refresh; ties keep prior rank.

### 2. Multi-factor scoring profiles
Replace binary AND-gates with weighted scores per profile (large-cap momentum,
small-cap momentum, options momentum, ORB, earnings continuation, news breakout,
trend continuation, reversal, AH momentum). Factors already computable today:
momentum/ROC/accel, RVOL + volume accel, dollar volume, cap-adjusted move,
HOD/PMH/ORB breaks, VWAP hold/reclaim/distance, SPY relative strength, spread,
contract liquidity, options vol/OI, time-of-day + historical edge from
`setup_statistics`. Needs new data: sector ETF mapping, market-cap cache
(Polygon reference), IV history (accumulating since the quant layer shipped).

### 3. Missed-move audit (nightly)
After close: scan the day's candles for cap-aware significant moves (large ≥2.5%
+ dollar expansion + RS; mid ≥5%; small ≥8% + RVOL); join against alerts +
near-misses + major-moves; persist to `missed_opportunities` (fields per spec:
magnitude, MFE, universe/data presence, highest score, responsible rule,
tradability, proposed adjustment); serve `GET /api/quant/missed-opportunities`
+ a "Missed Opportunities Review" panel. Reuses the diagnostics reconstruction.

### 4. Anti-overfit learning workflow
Missed-move → log → compare vs history → PROPOSED rule change (never auto-applied)
→ backtest via the quant backtester → false-positive impact → manual approval →
versioned in `strategy_versions`. Minimum samples + walk-forward before any claim
of "learning."

## Verify today's build
```
npm test        # ~350 tests, 0 fail
# after a big-day session, expect [major-move] and [position] lines in the log
# and the position callout in /alerts + "Paper trade it" on /paper
# POSITION_CALLOUTS=0 disables the new path entirely
```
