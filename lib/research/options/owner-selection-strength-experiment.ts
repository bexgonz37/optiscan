/**
 * `OWNER_SELECTION_STRENGTH_GATE_V1` — a frozen, SHADOW-ONLY hypothesis about the owner
 * callout lane, and the simulator that is allowed to say it is wrong.
 *
 * THE HYPOTHESIS
 *
 * Owner callouts whose SELECTED strategy evaluation froze a `selectionStrength` below 75
 * have materially worse forward expectancy than callouts at or above it.
 *
 * WHAT THIS MAY NEVER DO
 *
 * Reject, reroute, delay, reorder or annotate a live callout. There is no return value any
 * delivery path reads, and `productionBehaviorChanged` is `false` by construction. The
 * baseline arm IS current production behaviour, recorded as it happens; the shadow arm is a
 * label written beside it. The most this experiment can reach on its own evidence is
 * READY_FOR_HUMAN_REVIEW — a request, never a grant. There is deliberately no
 * SUBSCRIBER_APPROVED anywhere in its vocabulary.
 *
 * THE DEFECT THIS MODULE IS SHAPED AROUND
 *
 * The finding as previously recorded read: "selectionStrength < 75 — n≈26, PF 0.167,
 * mean −31%". Reproduced against production on 2026-08-18 that bucket is not what it says.
 * It is `< 75 OR NOT MEASURED AT ALL`:
 *
 *     strength < 75      n=13   PF 0.0273   mean −39.03%   1 winner
 *     strength missing   n=13   PF 0.3305   mean −22.98%   4 winners
 *     the two together   n=26   PF 0.1670   mean −31.00%   5 winners   ← the recorded number
 *
 * Thirteen closed owner trades carry no strength because their case holds no evaluation
 * matching the strategy that was traded. Folding them into the reject arm would credit the
 * rule with avoiding 12 losses it can decide plus 9 it cannot, and would charge it 1 rejected
 * winner instead of 5 — a filter scored on trades it is not able to judge. MISSING EVIDENCE
 * IS NOT A LOW SCORE.
 *
 * So the verdict is THREE-VALUED. `UNEVALUABLE` rows are excluded from BOTH arms and
 * reported as their own population with their own statistics, and the baseline arm is
 * restricted to the same evaluable rows the shadow arm sees — because a shadow arm measured
 * on 41 trades against a baseline measured on 67 is not a comparison, it is two samples.
 *
 * CENSORING (the standing hazard for any shadow filter)
 *
 * This one is structurally clean, and that is a property of its shape rather than luck: it
 * only ever REJECTS from a population the baseline already delivered and already tracked. In
 * production the owner lane is 74 openings / 74 exact mirrors / mirror rate 1.00 / 0 OCC
 * mismatches, so every trade the rule rejects still has a real, exact-contract outcome to
 * hold it to. A filter that ADMITS something the baseline never delivered would have no
 * outcome at all — this one cannot, because its admit set is a subset of what was delivered.
 * `coverage` reports the mirror rate anyway rather than assuming it, and any callout without
 * exact-contract evidence is counted as censored instead of quietly dropped.
 *
 * PURE. No I/O, no clock, no env. The loader and the DB writer are separate modules.
 */

import { createHash } from "node:crypto";

export const EXPERIMENT_ID = "OWNER_SELECTION_STRENGTH_GATE_V1" as const;
export const EXPERIMENT_VERSION = 1 as const;
/** Shadow means shadow. No code path may consult this to authorize, block or order a send. */
export const EXPERIMENT_MODE = "SHADOW_ONLY" as const;

/**
 * The floor, and the ONLY tunable number in this rule.
 *
 * It is 75 because that is where the audit that motivated the experiment drew its line, not
 * because 75 optimised anything — a threshold chosen by sweeping this sample would be a
 * description of this sample. Moving it changes `definitionHash()` and fails the freeze
 * guard; the remedy is to register V2, never to edit V1.
 */
export const SELECTION_STRENGTH_FLOOR = 75;

