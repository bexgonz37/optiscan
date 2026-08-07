/**
 * `LHC_SELECT_V1` — a versioned, SHADOW-ONLY pre-entry selection rule for
 * `lower_high_continuation`, and the simulator that is allowed to say it is wrong.
 *
 * WHY THIS EXISTS
 *
 * The trailing-stop study taught the expensive lesson: a risk-control backtest that cannot
 * express the DOWNSIDE of the policy will always look excellent. Trail-10% read as mean
 * +10.86% / PF 1.652 until the simulator could clip a winner, then it read -8.03% / PF 0.549.
 * So `simulate()` below reports winners LOST before it reports losses avoided, and every
 * caller gets `winnersRejected` whether it asks or not.
 *
 * WHAT THE RULE IS
 *
 * Four independent, economically-motivated axes, each of which separated winners from losers
 * in BOTH halves of a date-separated split and rejects zero of the eight cohort winners:
 *
 *   ATM   moneyness within 0.5% of spot, not ITM
 *   DTE   3 days or fewer
 *   LIQ   underlying dollar volume >= $4B
 *   IV    contract IV <= 0.55
 *
 * These are not four independent discoveries. Delta is pinned near 0.45 by contract
 * selection, so for a FIXED delta the strike distance is a function of implied move: a
 * delta-0.45 put lands 0.2% from spot on low-vol AAPL and 1.9% away on ACHR. The losing
 * population is the one where the market had already priced a move large enough that a
 * delta-0.45 strike sits over 1% out — and the -40% premium safety band then fires on
 * ordinary noise before the thesis can resolve. The four gates are four views of one defect:
 * the lane bought implied move it could not outrun.
 *
 * WHAT IT IS NOT
 *
 * It is not evidence that the lane is profitable. On the cohort the rule reads PF 1.240,
 * but remove the single +343.93% AAPL run and it reads 0.611; cap returns at +60% and it
 * reads 0.721. The improvement over baseline is large and repeated (baseline 0.311 / 0.153 /
 * 0.181 on those same three framings) and it is still a losing system without the convex
 * tail. `simulate()` returns all three framings so no caller can quote only the flattering one.
 *
 * PURE. No I/O, no clock, no env. Shadow only — nothing here gates a delivery.
 */

import type { CohortRow } from "./lower-high-cohort.ts";
import { assertNoLeakage, type PreEntryFeatures } from "./pre-entry-features.ts";

export const EXPERIMENT_ID = "LHC_SELECT_V1";
/** Shadow means shadow. No code path may consult this to authorize a send. */
export const EXPERIMENT_MODE = "SHADOW_PAPER_ONLY" as const;

export interface GateSpec {
  id: string;
  label: string;
  /** Why this is a real mechanism and not a fitted threshold. */
  rationale: string;
  test: (f: PreEntryFeatures) => boolean | null;
}

export const GATES: readonly GateSpec[] = Object.freeze([
  {
    id: "ATM_BAND",
    label: "strike within 0.5% of spot and not ITM",
    rationale:
      "At a fixed ~0.45 delta, strike distance measures the implied move already priced in. " +
      "Beyond 0.5% the thesis must beat the market's own expectation before the premium moves.",
    test: (f) => (f.moneynessPct == null ? null : f.moneynessPct >= -0.5 && f.moneynessPct <= 0),
  },
  {
    id: "SHORT_DTE",
    label: "3 DTE or fewer",
    rationale:
      "lower_high_continuation is an intraday structure claim. Longer expiries dilute the " +
      "move being predicted into days the thesis says nothing about.",
    test: (f) => (f.dte == null ? null : f.dte <= 3),
  },
  {
    id: "UNDERLYING_LIQUIDITY",
    label: "underlying dollar volume >= $4B",
    rationale:
      "Thin underlyings produce wide option markets and gap through levels; every single-name " +
      "underlying below this line in the cohort lost.",
    test: (f) => (f.dollarVolume == null ? null : f.dollarVolume >= 4e9),
  },
  {
    id: "IV_CEILING",
    label: "contract IV <= 0.55",
    rationale:
      "A -40% premium band on a high-IV contract is reachable by noise alone, so the position " +
      "is stopped out before the underlying thesis is decided.",
    test: (f) => (f.iv == null ? null : f.iv <= 0.55),
  },
]);

