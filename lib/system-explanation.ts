/**
 * system-explanation.ts — single source of truth for the /review page and
 * GET /api/review/system-explanation. Claims here are deliberately modest and
 * verifiable: what the system DOES, not what results it promises.
 */

export const SYSTEM_EXPLANATION = {
  title: "How this scanner works",
  summary:
    "OptiScan combines price action, volume, catalyst detection, and options liquidity into scored, explained, tracked scanner alerts. It does not place trades and it does not give recommendations.",
  pipeline: [
    "Scan: shortlist the biggest movers in a liquid universe (bulk quotes + whole-market top movers).",
    "Enrich: per symbol, pull intraday candles and the full options chain (paginated).",
    "Score: momentum quality, options liquidity (spread/volume/OI/DTE), risk flags, and catalyst quality feed a 0-100 setup score with a stored component breakdown.",
    "Explain: every alert gets a deterministic six-part read — why it triggered, what supports it, what makes it risky, the liquidity read, what would confirm it, what would invalidate it.",
    "Track: each alert is re-measured at 5m/15m/30m/1h/EOD from minute candles — favorable move, drawdown, and a false-positive verdict at end of day.",
    "Learn: the Alert Lab and trade journal close the loop — which setup types actually followed through, and what you actually did about them.",
  ],
  notJustMovement: [
    "It checks whether options contracts have enough volume/open interest and acceptable spreads before calling a setup tradable-quality.",
    "It classifies WHY a ticker is moving from real headlines, and says 'no clear catalyst' when there isn't one.",
    "It penalizes extended moves instead of celebrating them — a +12% mover is usually a late alert, not an early one.",
    "It records its own misses: false positives are measured and reported, not hidden.",
  ],
  comparedToBrokerScanners: [
    "Broker scanners help users find symbols and execute quickly.",
    "This scanner focuses on explanation, options liquidity, catalyst quality, setup scoring, and post-alert performance.",
    "The goal is not just speed. The goal is better decision support, less noise, and more transparency.",
  ],
  designGoals: [
    "Designed to be more explainable.",
    "Designed around a specific options research workflow.",
    "Designed to track whether alerts actually worked.",
    "Designed to reduce noise.",
    "Designed to support more disciplined decisions.",
  ],
  honestLimits: [
    "Scores are heuristics with no backtested edge; nothing here is a recommendation or a profit claim.",
    "Quote midpoints are not guaranteed fills; data may be delayed depending on the provider plan.",
    "Catalyst detection is headline-keyword based; float, halt, and social-sentiment data are not available and are never faked.",
    "All output is educational/research information — not financial advice.",
  ],
};