/**
 * ADMIT       strength present and at or above the floor — the shadow arm keeps it
 * REJECT      strength present and below the floor — the shadow arm would have dropped it
 * UNEVALUABLE no strength was frozen for the strategy that was actually traded
 */
export type StrengthVerdict = "ADMIT" | "REJECT" | "UNEVALUABLE";

export interface StrengthFeatures {
  /** The SELECTED strategy's frozen 0–100 strength. Never the delivery quality score. */
  selectionStrength: number | null;
}

export interface StrengthDecision {
  experimentId: typeof EXPERIMENT_ID;
  experimentVersion: typeof EXPERIMENT_VERSION;
  mode: typeof EXPERIMENT_MODE;
  verdict: StrengthVerdict;
  selectionStrength: number | null;
  floor: number;
  reason: string;
  /** False here forever. Nothing in this module changes what is delivered. */
  productionBehaviorChanged: false;
}

/**
 * The rule. One gate, three answers.
 *
 * A non-finite or out-of-range score is UNEVALUABLE rather than REJECT: a corrupt number is
 * an absence of evidence wearing the costume of a low one, and rejecting on it would let bad
 * data flatter the filter.
 */
export function evaluateSelectionStrength(f: StrengthFeatures): StrengthDecision {
  const raw = f.selectionStrength;
  const base = {
    experimentId: EXPERIMENT_ID, experimentVersion: EXPERIMENT_VERSION, mode: EXPERIMENT_MODE,
    floor: SELECTION_STRENGTH_FLOOR, productionBehaviorChanged: false as const,
  };
  if (raw == null || !Number.isFinite(raw) || raw < 0 || raw > 100) {
    return {
      ...base, verdict: "UNEVALUABLE", selectionStrength: null,
      reason: raw == null
        ? "no strength was frozen for the strategy that was traded — excluded from both arms"
        : `strength ${raw} is not a usable 0–100 score — excluded from both arms`,
    };
  }
  const admitted = raw >= SELECTION_STRENGTH_FLOOR;
  return {
    ...base,
    verdict: admitted ? "ADMIT" : "REJECT",
    selectionStrength: raw,
    reason: admitted
      ? `selection strength ${raw} is at or above the ${SELECTION_STRENGTH_FLOOR} floor`
      : `selection strength ${raw} is below the ${SELECTION_STRENGTH_FLOOR} floor`,
  };
}

/**
 * Content hash of the rule's BEHAVIOUR, not its text. The floor is probed across a sweep
 * including its exact boundary and both invalid tails, so moving the threshold — or quietly
 * changing what happens to a missing score — changes the hash even if the source reads the same.
 */
