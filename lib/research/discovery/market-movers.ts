/**
 * market-movers.ts — WHAT IS EXCEPTIONAL IN THE MARKET RIGHT NOW, decided
 * independently of anything OptiScan has chosen to trade.
 *
 * WHY THIS EXISTS, in one measurement.
 *
 * On 2026-08-19 MRNA gapped premarket, opened around +84%, and ran to +133% on
 * ~$2.3B of volume. OptiScan produced NO record of it. Its own leveraged ETF,
 * MRNY, WAS scanned at +125.8% — the system saw the derivative and not the
 * underlying — because broad discovery admits `$0.50-$50` and MRNA opened at
 * $116.
 *
 * THE CONFLATION THIS SEPARATES. `broadStockEligibility()` is a TRADING gate:
 * it decides whether a stock is a candidate for a stock-momentum callout, and
 * its $50 ceiling is defensible there — that lane is built around small-account
 * accessibility and share-size economics on a runner. But `refreshDiscovery()`
 * calls the same function to decide what the scanner is even allowed to LOOK
 * AT. One rule was answering two different questions, and the answer to the
 * trading question silently became the answer to the observation question.
 *
 * Measured against the live whole-market snapshot at 10:55 ET that morning:
 *
 *   movers >= +10% passing the floor WITH the $50 ceiling      67
 *   movers >= +10% passing the floor WITHOUT it                78
 *   therefore invisible to every lane outside the curated list 11
 *     MRNX $114 +264%   MRNA $147 +133%   GDXU $157 +26%   BNTX $113 +22%
 *     TWST $139 +19%    NUGT $185 +17%    TEM  $58  +18%   EL   $98  +16%
 *     MRK  $149 +10%    MSTR $103 +12%    CRCL $80  +11%
 *
 * A discovery ceiling is not protecting anything there — it is deleting the two
 * largest moves in the market before anything downstream can judge them. Under
 * this module a $120 stock is DISCOVERABLE even though the stock-momentum
 * trading lane will still reject it on price, and that is the intended shape:
 * observe widely, trade narrowly.
 *
 * WHAT THIS IS NOT
 *
 *   - Not a news scanner. Every input below comes from the price/volume snapshot.
 *   - Not a signal. Nothing here authorizes a callout, opens a position, or
 *     changes a strategy. A large gap is a reason to LOOK, never a reason to buy.
 *   - Not a relative-volume model. The whole-market snapshot carries no average
 *     volume, so there is no honest baseline to compute RVOL against and none is
 *     invented. Dollar volume is used instead, because it is directly observed.
 *
 * PURE. No clock of its own (the caller passes `nowMs`), no I/O, no provider call.
 */

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const num = (v: string | undefined, d: number): number => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Everything one whole-market snapshot row already carries. Nothing is fetched for this. */
export interface MarketQuote {
  symbol: string;
  price: number | null;
  /** Move from the previous regular-session close, signed. Premarket-aware upstream. */
  changePercent: number | null;
  /** Day-to-date cumulative volume, premarket included. */
  volume: number | null;
  dayHigh?: number | null;
  dayLow?: number | null;
  prevClose?: number | null;
  bid?: number | null;
  ask?: number | null;
}

/** A previous observation of the same symbol, for move persistence/velocity. */
export interface MoverSnapshot {
  changePercent: number | null;
  atMs: number;
}

export interface MarketDiscoveryConfig {
  /** Below this a print is noise, not a market. NO CEILING — that is the point. */
  minPrice: number;
  /** Real money must have traded. Directly observed, unlike a relative-volume baseline. */
  minDollarVolume: number;
  /** |move| from prior close at or above which a name is worth looking at. */
  minMovePct: number;
  /** |move| at or above which a name is EXCEPTIONAL. */
  extremeMovePct: number;
  /** Widest quoted spread still treated as tradable, when a quote is present. */
  maxSpreadPct: number;
}

