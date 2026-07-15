/**
 * discovery-ranking.ts — PURE ranking for the broad-universe discovery sweep.
 *
 * The old discovery score ranked purely on |day-move| (capped) + volume. That
 * promotes stocks that are ALREADY up big with heavy cumulative volume — i.e.
 * late tops and slow grinders — while a stock that just STARTED moving fast (a
 * small day-move but a steep move-per-minute right now) ranks low and is
 * discovered late. This module adds a fresh-acceleration term computed from the
 * change in day-move BETWEEN consecutive discovery snapshots (Δmove/Δt), which
 * needs no per-symbol provider call — it reuses the bulk snapshot we already
 * fetch. Exceptional fresh accelerators are flagged for IMMEDIATE promotion so
 * they don't wait a full rank cycle.
 *
 * Deterministic, no clock in the output (caller passes nowMs), no I/O.
 */

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const num = (v: string | undefined, d: number): number => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export interface DiscoveryQuote {
  symbol: string;
  price: number | null;
  changePercent: number | null; // day move %
  volume: number | null;        // cumulative day volume
}

export interface DiscoverySnapshot {
  changePercent: number | null;
  atMs: number;
}

export interface DiscoveryRankConfig {
  minPrice: number;
  maxPrice: number;
  minGainFromPrevClosePct: number;
  minVolume: number;
  topN: number;
  /** Day-move %, contribution capped here (don't reward total gain past this). */
  moveCapPct: number;
  /** Day-move beyond this % is penalized as extension (chasing a late move). */
  extensionPct: number;
  /** Move-velocity (%/min) at/above which a name is an exceptional fresh mover → immediate promote. */
  immediatePromotePctPerMin: number;
  /** Weight on the fresh-acceleration term in the composite score. */
  freshAccelWeight: number;
}

export function discoveryRankConfig(env: NodeJS.ProcessEnv = process.env): DiscoveryRankConfig {
  return {
    minPrice: num(env.STOCK_MOMENTUM_MIN_PRICE, 0.5),
    maxPrice: num(env.STOCK_MOMENTUM_MAX_PRICE, 50),
    minGainFromPrevClosePct: num(env.STOCK_MOMENTUM_MIN_GAIN_FROM_PREV_CLOSE_PCT, 10),
    minVolume: num(env.STOCK_MOMENTUM_MIN_DAY_VOLUME ?? env.SCANNER_DISCOVERY_MIN_VOLUME, 500_000),
    topN: num(env.SCANNER_DISCOVERY_TOP_N, 30),
    moveCapPct: num(env.SCANNER_DISCOVERY_MOVE_CAP_PCT, 20),
    extensionPct: num(env.SCANNER_DISCOVERY_EXTENSION_PCT, 25),
    immediatePromotePctPerMin: num(env.SCANNER_DISCOVERY_IMMEDIATE_PCT_PER_MIN, 1.2),
    freshAccelWeight: num(env.SCANNER_DISCOVERY_FRESH_WEIGHT, 25),
  };
}

export interface RankedDiscovery {
  symbol: string;
  score: number;
  rank: number;                 // 1-based
  moveVelocityPctPerMin: number | null;
  immediatePromote: boolean;
  reason: string;
}

/**
 * Move-velocity in %/min from the previous discovery snapshot of the same symbol.
 * Uses the SIGNED day-move so a name reversing (giving back gains) reads as
 * negative velocity — never a fresh mover. Null when there is no prior snapshot
 * or the interval is degenerate.
 */
export function moveVelocityPctPerMin(cur: number | null, prev: DiscoverySnapshot | undefined, nowMs: number): number | null {
  if (!isNum(cur) || !prev || !isNum(prev.changePercent)) return null;
  const dtMin = (nowMs - prev.atMs) / 60_000;
  if (!(dtMin > 0) || dtMin > 5) return null; // stale prior snapshot — don't trust the delta
  return +((cur - prev.changePercent) / dtMin).toFixed(3);
}

/**
 * Rank the discovery universe. Names failing the broad stock-runner floor are
 * dropped: $0.50-$50, cumulative day volume >= floor (including premarket),
 * and at least +10% from the previous regular-session close by default.
 * The composite score rewards CURRENT acceleration (Δmove/min in the move's own
 * direction) and penalizes extension, so a fresh fast mover outranks a stock
 * that is merely already up a lot.
 */
export function rankDiscovery(
  quotes: DiscoveryQuote[],
  prev: Map<string, DiscoverySnapshot>,
  nowMs: number,
  cfg: DiscoveryRankConfig = discoveryRankConfig(),
): RankedDiscovery[] {
  const scored = quotes
    .filter((q) =>
      q.symbol &&
      isNum(q.price) &&
      (q.price as number) >= cfg.minPrice &&
      (q.price as number) <= cfg.maxPrice &&
      isNum(q.changePercent) &&
      (q.changePercent as number) >= cfg.minGainFromPrevClosePct &&
      (q.volume ?? 0) >= cfg.minVolume
    )
    .map((q) => {
      const move = Math.abs(q.changePercent as number);
      const vel = moveVelocityPctPerMin(q.changePercent as number, prev.get(q.symbol), nowMs);
      // Fresh acceleration in the move's OWN direction (a reversal contributes 0, not a boost).
      const alignedVel = isNum(vel) ? (q.changePercent as number) >= 0 ? vel : -vel : 0;
      const freshAccel = clamp(alignedVel, 0, 4); // %/min, capped
      const volume = Math.log10(Math.max(1, q.volume ?? 0));
      const extensionPenalty = Math.max(0, move - cfg.extensionPct) * 2.5;
      const score = +(
        Math.min(move, cfg.moveCapPct) * 2
        + volume * 5
        + freshAccel * cfg.freshAccelWeight
        - extensionPenalty
      ).toFixed(3);
      const immediatePromote = freshAccel >= cfg.immediatePromotePctPerMin;
      const reason = immediatePromote
        ? `fresh acceleration ${freshAccel.toFixed(2)}%/min (immediate promote)`
        : isNum(vel)
          ? `move ${move.toFixed(1)}% · vel ${alignedVel.toFixed(2)}%/min`
          : `move ${move.toFixed(1)}% · vel n/a (first snapshot)`;
      return { symbol: q.symbol, score, moveVelocityPctPerMin: vel, immediatePromote, reason };
    })
    .sort((a, b) => b.score - a.score)
    .map((r, i) => ({ ...r, rank: i + 1 }));
  return scored;
}

/**
 * The set of symbols to promote this cycle: the top-N by score PLUS any
 * exceptional fresh accelerator regardless of its rank (so a brand-new runner is
 * never gated out by names that were already up big).
 */
export function promotionSet(ranked: RankedDiscovery[], cfg: DiscoveryRankConfig = discoveryRankConfig()): RankedDiscovery[] {
  const top = ranked.slice(0, Math.max(0, cfg.topN));
  const inTop = new Set(top.map((r) => r.symbol));
  const rescued = ranked.filter((r) => r.immediatePromote && !inTop.has(r.symbol));
  return [...top, ...rescued];
}
