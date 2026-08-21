/**
 * promotion.ts — WHO EARNS EXPENSIVE WORK, and HOW MANY can be afforded.
 *
 * This is the second half of the split `awareness.ts` describes. Awareness sees
 * the whole universe for free; promotion decides which of it is worth bars, a
 * strategy evaluation, an option chain and a contract selection.
 *
 * WHAT CHANGED, PRECISELY.
 *
 *   BEFORE   25 was the number of symbols the monitor was AWARE of per cycle.
 *            Everything else was invisible, so nothing else could be judged.
 *   AFTER    the whole eligible universe is aware-of every cycle, and 25-ish is
 *            the number that gets EXPENSIVE WORK. Same provider spend, ~64x the
 *            visibility.
 *
 * THE NUMBER IS NOT PICKED, IT IS DERIVED. The owner requirement was explicit
 * that broader awareness must not become a licence to hard-code a bigger slot
 * count. So capacity is computed each cycle from what is actually affordable:
 *
 *   requests the minute partition still has
 *   MINUS what live critical demand (Tier-0/1, open-position grading) is owed
 *   DIVIDED BY the measured request cost of one promotion (bars + expected chain)
 *   BOUNDED BY what the cycle latency SLO can execute at the configured concurrency
 *
 * On a tight minute it shrinks; with headroom it grows; it is bounded on both
 * sides and can never issue 1,600 of anything. `explain()` shows which of the
 * three constraints bound it, so a small number is always attributable.
 *
 * FAIRNESS SURVIVES. A share of every cycle rotates through the universe by
 * cursor, so a name that never scores well still advances — the property
 * `rotateForBudget` was introduced for, kept. What is gone is the guarantee
 * that advancing was the ONLY way in: a symbol whose state becomes interesting
 * is promoted on its score in the very next cycle, without waiting ~160 of them.
 *
 * PURE. No clock, no I/O, no env read beyond the explicit config resolver.
 */
import { rotateForBudget } from "../asymmetry/sweep-rotation.ts";
import type { AwarenessRow, AwarenessSweep, AwarenessBand } from "./awareness.ts";

const num = (v: string | undefined, d: number, min = -Infinity): number => {
  const x = Number(v);
  return Number.isFinite(x) && x >= min ? x : d;
};
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/* ---------------------------------------------------------------------------
 * CAPACITY
 * -------------------------------------------------------------------------*/

export interface PromotionCapacityConfig {
  /**
   * Provider requests one promotion is expected to cost: the bars fetch plus
   * the expected chain spend, which is fractional because most promoted symbols
   * are rejected by strategy scoring BEFORE any chain is requested.
   */
  estRequestsPerPromotion: number;
  /** Requests per cycle to leave untouched for Tier-0/1 and open-position grading. */
  reservedForCriticalPerCycle: number;
  /** Wall-clock the Tier-2 cycle must finish within, to hold the scanner SLO. */
  cycleLatencyBudgetMs: number;
  /** Measured wall-clock of one promoted symbol deep pass. */
  estPerPromotionMs: number;
  /** Promotions executed at once. Mirrors the monitor own concurrency setting. */
  maxConcurrency: number;
  /**
   * Absolute backstop. NOT the operative number — the budget and latency math
   * above almost always binds first. This exists so a mis-reported headroom can
   * never turn into an unbounded fan-out.
   */
  hardCeiling: number;
  /**
   * Share of capacity reserved for rotation/exploration rather than score.
   * Fairness is a correctness property: a symbol never observed deeply can
   * never be judged, so pure top-N would permanently freeze the tail.
   */
  explorationShare: number;
}

export const DEFAULT_PROMOTION_CAPACITY: Readonly<PromotionCapacityConfig> = Object.freeze({
  estRequestsPerPromotion: 1.6,
  reservedForCriticalPerCycle: 20,
  cycleLatencyBudgetMs: 45_000,
  estPerPromotionMs: 1_200,
  maxConcurrency: 4,
  hardCeiling: 120,
  explorationShare: 0.25,
});

