# OPTIONS_FEATURE_ENRICHMENT

Decision-time feature enrichment for the independent options monitor (Stage 1.5). PURE, no look-ahead,
flag-gated, bounded. Improves candidate quality + earliness without slowing/expensive-ing the loop.

## Underlying features (`lib/research/options/features.ts computeOptionsFeatures`)
From compact recent 1-minute bars (t ≤ nowMs) + optional level context: price, bar freshness/staleness,
VWAP + VWAP-distance + above/below, HOD/LOD + proximity + HOD break, nearest resistance/support +
distance, trend slope, short-term momentum, velocity + acceleration, realized volatility + expansion,
ATR%, compression score, expansion score, gap% + gap continuation-vs-fade, session, opening-range /
premarket-level test. Missing inputs → null features (recorded in `missing[]`), never guessed.
`relVolume` prefers a real time-of-day baseline; absent that, a bar-based volume-surge PROXY (only when
volume clearly accelerates) — labeled, not fabricated. `featuresToUnderlying` maps to the monitor's
snapshot shape so the 18-strategy scorer gets richer, earlier evidence.

## Options features (`chain-features.ts summarizeChainFeatures`)
From the real chain snapshot: total call/put volume, call/put ratio, aggregate vol/OI, strikes active,
expirations active, near-the-money concentration, IV level, median spread, zero-bid rate, best
executable contract per DTE band, chain freshness — plus the abstain-safe abnormal-activity flag.
`flowClassification` is ALWAYS `unclassified_no_trade_data`: NEVER sweep/institutional/directional flow
without trade tape.

## Market context
SPY/QQQ/IWM trend, volatility regime, relative strength, breadth are consumed via the existing market-
context capture when a valid provider source exists; absent that they are recorded as missing (no
fabrication). Wiring richer index/breadth feeds is a later enrichment.

## Storage
The full enriched decision-time snapshot (underlying + chain + fractionMove + earliness phase) is stored
in `options_candidates.feature_snapshot_json` and `options_paper_trades.feature_snapshot_json` — this is
exactly what AI/analog shadow consume asynchronously (they never receive future data).
