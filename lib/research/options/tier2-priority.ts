/**
 * tier2-priority.ts — WHICH broad-optionable symbols the Tier-2 monitor looks at
 * this cycle.
 *
 * WHY THIS EXISTS, in one measurement.
 *
 * On 2026-08-19 MRNA opened around +84% and ran to +133%. It cleared Tier-2
 * eligibility with room to spare — roughly $2.3B of dollar volume against a $20M
 * floor — and OptiScan produced NO record of it: no scanner row, no opportunity
 * case, no NBBO, no contract. It was never strategy-rejected because it was
 * never looked at.
 *
 * The reason was one line: `uni.slice(0, cfg.maxSymbolsPerTier2Cycle)` over a
 * list built by `.filter(...).map(...)` off the whole-market snapshot. That list
 * is in PROVIDER ORDER, which is not an order at all. Measured against the live
 * snapshot the same morning:
 *
 *   tier-2 eligible universe          1,347 symbols
 *   observed per 60s cycle                25  (1.9%)
 *   MRNA's index in provider order       605
 *   MRNA's rank by |day move|              5  of 1,347
 *   the 25 actually taken   CARR VGSH LLY RF SFM FORM USD VOT CLSK LUNR
 *                           INTU AAAU W RAMZ SPCX BSP RVMD PFE SIL ONTO
 *                           GSK SBET VB LULU SHY
 *
 * A short-duration treasury ETF and a gold trust held slots while the fifth
 * largest mover in the eligible universe was never reached — and because there
 * was no rotation either, it was never going to be. The same 25 were taken every
 * cycle, all session.
 *
 * WHAT THIS IS NOT. It is not a trade-selection ranking. Nothing here scores a
 * setup, chooses a contract, sets a target, or authorizes a callout. It decides
 * only where a fixed, unchanged observation budget is pointed. Every strategy,
 * threshold and delivery gate downstream is untouched and still gets to reject
 * whatever this admits.
 *
 * THE BUDGET IS UNCHANGED. Exactly `slots` symbols are returned, as before.
 *
 * PURE. No clock, no I/O, no env read (the caller resolves config).
 */
import { rotateForBudget } from "../asymmetry/sweep-rotation.ts";

export interface Tier2Candidate {
  symbol: string;
  /** Signed day move %, as the snapshot reports it. */
  changePercent: number | null;
  /** Underlying dollar volume for the day. Used only to break ties. */
  dayDollarVolume: number | null;
}

export interface Tier2PriorityConfig {
  /**
   * |day move %| at or above which a symbol is EXCEPTIONAL: it holds a slot every
   * cycle rather than waiting its turn. 10% is the same floor the broad stock
   * lane already treats as a runner, so the two lanes agree on what "moving"
   * means.
   */
  exceptionalMovePct: number;
  /**
   * Most slots the exceptional band may take. The remainder ALWAYS rotates, which
   * is what makes starvation impossible: on the wildest day at least
   * `slots - maxPrioritySlots` names still advance through the queue.
   */
  maxPrioritySlots: number;
}

export const DEFAULT_TIER2_PRIORITY: Readonly<Tier2PriorityConfig> = Object.freeze({
  exceptionalMovePct: 10,
  maxPrioritySlots: 15,
});

export function tier2PriorityConfig(env: NodeJS.ProcessEnv = process.env): Tier2PriorityConfig {
  const n = (v: string | undefined, d: number, min: number) => {
    const x = Number(v);
    return Number.isFinite(x) && x >= min ? x : d;
  };
  return {
    exceptionalMovePct: n(env.OPTIONS_TIER2_EXCEPTIONAL_MOVE_PCT, DEFAULT_TIER2_PRIORITY.exceptionalMovePct, 0),
    maxPrioritySlots: n(env.OPTIONS_TIER2_MAX_PRIORITY_SLOTS, DEFAULT_TIER2_PRIORITY.maxPrioritySlots, 0),
  };
}

