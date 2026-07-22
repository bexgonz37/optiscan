# OPTIONS_STRATEGY_FEATURE_MAP

Enriched features map into the existing 18-strategy catalog via `activeSignals` (discovery.ts) →
`scoreStrategies`. Each strategy already carries its own DTE / delta-moneyness / max-spread / min-
liquidity / chase / freshness / stop / targets / session / grading in `strategy-catalog.ts`. This maps
which enriched signals gate each setup:

| Strategy | Required early signals (enriched) | Disqualifiers |
|---|---|---|
| breakout_forming | breakout_proximity + compression_near_level + (rel_volume or volume accel) | already extended (fractionMove high) |
| pullback_continuation | above_vwap + price_acceleration (trend intact) | trend/VWAP loss |
| opening_range_breakout | opening_range_development + rel_volume + price_acceleration | stale chain / no OR level |
| momentum_acceleration | price_acceleration + rel_volume | late/extended |
| vol_compression_expansion | compression_near_level + volatility_expansion + iv_change | still inside range |
| sr_reclaim | compression_near_level + above_vwap + rel_volume | loss of reclaimed level |
| earnings_continuation/reversal | earnings_timing + earnings_gap (authoritative only) | no confirmed earnings feed |
| unusual_options_activity | option_vol_vs_oi + multi_strike/expiration + call_put_concentration | directionally ambiguous → abstain |
| index_intraday_momentum / zero_dte_index | above_vwap + price_acceleration (index) | VWAP loss |
| short_dated_directional / longer_dated_swing | breakout_proximity + compression | thesis invalidation |

Rules: calls and puts are evaluated independently from strategy evidence (never "green→call"); puts stay
RESEARCH_ONLY (bearish-gate final authority); earnings strategies stay inert until a real earnings feed
exists; options-activity strategies abstain on ambiguity and NEVER assert institutional flow.