export function definitionHash(): string {
  const h = createHash("sha256");
  h.update(`${EXPERIMENT_ID}:${EXPERIMENT_VERSION}:${EXPERIMENT_MODE}:`);
  const probes: Array<number | null> = [
    null, Number.NaN, Number.POSITIVE_INFINITY, -1, -0.0001, 0, 1, 25, 49.9, 50,
    60, 70, 74, 74.999, 75, 75.001, 76, 80, 90, 99, 99.999, 100, 100.001, 1e6,
  ];
  for (const p of probes) {
    const d = evaluateSelectionStrength({ selectionStrength: p as number | null });
    h.update(`${String(p)}=>${d.verdict};`);
  }
  return h.digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// Simulation — built so the rule can lose.
// ---------------------------------------------------------------------------

/** One closed owner callout, as the experiment needs to see it. */
export interface StrengthOutcomeRow {
  opportunityCaseId: string;
  sessionDate: string | null;
  symbol: string | null;
  /** The contract the callout froze. The only contract whose return may be priced. */
  optionSymbol: string | null;
  side: "CALL" | "PUT" | null;
  strategyKey: string | null;
  selectionStrength: number | null;
  realizedReturnPct: number | null;
  /** False when the mirror is not on the exact called contract — censored, never priced. */
  occExact: boolean;
}

export interface ArmStats {
  n: number;
  winners: number;
  losses: number;
  winRate: number | null;
  meanReturnPct: number | null;
  medianReturnPct: number | null;
  profitFactor: number | null;
  /** Profit factor with the single best winner removed. The tail-dependence check. */
  profitFactorExBestWinner: number | null;
  grossGainsPct: number;
  grossLossesPct: number;
  avgWinnerPct: number | null;
  avgLoserPct: number | null;
  bestWinnerPct: number | null;
  worstLossPct: number | null;
  /** Share of gross gains contributed by the single best winner. 1.0 = one trade is the result. */
  bestWinnerShareOfGains: number | null;
}

const r4 = (x: number | null): number | null =>
  x == null || !Number.isFinite(x) ? null : Math.round(x * 10_000) / 10_000;

export function armStats(returns: readonly number[]): ArmStats {
  const v = returns.filter((x) => Number.isFinite(x));
  if (!v.length) {
    return {
      n: 0, winners: 0, losses: 0, winRate: null, meanReturnPct: null, medianReturnPct: null,
      profitFactor: null, profitFactorExBestWinner: null, grossGainsPct: 0, grossLossesPct: 0,
      avgWinnerPct: null, avgLoserPct: null, bestWinnerPct: null, worstLossPct: null,
      bestWinnerShareOfGains: null,
    };
  }
  const w = v.filter((x) => x > 0);
  const l = v.filter((x) => x <= 0);
  const gross = w.reduce((s, x) => s + x, 0);
  const lossSum = -l.reduce((s, x) => s + x, 0);
  const sorted = [...v].sort((a, b) => a - b);
  const best = w.length ? Math.max(...w) : null;
  return {
    n: v.length,
    winners: w.length,
    losses: l.length,
    winRate: r4(w.length / v.length),
    meanReturnPct: r4(v.reduce((s, x) => s + x, 0) / v.length),
    medianReturnPct: r4(sorted.length % 2 ? sorted[sorted.length >> 1] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2),
    profitFactor: lossSum > 0 ? r4(gross / lossSum) : null,
    // One winner is not too few to answer this. A lane carried entirely by one trade
    // reports 0, and 0 is the finding.
    profitFactorExBestWinner: lossSum > 0 && best != null ? r4((gross - best) / lossSum) : null,
    grossGainsPct: r4(gross) ?? 0,
    grossLossesPct: r4(lossSum) ?? 0,
    avgWinnerPct: w.length ? r4(gross / w.length) : null,
    avgLoserPct: l.length ? r4(-lossSum / l.length) : null,
    bestWinnerPct: best == null ? null : r4(best),
    worstLossPct: l.length ? r4(Math.min(...l)) : null,
    bestWinnerShareOfGains: best != null && gross > 0 ? r4(best / gross) : null,
  };
}

export interface TradeImpact {
  opportunityCaseId: string;
  symbol: string | null;
  optionSymbol: string | null;
  sessionDate: string | null;
  strategyKey: string | null;
  side: "CALL" | "PUT" | null;
  selectionStrength: number | null;
  returnPct: number;
}

export interface SessionEffect {
  sessionDate: string;
  baseline: ArmStats;
  shadow: ArmStats;
  winnersRejected: number;
  /** Whether the rule helped, hurt, or did nothing measurable in THIS session alone. */
  direction: "BETTER" | "WORSE" | "NEUTRAL" | "UNDECIDABLE";
}

export interface CompositionCount {
  key: string;
  baseline: number;
  shadow: number;
  rejected: number;
}

export interface CoverageReport {
  /** Closed callouts considered before any filtering. */
  closedCallouts: number;
  /** Callouts with no exact-contract evidence. Censored: excluded and COUNTED. */
  censoredNoExactContract: number;
  /** Callouts the rule cannot decide. Excluded from both arms and counted. */
  unevaluable: number;
  /** The population both arms are measured on. */
  evaluable: number;
  /** exactMirrors / closedCallouts — measured, never assumed. */
  exactContractCoverage: number | null;
  notes: readonly string[];
}

export interface StrengthSimulation {
  experimentId: typeof EXPERIMENT_ID;
  experimentVersion: typeof EXPERIMENT_VERSION;
  mode: typeof EXPERIMENT_MODE;
  /** Set false here forever. */
  productionBehaviorChanged: false;
  floor: number;

  coverage: CoverageReport;

  /**
   * Current production behaviour, restricted to the rows the rule can decide. This is the
   * ONLY legitimate comparator: measuring a 41-trade shadow arm against a 67-trade baseline
   * compares two populations and calls the difference a rule.
   */
  baseline: ArmStats;
  /** What the rule would have kept. */
  shadow: ArmStats;
  /** What the rule would have dropped. Reported so the filter's cost is visible. */
  rejected: ArmStats;
  /**
   * The rows the rule could not judge, kept apart from every arm above. Their statistics are
   * reported because they are real trades — but they belong to no arm and may never be
   * credited to the filter in either direction.
   */
  unevaluable: ArmStats;
  /** Baseline over EVERY closed callout, for context only. Never the comparator. */
  baselineAllClosed: ArmStats;

  /** Reported FIRST and unconditionally — a filter's winners are its true cost. */
  winnersRejected: TradeImpact[];
  winnersRetained: TradeImpact[];
  lossesRejected: TradeImpact[];
  lossesRetained: TradeImpact[];
  /** Realized winner points the rule would have given up. */
  winnerValueForgonePct: number;
  /** Realized loss points the rule would have avoided. */
  lossValueAvoidedPct: number;
  /** winnersRetained / all evaluable winners. */
  winnerRetentionRate: number | null;
  /** lossesRejected / all evaluable losses. */
  lossRejectionRate: number | null;

  perSession: SessionEffect[];
  sessionsBetter: number;
  sessionsWorse: number;
  byStrategy: CompositionCount[];
  bySide: CompositionCount[];

  /** Sessions represented in the evaluable population. */
  sessions: string[];
}

function toImpact(r: StrengthOutcomeRow): TradeImpact {
  return {
    opportunityCaseId: r.opportunityCaseId,
    symbol: r.symbol,
    optionSymbol: r.optionSymbol,
    sessionDate: r.sessionDate,
    strategyKey: r.strategyKey,
    side: r.side,
    selectionStrength: r.selectionStrength,
    returnPct: r.realizedReturnPct as number,
  };
}

function composition(
  keyOf: (r: StrengthOutcomeRow) => string,
  evaluable: readonly StrengthOutcomeRow[],
  admitted: readonly StrengthOutcomeRow[],
  rejected: readonly StrengthOutcomeRow[],
): CompositionCount[] {
  const keys = [...new Set(evaluable.map(keyOf))].sort();
  return keys.map((key) => ({
    key,
    baseline: evaluable.filter((r) => keyOf(r) === key).length,
    shadow: admitted.filter((r) => keyOf(r) === key).length,
    rejected: rejected.filter((r) => keyOf(r) === key).length,
  }));
}

/**
 * Measure the rule against closed owner callouts.
 *
 * `rows` must be closed outcomes only. Open trades have no return and are not "no result" —
 * including them at 0% would price an unfinished trade as a scratch.
 */
export function simulate(rows: readonly StrengthOutcomeRow[]): StrengthSimulation {
  const closed = rows.filter((r) => r.realizedReturnPct != null && Number.isFinite(r.realizedReturnPct));
  const exact = closed.filter((r) => r.occExact);
  const censored = closed.length - exact.length;

  const decided = exact.map((r) => ({ row: r, d: evaluateSelectionStrength({ selectionStrength: r.selectionStrength }) }));
  const evaluable = decided.filter((x) => x.d.verdict !== "UNEVALUABLE").map((x) => x.row);
  const unevaluableRows = decided.filter((x) => x.d.verdict === "UNEVALUABLE").map((x) => x.row);
  const admitted = decided.filter((x) => x.d.verdict === "ADMIT").map((x) => x.row);
  const rejectedRows = decided.filter((x) => x.d.verdict === "REJECT").map((x) => x.row);

  const ret = (list: readonly StrengthOutcomeRow[]) => list.map((r) => r.realizedReturnPct as number);

  const evalWinners = evaluable.filter((r) => (r.realizedReturnPct as number) > 0);
  const evalLosses = evaluable.filter((r) => (r.realizedReturnPct as number) <= 0);
  const winnersRejected = rejectedRows.filter((r) => (r.realizedReturnPct as number) > 0).map(toImpact);
  const winnersRetained = admitted.filter((r) => (r.realizedReturnPct as number) > 0).map(toImpact);
  const lossesRejected = rejectedRows.filter((r) => (r.realizedReturnPct as number) <= 0).map(toImpact);
  const lossesRetained = admitted.filter((r) => (r.realizedReturnPct as number) <= 0).map(toImpact);

  const sessions = [...new Set(evaluable.map((r) => r.sessionDate).filter((s): s is string => !!s))].sort();
  const perSession: SessionEffect[] = sessions.map((s) => {
    const b = evaluable.filter((r) => r.sessionDate === s);
    const a = admitted.filter((r) => r.sessionDate === s);
    const bs = armStats(ret(b));
    const as_ = armStats(ret(a));
    const winnersLost = b.filter((r) => (r.realizedReturnPct as number) > 0 && !a.includes(r)).length;
    const direction: SessionEffect["direction"] =
      bs.profitFactor == null || as_.profitFactor == null ? "UNDECIDABLE"
        : as_.profitFactor > bs.profitFactor ? "BETTER"
          : as_.profitFactor < bs.profitFactor ? "WORSE"
            : "NEUTRAL";
    return { sessionDate: s, baseline: bs, shadow: as_, winnersRejected: winnersLost, direction };
  });

  return {
    experimentId: EXPERIMENT_ID,
    experimentVersion: EXPERIMENT_VERSION,
    mode: EXPERIMENT_MODE,
    productionBehaviorChanged: false,
    floor: SELECTION_STRENGTH_FLOOR,

    coverage: {
      closedCallouts: closed.length,
      censoredNoExactContract: censored,
      unevaluable: unevaluableRows.length,
      evaluable: evaluable.length,
      exactContractCoverage: closed.length ? r4(exact.length / closed.length) : null,
      notes: Object.freeze([
        "Both arms are measured on the SAME evaluable rows. A shadow arm scored against a " +
        "larger baseline is two populations, not a comparison.",
        "Rows with no frozen strength are UNEVALUABLE and belong to neither arm. Missing " +
        "evidence is not a low score, and the rule is never credited or charged for them.",
        "Rejection-only filter over an already-delivered, already-tracked population: every " +
        "rejected trade retains a real exact-contract outcome, so the reject arm is not censored.",
      ]),
    },

    baseline: armStats(ret(evaluable)),
    shadow: armStats(ret(admitted)),
    rejected: armStats(ret(rejectedRows)),
    unevaluable: armStats(ret(unevaluableRows)),
    baselineAllClosed: armStats(ret(exact)),

    winnersRejected,
    winnersRetained,
    lossesRejected,
    lossesRetained,
    winnerValueForgonePct: r4(winnersRejected.reduce((s, w) => s + w.returnPct, 0)) ?? 0,
    lossValueAvoidedPct: r4(lossesRejected.reduce((s, w) => s + w.returnPct, 0)) ?? 0,
    winnerRetentionRate: evalWinners.length ? r4(winnersRetained.length / evalWinners.length) : null,
    lossRejectionRate: evalLosses.length ? r4(lossesRejected.length / evalLosses.length) : null,

    perSession,
    sessionsBetter: perSession.filter((s) => s.direction === "BETTER").length,
    sessionsWorse: perSession.filter((s) => s.direction === "WORSE").length,
    byStrategy: composition((r) => r.strategyKey ?? "UNKNOWN", evaluable, admitted, rejectedRows),
    bySide: composition((r) => r.side ?? "UNKNOWN", evaluable, admitted, rejectedRows),
    sessions,
  };
}