export interface RankComponent { id: string; points: number; max: number }
export interface SelectionDecision {
  experimentId: string;
  mode: typeof EXPERIMENT_MODE;
  admitted: boolean;
  /** Gates that rejected. Empty when admitted. */
  blockedBy: string[];
  /** Gates that could not be evaluated because the input was missing. */
  unavailable: string[];
  score: number;
  components: RankComponent[];
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/**
 * Deterministic 0-100 rank. Used to ORDER admitted candidates when Discord slots are scarce,
 * not to admit them — admission is the gates above. Weights mirror the measured separation.
 */
export function rankScore(f: PreEntryFeatures): { score: number; components: RankComponent[] } {
  const c: RankComponent[] = [
    {
      id: "atmFit", max: 30,
      points: 30 * clamp(1 - Math.abs(clamp(f.moneynessPct ?? -1, -1, 0.25) + 0.2) / 0.8, 0, 1),
    },
    { id: "dteFit", max: 20, points: f.dte == null ? 0 : f.dte <= 1 ? 20 : f.dte <= 3 ? 16 : f.dte <= 5 ? 8 : 0 },
    { id: "spreadFit", max: 15, points: 15 * clamp((6 - (f.spreadPct ?? 6)) / 5, 0, 1) },
    {
      id: "liquidityFit", max: 15,
      points: 15 * clamp((Math.log10(Math.max(f.dollarVolume ?? 1e8, 1e8)) - 9) / 2, 0, 1),
    },
    { id: "ivFit", max: 10, points: 10 * clamp((2.2 - (f.ivLevel ?? 2.2)) / 1.7, 0, 1) },
    { id: "flowFit", max: 10, points: 10 * clamp((2.2 - (f.callPutVolRatio ?? 2.2)) / 1.8, 0, 1) },
  ].map((x) => ({ ...x, points: Math.round(x.points * 100) / 100 }));
  return { score: Math.round(c.reduce((s, x) => s + x.points, 0) * 100) / 100, components: c };
}

export function evaluate(features: PreEntryFeatures): SelectionDecision {
  // Structural guard: a hindsight field must never reach the rule, even by refactor accident.
  assertNoLeakage(features as unknown as Record<string, unknown>, `${EXPERIMENT_ID}.evaluate`);
  const blockedBy: string[] = [];
  const unavailable: string[] = [];
  for (const g of GATES) {
    const r = g.test(features);
    // Fail closed: an unmeasurable gate does not admit. Shadow-only, so this costs nothing live.
    if (r === null) { unavailable.push(g.id); blockedBy.push(g.id); }
    else if (!r) blockedBy.push(g.id);
  }
  const { score, components } = rankScore(features);
  return {
    experimentId: EXPERIMENT_ID, mode: EXPERIMENT_MODE,
    admitted: blockedBy.length === 0, blockedBy, unavailable, score, components,
  };
}

// ---------------------------------------------------------------------------
// Simulation — built so the policy can lose.
// ---------------------------------------------------------------------------

export interface ArmStats {
  n: number; winners: number; losses: number; winRate: number | null;
  meanReturnPct: number | null; medianReturnPct: number | null; profitFactor: number | null;
  avgWinnerPct: number | null; avgLoserPct: number | null; largestWinnerPct: number | null;
}

function armStats(rows: readonly CohortRow[], transform: (r: number) => number = (x) => x): ArmStats {
  const v = rows.filter((r) => r.returnPct != null).map((r) => transform(r.returnPct!));
  if (!v.length) {
    return { n: 0, winners: 0, losses: 0, winRate: null, meanReturnPct: null, medianReturnPct: null, profitFactor: null, avgWinnerPct: null, avgLoserPct: null, largestWinnerPct: null };
  }
  const w = v.filter((x) => x > 0), l = v.filter((x) => x <= 0);
  const gross = w.reduce((s, x) => s + x, 0), lossSum = -l.reduce((s, x) => s + x, 0);
  const sorted = [...v].sort((a, b) => a - b);
  return {
    n: v.length, winners: w.length, losses: l.length, winRate: w.length / v.length,
    meanReturnPct: v.reduce((s, x) => s + x, 0) / v.length,
    medianReturnPct: sorted.length % 2 ? sorted[sorted.length >> 1] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2,
    profitFactor: lossSum > 0 ? gross / lossSum : null,
    avgWinnerPct: w.length ? gross / w.length : null,
    avgLoserPct: l.length ? -lossSum / l.length : null,
    largestWinnerPct: w.length ? Math.max(...w) : null,
  };
}

export interface WinnerImpact {
  paperTradeId: number; symbol: string | null; returnPct: number;
  admitted: boolean; blockedBy: string[];
}

export interface SimulationResult {
  experimentId: string;
  mode: typeof EXPERIMENT_MODE;
  /** Set false here forever. Nothing in this module changes production behaviour. */
  productionBehaviorChanged: false;
  baseline: ArmStats;
  experiment: ArmStats;
  /** Reported FIRST and unconditionally — the trailing-stop lesson. */
  winnersRejected: WinnerImpact[];
  winnersRetained: WinnerImpact[];
  realizedWinnerValueLostPts: number;
  lossesAvoided: number;
  lossesStillAdmitted: number;
  lossValueAvoidedPts: number;
  /** Same comparison with the single best trade removed, and with returns capped. */
  exTopWinner: { baseline: ArmStats; experiment: ArmStats };
  cappedAt60: { baseline: ArmStats; experiment: ArmStats };
}

export function simulate(rows: readonly CohortRow[]): SimulationResult {
  const closed = rows.filter((r) => r.returnPct != null);
  const decide = (r: CohortRow) => evaluate(r.features);
  const admitted = closed.filter((r) => decide(r).admitted);
  const rejected = closed.filter((r) => !decide(r).admitted);

  const impact = (r: CohortRow): WinnerImpact => {
    const d = decide(r);
    return { paperTradeId: r.paperTradeId, symbol: r.symbol, returnPct: r.returnPct!, admitted: d.admitted, blockedBy: d.blockedBy };
  };
  const winners = closed.filter((r) => r.returnPct! > 0);
  const winnersRejected = winners.filter((r) => !decide(r).admitted).map(impact);
  const winnersRetained = winners.filter((r) => decide(r).admitted).map(impact);
  const rejectedLosses = rejected.filter((r) => r.returnPct! <= 0);

  const best = winners.length ? Math.max(...winners.map((r) => r.returnPct!)) : null;
  const dropTop = (list: readonly CohortRow[]) =>
    best == null ? [...list] : list.filter((r) => r.returnPct !== best);
  const cap = (x: number) => Math.min(x, 60);

  return {
    experimentId: EXPERIMENT_ID, mode: EXPERIMENT_MODE, productionBehaviorChanged: false,
    baseline: armStats(closed),
    experiment: armStats(admitted),
    winnersRejected,
    winnersRetained,
    realizedWinnerValueLostPts: Math.round(winnersRejected.reduce((s, w) => s + w.returnPct, 0) * 100) / 100,
    lossesAvoided: rejectedLosses.length,
    lossesStillAdmitted: admitted.filter((r) => r.returnPct! <= 0).length,
    lossValueAvoidedPts: Math.round(rejectedLosses.reduce((s, r) => s + r.returnPct!, 0) * 100) / 100,
    exTopWinner: { baseline: armStats(dropTop(closed)), experiment: armStats(dropTop(admitted)) },
    cappedAt60: { baseline: armStats(closed, cap), experiment: armStats(admitted, cap) },
  };
}

/**
 * Date-separated validation. A rule that only works on the sessions that produced it is a
 * description of those sessions; `developmentSessions` names the block the rule was read from
 * and everything after it is untouched validation.
 */
export function splitByDate(
  rows: readonly CohortRow[],
  developmentSessions: readonly string[],
): { development: CohortRow[]; validation: CohortRow[] } {
  const dev = new Set(developmentSessions);
  return {
    development: rows.filter((r) => dev.has(r.sessionDate)),
    validation: rows.filter((r) => !dev.has(r.sessionDate)),
  };
}

/** Per-session hold-out: the rule must not make any individual session worse. */
export function perSessionEffect(rows: readonly CohortRow[]): {
  sessionDate: string; baseline: ArmStats; experiment: ArmStats;
  winnersLost: number; direction: "BETTER" | "WORSE" | "NEUTRAL";
}[] {
  const sessions = [...new Set(rows.map((r) => r.sessionDate))].sort();
  return sessions.map((s) => {
    const held = rows.filter((r) => r.sessionDate === s && r.returnPct != null);
    const adm = held.filter((r) => evaluate(r.features).admitted);
    const b = armStats(held), e = armStats(adm);
    const winnersLost = held.filter((r) => r.returnPct! > 0 && !evaluate(r.features).admitted).length;
    const bp = b.profitFactor, ep = e.profitFactor;
    const direction = winnersLost > 0 ? "WORSE"
      : bp == null || ep == null ? "NEUTRAL"
      : ep > bp ? "BETTER" : ep < bp ? "WORSE" : "NEUTRAL";
    return { sessionDate: s, baseline: b, experiment: e, winnersLost, direction };
  });
}