export interface RankedTier2 {
  symbol: string;
  /** |day move %|. */
  movePct: number;
  dayDollarVolume: number;
  rank: number;
  exceptional: boolean;
}

/**
 * Rank by absolute day move, break ties by dollar volume, then by symbol.
 *
 * DELIBERATELY NOT a composite with liquidity weighted in. Liquidity is already
 * a GATE upstream (`tier2Eligible` requires $20M of dollar volume), and scoring
 * it again is how the old broad-discovery score ended up promoting mega-caps
 * that were merely large over stocks that were actually moving. A symbol that
 * passed the gate is liquid enough; what remains to discriminate on is the move.
 *
 * The two-level tie-break exists so the order is REPRODUCIBLE: a pure |move|
 * sort leaves ties in input order, and input order here is provider order, which
 * is the arbitrariness being removed.
 */
export function rankTier2(candidates: readonly Tier2Candidate[]): RankedTier2[] {
  const rows = candidates
    .filter((c) => c.symbol)
    .map((c) => ({
      symbol: String(c.symbol).toUpperCase(),
      movePct: Number.isFinite(c.changePercent as number) ? Math.abs(c.changePercent as number) : 0,
      dayDollarVolume: Number.isFinite(c.dayDollarVolume as number) ? (c.dayDollarVolume as number) : 0,
    }))
    .sort((a, b) =>
      b.movePct - a.movePct
      || b.dayDollarVolume - a.dayDollarVolume
      || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0),
    );
  return rows.map((r, i) => ({ ...r, rank: i + 1, exceptional: false }));
}

export interface Tier2Selection {
  /** The symbols to observe this cycle. Exactly `min(slots, universe)` of them. */
  selected: string[];
  /** Held a slot because they are moving exceptionally. */
  priority: string[];
  /** Held a slot because their turn came round. */
  rotated: string[];
  /** Cursor the NEXT cycle must start its rotation from. */
  nextCursor: number;
  /** How many eligible symbols were not observed this cycle. */
  deferred: number;
  /** Cycles needed to sweep the whole rotation band once, at this slot count. */
  cyclesForFullCoverage: number;
}

/**
 * Choose this cycle's symbols: the exceptional movers, then rotation for the rest.
 *
 * The rotation band is the FULL ranked universe minus whatever the priority band
 * took, so a name that stops being exceptional rejoins the queue rather than
 * dropping out, and a name that has never been exceptional still advances every
 * cycle. `rotateForBudget` is the same round-robin the research sweeps use.
 */
export function selectTier2Cycle(
  candidates: readonly Tier2Candidate[],
  cursor: number,
  slots: number,
  cfg: Tier2PriorityConfig = DEFAULT_TIER2_PRIORITY,
): Tier2Selection {
  const ranked = rankTier2(candidates);
  const budget = Math.max(0, Math.floor(slots));
  if (!ranked.length || budget === 0) {
    return { selected: [], priority: [], rotated: [], nextCursor: cursor, deferred: ranked.length, cyclesForFullCoverage: 0 };
  }

  const priorityCap = Math.max(0, Math.min(cfg.maxPrioritySlots, budget));
  const priority: string[] = [];
  for (const r of ranked) {
    if (priority.length >= priorityCap) break;
    if (r.movePct < cfg.exceptionalMovePct) break; // ranked by move, so the rest are smaller
    priority.push(r.symbol);
  }

  const taken = new Set(priority);
  const rotationBand = ranked.filter((r) => !taken.has(r.symbol)).map((r) => r.symbol);
  const rotationSlots = Math.max(0, budget - priority.length);
  const rot = rotateForBudget(rotationBand, cursor, rotationSlots);

  return {
    selected: [...priority, ...rot.selected],
    priority,
    rotated: rot.selected,
    nextCursor: rot.nextCursor,
    deferred: rot.deferred,
    cyclesForFullCoverage: rotationSlots > 0 ? Math.ceil(rotationBand.length / rotationSlots) : 0,
  };
}
