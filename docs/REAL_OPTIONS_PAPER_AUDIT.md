# REAL_OPTIONS_PAPER_AUDIT

## Current state (code)
`lib/paper-engine.ts` + `paper-entry/exits/fill-model/revalidation/options-analytics/position-sizer`.
Option paper trades DO carry: a real `option_symbol` (OCC), `entry_bid`/`entry_ask`/`entry_spread_pct`,
`strike`, `expiration`, `option_type`, `entry_iv`/`entry_delta/gamma/theta/vega`, `entry_oi`,
`entry_volume`, ×100 multiplier, and option-price P&L (`(exit-entry)*100*contracts`). Equity trades have
`option_symbol IS NULL`. `paper-revalidation.ts` re-checks the quote before entry.

So real-option paper EXISTS. What was missing is a single, enforced CLASSIFICATION so results are never
blended and a clear REAL-vs-MODELED boundary.

## New classification (`lib/research/options/paper-class.ts`)
Every paper result is exactly one of (never combined):
- **EQUITY_PAPER** — stock trade (no option contract).
- **REAL_OPTION_PAPER** — valid OCC symbol + real two-sided bid/ask + option-basis P&L.
- **MODELED_OPTION_RESEARCH** — outcome is a Greeks reprice, not a real fill (research only).
- **UNDERLYING_PROXY_INVALID_FOR_OPTIONS_CLAIMS** — P&L came from the underlying proxy (invalid as an
  option result).

`realOptionEntryEligible()` gates REAL_OPTION_PAPER entry: valid OCC, non-zero-bid, spread ≤ cap, quote
fresh, OI/volume sufficient — otherwise reject (no fabricated fill). Flag `REAL_OPTION_PAPER_ENABLED`
(OFF) controls whether real-option paper is written distinctly.

## Grading (required)
Grade calls and puts SEPARATELY; grade by DTE band and strategy SEPARATELY (see
OPTIONS_STRATEGY_CATALOG + section L). No blended win rate across classes/sides/tenors.
