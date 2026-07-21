# STOCK_VS_OPTIONS_ARCHITECTURE

Two SEPARATE products. Their formulas, thresholds, universes, and reporting must not be merged.

| Dimension | Stock Momentum Radar | Options Opportunity Scanner |
|---|---|---|
| Purpose | flag regular stocks in a MAJOR move | few EARLY, useful options callouts/day |
| Core rule | broad ~+10% mover floor ($0.50–$50, ≥500k) — INTENTIONAL, untouched | strategy-specific EARLY triggers; **never requires +10%** |
| Universe | curated ~230 + whole-market broad sweep | core liquid options names + independent earnings/options-activity discovery |
| Entry signals | day-move + move-velocity | breakout-forming, ORB, compression→expansion, momentum-accel, earnings, UOA, index 0DTE, swings |
| DTE | n/a | 0DTE→14 primary; longer when the swing is clearly stronger |
| Sides | long momentum | calls + puts (puts RESEARCH_ONLY; bearish-gate authority) |
| Grading | equity paper | REAL_OPTION_PAPER (OCC + bid/ask) vs MODELED_OPTION_RESEARCH (kept separate) |
| Reporting | stock-radar win rate | per side / per tenor (0/1-7/8-14/15-30/31-90/longer) / per strategy — never blended |

The stock radar's +10% rule stays. The options catalog (`lib/research/options/strategy-catalog.ts`)
is the formal, per-strategy parameter set that makes the options product distinct and early. Nothing
here is actionable yet; puts stay RESEARCH_ONLY; no real-money execution.