export function promotionCapacityConfig(env: NodeJS.ProcessEnv = process.env): PromotionCapacityConfig {
  const d = DEFAULT_PROMOTION_CAPACITY;
  return {
    estRequestsPerPromotion: num(env.OPTIONS_PROMOTION_EST_REQUESTS, d.estRequestsPerPromotion, 0.1),
    reservedForCriticalPerCycle: num(env.OPTIONS_PROMOTION_CRITICAL_RESERVE, d.reservedForCriticalPerCycle, 0),
    cycleLatencyBudgetMs: num(env.OPTIONS_PROMOTION_CYCLE_LATENCY_MS, d.cycleLatencyBudgetMs, 1000),
    estPerPromotionMs: num(env.OPTIONS_PROMOTION_EST_MS, d.estPerPromotionMs, 1),
    maxConcurrency: num(env.OPTIONS_MAX_CONCURRENCY, d.maxConcurrency, 1),
    hardCeiling: num(env.OPTIONS_PROMOTION_HARD_CEILING, d.hardCeiling, 1),
    explorationShare: clamp(num(env.OPTIONS_PROMOTION_EXPLORATION_SHARE, d.explorationShare, 0), 0, 0.9),
  };
}

/** What the provider budget looks like right now, as the caller measured it. */
export interface ProviderHeadroom {
  /** Requests still available in the current minute partition. */
  remainingThisMinute: number;
  /** Requests per minute the lane is allowed. Used only for the reported ratio. */
  minuteCap: number;
}

export type CapacityBinding = "provider_budget" | "latency_slo" | "hard_ceiling" | "no_headroom";

export interface PromotionCapacity {
  /** Promotions this cycle may perform. Always bounded, always >= 0. */
  capacity: number;
  /** Which constraint actually decided the number. */
  boundBy: CapacityBinding;
  /** 0..1 fraction of the minute partition still available. */
  headroomRatio: number;
  /** Capacity each individual constraint would have allowed, for diagnosis. */
  byConstraint: { providerBudget: number; latencySlo: number; hardCeiling: number };
  /** Human-readable derivation, so a small number is never unattributable. */
  explain: string;
}

/**
 * Compute how many symbols this cycle can afford to analyse deeply.
 *
 * Deliberately returns 0 rather than a floor when there is genuinely no
 * headroom. A guaranteed minimum would be a guaranteed way to overrun the
 * minute partition, which is what produced the 11,449 quota blocks in the first
 * place — and a quota block costs a request while returning nothing, so
 * overrunning is strictly worse than waiting one cycle.
 */
export function computePromotionCapacity(
  headroom: ProviderHeadroom,
  cfg: PromotionCapacityConfig = DEFAULT_PROMOTION_CAPACITY,
): PromotionCapacity {
  const spendable = Math.max(0, headroom.remainingThisMinute - cfg.reservedForCriticalPerCycle);
  const providerBudget = Math.floor(spendable / Math.max(cfg.estRequestsPerPromotion, 1e-6));
  const latencySlo = Math.floor(
    (cfg.cycleLatencyBudgetMs / Math.max(cfg.estPerPromotionMs, 1e-6)) * Math.max(1, cfg.maxConcurrency),
  );
  const hardCeiling = Math.floor(cfg.hardCeiling);

  const capacity = Math.max(0, Math.min(providerBudget, latencySlo, hardCeiling));
  const boundBy: CapacityBinding = capacity === 0
    ? "no_headroom"
    : capacity === providerBudget ? "provider_budget"
      : capacity === latencySlo ? "latency_slo"
        : "hard_ceiling";

  const headroomRatio = headroom.minuteCap > 0
    ? +clamp(headroom.remainingThisMinute / headroom.minuteCap, 0, 1).toFixed(3)
    : 0;

  return {
    capacity,
    boundBy,
    headroomRatio,
    byConstraint: { providerBudget, latencySlo, hardCeiling },
    explain: `${capacity} promotions — provider ${providerBudget} `
      + `(${spendable} spendable / ${cfg.estRequestsPerPromotion} per promotion), `
      + `latency ${latencySlo} (${cfg.cycleLatencyBudgetMs}ms / ${cfg.estPerPromotionMs}ms x ${cfg.maxConcurrency}), `
      + `ceiling ${hardCeiling}; bound by ${boundBy}`,
  };
}