export const DEFAULT_MARKET_DISCOVERY: Readonly<MarketDiscoveryConfig> = Object.freeze({
  minPrice: 1,
  minDollarVolume: 10_000_000,
  minMovePct: 10,
  extremeMovePct: 25,
  maxSpreadPct: 5,
});

export function marketDiscoveryConfig(env: NodeJS.ProcessEnv = process.env): MarketDiscoveryConfig {
  return {
    minPrice: num(env.MARKET_DISCOVERY_MIN_PRICE, DEFAULT_MARKET_DISCOVERY.minPrice),
    minDollarVolume: num(env.MARKET_DISCOVERY_MIN_DOLLAR_VOLUME, DEFAULT_MARKET_DISCOVERY.minDollarVolume),
    minMovePct: num(env.MARKET_DISCOVERY_MIN_MOVE_PCT, DEFAULT_MARKET_DISCOVERY.minMovePct),
    extremeMovePct: num(env.MARKET_DISCOVERY_EXTREME_MOVE_PCT, DEFAULT_MARKET_DISCOVERY.extremeMovePct),
    maxSpreadPct: num(env.MARKET_DISCOVERY_MAX_SPREAD_PCT, DEFAULT_MARKET_DISCOVERY.maxSpreadPct),
  };
}

export interface MarketDiscoveryDecision {
  eligible: boolean;
  /** Every floor this row failed. Empty when eligible. */
  rejections: string[];
}

/**
 * MARKET DISCOVERY ELIGIBILITY — "is this worth observing", not "is this
 * tradable". Deliberately has no price ceiling and no strategy opinion.
 */
export function marketDiscoveryEligible(
  q: MarketQuote,
  cfg: MarketDiscoveryConfig = DEFAULT_MARKET_DISCOVERY,
): MarketDiscoveryDecision {
  const r: string[] = [];
  if (!q.symbol) r.push("missing_symbol");
  if (!isNum(q.price) || (q.price as number) < cfg.minPrice) r.push("price_below_floor");
  const dollarVolume = (q.price ?? 0) * (q.volume ?? 0);
  if (!(dollarVolume >= cfg.minDollarVolume)) r.push("insufficient_dollar_volume");
  if (!isNum(q.changePercent) || Math.abs(q.changePercent as number) < cfg.minMovePct) r.push("move_below_floor");
  return { eligible: r.length === 0, rejections: r };
}

export interface RankedMover {
  symbol: string;
  /** Signed move from prior close. */
  movePct: number;
  /** |movePct|. What the ranking is built on. */
  absMovePct: number;
  dollarVolume: number;
  /** Intraday range as % of prior close. Null when the snapshot lacks the fields. */
  rangeExpansionPct: number | null;
  /** Quoted spread %, when both sides are present. Null otherwise — never guessed. */
  spreadPct: number | null;
  /** Move change per minute since the previous observation. Null on first sight. */
  velocityPctPerMin: number | null;
  score: number;
  rank: number;
  extreme: boolean;
  /** Plain-language reason, so a ranked row explains itself in a report. */
  reason: string;
}

/** Quoted spread as a % of the mid. Null unless both sides are genuinely present. */
export function spreadPctOf(q: MarketQuote): number | null {
  const bid = isNum(q.bid) ? (q.bid as number) : null;
  const ask = isNum(q.ask) ? (q.ask as number) : null;
  if (bid == null || ask == null || bid <= 0 || ask < bid) return null;
  const mid = (bid + ask) / 2;
  if (!(mid > 0)) return null;
  return +(((ask - bid) / mid) * 100).toFixed(3);
}

/** Intraday range as a % of prior close. Null when the snapshot lacks the fields. */
export function rangeExpansionPctOf(q: MarketQuote): number | null {
  const hi = isNum(q.dayHigh) ? (q.dayHigh as number) : null;
  const lo = isNum(q.dayLow) ? (q.dayLow as number) : null;
  const prev = isNum(q.prevClose) ? (q.prevClose as number) : null;
  if (hi == null || lo == null || prev == null || !(prev > 0) || !(hi >= lo)) return null;
  return +(((hi - lo) / prev) * 100).toFixed(3);
}

