# INDEPENDENT_OPTIONS_DISCOVERY

The Options Opportunity Scanner now has a discovery path that does NOT depend on the stock radar's
`shouldTrigger()` and does NOT require the underlying to be up ~10%. Research/paper-only; flags OFF.

## Universe (`lib/research/options/discovery.ts`)
- **Tier 1** (`OPTIONS_TIER1`, continuous): SPY, QQQ, IWM, NVDA, TSLA, AMD, AMZN, META, AAPL, MSFT,
  GOOGL, AVGO, NFLX, HOOD (+ `OPTIONS_TIER1_EXTRA`).
- **Tier 2** (`tier2Eligible`): broad optionable US names gated on underlying liquidity, fresh data,
  usable chain, real bid, spread, option volume/OI, and hard exclusions (OTC/warrant/right/unit/
  preferred/halted). Names like TGT/IREN/RKLB/ASTS/SPCE enter WITHOUT being on the core list.

## Early triggers (`activeSignals`) — deterministic, decision-time only
rel_volume, price/volume acceleration, breakout_proximity, compression_near_level, hod_break,
above_vwap, opening_range_development, premarket_level_testing, volatility_expansion, option_vol_vs_oi,
option_vol_vs_baseline, multi_strike/expiration, call_put_concentration, iv_change, earnings_timing/
gap/abnormal_premarket_vol. NONE requires a completed large move.

## Strategy selection (`selectOptionsStrategy`)
Scores all 18 catalog strategies by early-signal overlap + session, rejects inapplicable (with
reasons), selects the strongest, chooses direction + preferred DTE. Records every considered strategy.
Puts are RESEARCH_ONLY unless `BEARISH_ACTIONABLE=1` (default off; bearish-gate.ts is authority).

Flag: `INDEPENDENT_OPTIONS_DISCOVERY_ENABLED` (OFF). It does not touch the stock radar or Discord.
