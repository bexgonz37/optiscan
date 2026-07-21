# OPTIONS_STRATEGY_CATALOG

Source of truth: `lib/research/options/strategy-catalog.ts` (`OPTIONS_STRATEGIES`). Research-only, not
actionable. Each strategy has its OWN entry trigger, underlying + options liquidity gates, preferred
DTE, delta/moneyness, max spread, freshness, chase limit, stop, targets, holding horizon, sessions,
and grading method. NONE requires the underlying to already be up +10%.

Strategies: breakout_forming, confirmed_breakout, opening_range_breakout, premarket_level_break,
sr_reclaim, pullback_continuation, trend_continuation, vol_compression_expansion,
momentum_acceleration, reversal_bounce, failed_breakout, earnings_continuation, earnings_reversal,
unusual_options_activity, index_intraday_momentum, zero_dte_index, short_dated_directional,
longer_dated_swing.

Tenor bands (report buckets, kept SEPARATE): 0dte / 1-7dte / 8-14dte / 15-30dte / 31-90dte / longer.
Grading is `underlying_forward_return` by default; a strategy may be graded by `real_option_pl` (only
with a real OCC contract + bid/ask) or `modeled_option_reprice` (research). These are never combined.

**Best-strategy selection** (by symbol / regime / volatility / session / direction / DTE / liquidity)
is determined ONLY by historical backtest + forward paper results — not asserted here. Until forward
evidence exists, no strategy is claimed superior.
