/**
 * system-explanation.ts — single source of truth for the /review page and
 * GET /api/review/system-explanation. Claims here are deliberately modest and
 * verifiable: what the system DOES, not what results it promises.
 */

export const SYSTEM_EXPLANATION = {
  title: "How this 0DTE options momentum scanner works",
  summary:
    "OptiScan is a 0DTE options momentum scanner. It finds fast-moving, liquid tickers and determines whether the 0DTE options are still worth watching. It does not rely on news or catalysts. It focuses on speed, direction, volume, VWAP behavior, high/low-of-day breaks, option liquidity, bid/ask spread, premium risk, and whether the move is continuing or exhausted. It does not place trades and it does not give recommendations.",
  pipeline: [
    "Every second: one bulk snapshot of a small, highly liquid 0DTE universe (SPY/QQQ/index ETFs + deep-weekly single names). Per symbol it maintains a rolling ring buffer and computes price acceleration, volume surge, path efficiency (chop detection), VWAP side, and high/low-of-day state.",
    "Trigger: a symbol fires only when velocity is real AND volume confirms it (or a level breaks), the tape isn't pure chop, and its cooldown has expired. News is never consulted.",
    "On trigger only: fetch the 0DTE chain (nearest expiry fallback), rank near-the-money calls AND puts by liquidity, spread, delta zone, and premium sanity — never 'cheapest' or 'most volume' blindly.",
    "Score: Setup Score (momentum 20, volume 15, VWAP/levels 15, contract liquidity 25, spread 10, 0DTE fit 10, timing 10, minus up to 25 risk) + separate Call Watch and Put Watch scores + a 0DTE Contract Score + 'Option Still Worth It'.",
    "Explain: deterministic six-part read — why it triggered, what supports it, what makes it risky, the liquidity read, what confirms, what invalidates. AI is optional and never in the scoring path.",
    "Track: every alert is re-measured at 5m/15m/30m/1h/EOD; false positives are recorded, and live option quotes refresh for active alerts.",
  ],
  notJustMovement: [
    "It answers the actual question: is the move fast enough, is the direction clear, are CALLS or PUTS the relevant side, and is the contract still worth it after the move already made?",
    "A stock up 15% is NOT automatically skipped — if it is still accelerating with volume it reads Continuation Setup; if it is decelerating it reads Chase Risk. Size never decides alone.",
    "It checks whether 0DTE contracts have workable spreads, real volume, usable deltas, and premium that doesn't already price in more move than plausibly remains.",
    "No news is neutral. Catalysts attach after the alert as optional context and never gate, boost, or suppress a clean momentum signal.",
  ],
  comparedToBrokerScanners: [
    "Broker scanners help users find symbols and execute quickly.",
    "This scanner asks 'is the option still tradable after the move?' — direction, continuation vs exhaustion, spread, premium, and time-of-day, with every alert tracked afterward.",
    "The goal is not just speed. The goal is better decision support, less noise, and more transparency.",
  ],
  designGoals: [
    "Designed to answer up-or-down and calls-vs-puts explicitly on every alert.",
    "Designed to be more explainable.",
    "Designed around a fast intraday 0DTE workflow.",
    "Designed to track whether alerts actually worked.",
    "Designed to reduce noise and avoid structurally bad contracts.",
  ],
  honestLimits: [
    "Scores are heuristics with no backtested edge; nothing here is a recommendation or a profit claim.",
    "0DTE trading is among the fastest ways to lose premium: theta decay is brutal, spreads are paid twice within minutes, and reversals are violent. The scanner measures structure; it cannot remove that risk.",
    "The 1-second loop needs a paid real-time data plan; on delayed data, alerts are for practice/logging only.",
    "Contract 'responsiveness' is proxied via delta zone and spread — true tick-level option responsiveness isn't available.",
    "All output is educational/research information — not financial advice.",
  ],
};
