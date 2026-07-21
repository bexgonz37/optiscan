# OPTIONS_ACTIVITY_PROVIDER_AUDIT

## What the paid API actually supports today
`lib/polygon-provider.js fetchOptionChain` returns present-time snapshot contracts with: `side`
(call/put), `strike`, `dte`, `bid`, `ask`, `spreadPct`, `volume` (day), `openInterest`, `iv`,
`providerTimestamp`. This supports the abnormal-activity classifier
(`lib/research/discovery/options-activity.ts`):
- contract volume, open interest, **vol/OI ratio**, call/put concentration, **directional imbalance**
  (call share of liquid volume), activity across strikes/expirations, DTE, moneyness (strike vs
  underlying), spread, underlying liquidity, IV level, and **vol-vs-baseline** WHEN a baseline is
  supplied.

## What is NOT supported (must abstain)
- **Trade tape / time-and-sales**: the snapshot has NO per-trade data ⇒ **NEVER** classify sweeps,
  aggressive/opening-vs-closing, or institutional flow. `flowClassification` is always
  `unclassified_no_trade_data`.
- **Historical option quote baseline / NBBO**: not entitled ⇒ vol-vs-baseline requires an external
  baseline; premium-traded is only reported when derivable from real fields.
- Abstain reasons already enforced: stale chain, excessive spread, zero-bid, insufficient OI/volume,
  missing provenance, directionally ambiguous, no abnormal activity.

## Independence
The options-activity source MAY independently introduce a symbol into the options candidate pipeline
(shadow). Flag: `OPTIONS_ACTIVITY_DISCOVERY_ENABLED` (OFF). Keep SHADOW_ONLY until validated.
