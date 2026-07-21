# REAL_OPTIONS_PAPER_EXECUTION

`lib/research/options/paper.ts` + table `options_paper_trades` (separate from equity `paper_trades`).
Flag: `REAL_OPTION_PAPER_ENABLED` (OFF).

## Entry (`buildRealOptionEntry`)
Requires a real OCC symbol + a fresh two-sided quote and passes `realOptionEntryEligible` (non-zero-bid,
spread ≤ cap, quote fresh, OI/volume sufficient) — otherwise rejected (no fabricated fill). The fill is
CONSERVATIVE and executable: `conservativeEntryFill` pays 60% of the way from mid → ask (worse on wide/
illiquid spreads) — NEVER a naive mid. Records side, strike, expiration, DTE, bid/ask/mid/spread,
volume/OI, IV/Greeks when provided, underlying price, strategy, target/invalidation, provenance.

## Exit + P&L (`realOptionExit`)
Sells 60% toward the bid (conservative marketable exit); P&L is `(exitFill − entryFill) × 100 ×
contracts` — computed from the OPTION contract price, NEVER the underlying return.

## Classification (`classifyPaperResult`) — never combined
EQUITY_PAPER / REAL_OPTION_PAPER / MODELED_OPTION_RESEARCH / UNDERLYING_PROXY_INVALID. Calls and puts
are both paper-traded and graded; puts remain RESEARCH_ONLY for public actionable output. No real-money
execution.