/**
 * Move velocity in %/min from the previous observation of the same symbol.
 * Signed against the move's OWN direction, so a name giving back its gain reads
 * negative and is never mistaken for a fresh accelerator. Reuses the convention
 * `discovery-ranking.ts` established rather than inventing a second one.
 */
export function moverVelocityPctPerMin(
  cur: number | null,
  prev: MoverSnapshot | undefined,
  nowMs: number,
): number | null {
  if (!isNum(cur) || !prev || !isNum(prev.changePercent)) return null;
  const dtMin = (nowMs - prev.atMs) / 60_000;
  if (!(dtMin > 0) || dtMin > 5) return null; // stale prior — the delta means nothing
  return +((cur - prev.changePercent) / dtMin).toFixed(3);
}

/**
 * Rank the market's movers.
 *
 * The score is |move| plus a bounded freshness term, plus a bounded liquidity
 * term to separate a $2.3B mover from a $10M one. Liquidity is DELIBERATELY
 * log-scaled and capped: it must break ties between movers, never promote a
 * merely-large name above a moving one — the failure the old broad-discovery
 * score had, where "already up a lot with heavy cumulative volume" outranked a
 * stock that had just started running.
 *
 * A wide quoted spread is penalised only when a spread is actually observable.
 * A missing quote is recorded as missing and costs nothing, because "we could
 * not see it" and "it was bad" must never score the same.
 */
export function rankMarketMovers(
  quotes: readonly MarketQuote[],
  prev: Map<string, MoverSnapshot>,
  nowMs: number,
  cfg: MarketDiscoveryConfig = DEFAULT_MARKET_DISCOVERY,
): RankedMover[] {
  const rows = quotes
    .filter((q) => marketDiscoveryEligible(q, cfg).eligible)
    .map((q) => {
      const movePct = q.changePercent as number;
      const absMovePct = Math.abs(movePct);
      const dollarVolume = (q.price ?? 0) * (q.volume ?? 0);
      const spreadPct = spreadPctOf(q);
      const rangeExpansionPct = rangeExpansionPctOf(q);
      const velocity = moverVelocityPctPerMin(movePct, prev.get(q.symbol), nowMs);
      const alignedVel = velocity == null ? 0 : movePct >= 0 ? velocity : -velocity;

      const moveTerm = absMovePct;
      const freshTerm = clamp(alignedVel, 0, 5) * 4;
      const liquidityTerm = clamp(Math.log10(Math.max(1, dollarVolume)) - 7, 0, 4) * 3;
      const spreadPenalty = spreadPct != null && spreadPct > cfg.maxSpreadPct
        ? clamp(spreadPct - cfg.maxSpreadPct, 0, 40)
        : 0;
      const score = +(moveTerm + freshTerm + liquidityTerm - spreadPenalty).toFixed(3);

      const extreme = absMovePct >= cfg.extremeMovePct;
      const reason = [
        `${movePct >= 0 ? "+" : ""}${movePct.toFixed(1)}% from prior close`,
        `$${(dollarVolume / 1e6).toFixed(0)}M traded`,
        velocity == null ? "velocity n/a (first observation)" : `${alignedVel.toFixed(2)}%/min`,
        spreadPct == null ? "spread not quoted" : `spread ${spreadPct.toFixed(2)}%`,
      ].join(" · ");

      return {
        symbol: String(q.symbol).toUpperCase(),
        movePct: +movePct.toFixed(3),
        absMovePct: +absMovePct.toFixed(3),
        dollarVolume: Math.round(dollarVolume),
        rangeExpansionPct,
        spreadPct,
        velocityPctPerMin: velocity,
        score,
        extreme,
        reason,
      };
    })
    // Stable and reproducible: score, then dollar volume, then symbol. A pure
    // score sort leaves ties in input order, and input order is provider order.
    .sort((a, b) =>
      b.score - a.score
      || b.dollarVolume - a.dollarVolume
      || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0),
    );
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}
