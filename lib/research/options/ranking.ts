/**
 * lib/research/options/ranking.ts — deterministic prioritization when several setups qualify at once.
 * PURE. Order: (1) Tier 0 (SPY/QQQ/IWM) → (2) core liquid → (3) broad. Within a tier: still FORMING,
 * lower move-completed %, tighter executable spread, stronger liquidity, closer to the decision level,
 * lower extension/chase, then clearer deterministic setup quality. AI may shadow-rank asynchronously,
 * but this deterministic order is what selects the alert — AI is never awaited.
 */
export interface RankableCandidate {
  symbol: string;
  tier: 0 | 1 | 2;
  forming: boolean;              // setup still forming (not yet fully expanded)
  moveCompletedPct: number;      // 0..1 fraction of the anticipated move already elapsed (lower = earlier)
  spreadPct: number;             // executable option spread (lower = better)
  liquidity: number;             // OI or volume proxy (higher = better)
  levelProximityPct: number;     // distance to the decision level (lower = closer/better)
  extensionPct: number;          // how extended from detection (lower = better)
  quality: number;               // deterministic setup score (higher = better)
}

const num = (v: number, d = 0) => (Number.isFinite(v) ? v : d);

/** Total order (best first). Stable, deterministic — no randomness, no AI. */
export function compareCandidates(a: RankableCandidate, b: RankableCandidate): number {
  if (a.tier !== b.tier) return a.tier - b.tier;                                   // 0 beats 1 beats 2
  if (a.forming !== b.forming) return a.forming ? -1 : 1;                          // forming first
  const by = (x: number, y: number) => x - y;                                      // ascending = better
  return (
    by(num(a.moveCompletedPct, 1), num(b.moveCompletedPct, 1)) ||
    by(num(a.spreadPct, 999), num(b.spreadPct, 999)) ||
    by(num(b.liquidity), num(a.liquidity)) ||                                      // higher liquidity better
    by(num(a.levelProximityPct, 999), num(b.levelProximityPct, 999)) ||
    by(num(a.extensionPct, 999), num(b.extensionPct, 999)) ||
    by(num(b.quality), num(a.quality)) ||                                          // higher quality better
    a.symbol.localeCompare(b.symbol)                                               // deterministic tiebreak
  );
}

export function rankCandidates<T extends RankableCandidate>(cands: T[]): T[] {
  return [...cands].sort(compareCandidates);
}