/* ---------------------------------------------------------------------------
 * SELECTION
 * -------------------------------------------------------------------------*/

export type PromotionKind = "SCORE" | "EXPLORATION";

export interface PromotionDecision {
  symbol: string;
  kind: PromotionKind;
  preScore: number;
  band: AwarenessBand;
  awarenessRank: number;
  reason: string;
}

export interface PromotionSelection {
  /** Symbols to analyse deeply this cycle. `capacity` of them at most. */
  promoted: PromotionDecision[];
  /** Symbols promoted on merit. */
  byScore: string[];
  /** Symbols promoted because their turn came round. */
  byExploration: string[];
  /** Cursor the NEXT cycle rotates from. */
  nextCursor: number;
  /**
   * Cheaply observed but not promoted this cycle. NOT "unobserved" — current
   * cheap evidence exists for every one of them, which is the whole point of
   * keeping the two metrics apart.
   */
  notPromoted: number;
  /** Size of the universe that was cheaply observed. */
  universeSize: number;
  capacity: number;
}

/**
 * Choose this cycle promotions: merit first, then rotation for the remainder.
 *
 * The exploration band is the full universe MINUS whatever score already took,
 * so a name that stops scoring rejoins the queue rather than dropping out, and
 * a name that has never scored still advances every cycle. Same round-robin the
 * research sweeps use.
 *
 * NOTE ON BANDS. `AwarenessBand` classifies state but reserves no quota here.
 * Fixed per-band quotas are exactly what made the old 15/10 split rigid: a name
 * outside the priority band waited its turn no matter what it was doing. Bands
 * are for reporting and for the missed-opportunity record; the ordering is the
 * score, which already accounts for band-defining behaviour.
 */
export function selectPromotions(
  sweep: AwarenessSweep,
  cursor: number,
  capacity: number,
  cfg: PromotionCapacityConfig = DEFAULT_PROMOTION_CAPACITY,
): PromotionSelection {
  const universeSize = sweep.rows.length;
  const cap = Math.max(0, Math.floor(capacity));
  if (universeSize === 0 || cap === 0) {
    return {
      promoted: [], byScore: [], byExploration: [],
      nextCursor: cursor, notPromoted: universeSize, universeSize, capacity: cap,
    };
  }

  const explorationSlots = Math.min(cap, Math.floor(cap * cfg.explorationShare));
  const scoreSlots = cap - explorationSlots;

  const decide = (r: AwarenessRow, kind: PromotionKind): PromotionDecision => ({
    symbol: r.symbol,
    kind,
    preScore: r.preScore,
    band: r.band,
    awarenessRank: r.rank,
    reason: r.reason,
  });

  // sweep.rows is already ranked by preScore.
  const byScoreRows = sweep.rows.slice(0, scoreSlots);
  const taken = new Set(byScoreRows.map((r) => r.symbol));

  const explorationBand = sweep.rows.filter((r) => !taken.has(r.symbol));
  const rot = rotateForBudget(explorationBand, cursor, explorationSlots);

  const promoted = [
    ...byScoreRows.map((r) => decide(r, "SCORE")),
    ...rot.selected.map((r) => decide(r, "EXPLORATION")),
  ];

  return {
    promoted,
    byScore: byScoreRows.map((r) => r.symbol),
    byExploration: rot.selected.map((r) => r.symbol),
    nextCursor: rot.nextCursor,
    notPromoted: Math.max(0, universeSize - promoted.length),
    universeSize,
    capacity: cap,
  };
}

/**
 * Cycles needed for the EXPLORATION band alone to sweep the universe once.
 *
 * Reported rather than designed-around: it is the worst case for a symbol that
 * NEVER scores, and it is deliberately no longer the mechanism a moving symbol
 * depends on. COIN accelerating is promoted by score on the next cycle; this
 * number only bounds how long a permanently-quiet name waits.
 */
export function explorationSweepCycles(universeSize: number, capacity: number, cfg: PromotionCapacityConfig = DEFAULT_PROMOTION_CAPACITY): number {
  const explorationSlots = Math.floor(Math.max(0, capacity) * cfg.explorationShare);
  if (explorationSlots <= 0) return 0;
  return Math.ceil(universeSize / explorationSlots);
}
