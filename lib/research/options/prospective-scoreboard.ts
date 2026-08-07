/**
 * The prospective scoreboard: what the shadow arm has actually shown, and what it has not.
 *
 * WHY THIS SHAPE
 *
 * Two rules govern every number here, and both exist because this codebase has already been
 * burned by their absence:
 *
 * 1. EXPECTANCY AND PF ARE COMPUTED FROM CLOSED OUTCOMES ONLY. An open position has no
 *    realized return; including it means quoting a mark as a result. `openOutcomes` is
 *    reported separately and never enters an arm's statistics.
 *
 * 2. A POSITIVE MFE IS NOT A WIN. `peakPct` is reported as excursion evidence and is never
 *    counted as a winner. The delivered lane contains trades that reached +37% and closed at
 *    -43%; a scoreboard that scored those as wins would be describing a system nobody traded.
 *
 * And one that is specific to this experiment: `tailDependence` is computed unconditionally.
 * V1's historical PF of 1.240 falls to 0.611 without a single trade. Any prospective claim has
 * to carry the same test, so `experimentExTopWinner` is not optional and not behind a flag.
 *
 * PURE. Rows in, report out. No I/O, no clock, no env.
 */

import type { ShadowDecisionRow } from "./shadow-arm-store.ts";
import { LHC_SELECT_V1 } from "./experiment-registry.ts";
import { MIN_MARKS_FOR_TRAJECTORY } from "./lower-high-cohort.ts";

export interface ArmPerformance {
  /** Closed outcomes only. */
  n: number;
  winners: number;
  losses: number;
  winRate: number | null;
  expectancyPct: number | null;
  medianReturnPct: number | null;
  profitFactor: number | null;
  avgWinnerPct: number | null;
  avgLoserPct: number | null;
  largestWinnerPct: number | null;
  largestLoserPct: number | null;
  /** Share of gross profit contributed by the single best trade. */
  topWinnerShareOfGross: number | null;
}

const EMPTY_ARM: ArmPerformance = Object.freeze({
  n: 0, winners: 0, losses: 0, winRate: null, expectancyPct: null, medianReturnPct: null,
  profitFactor: null, avgWinnerPct: null, avgLoserPct: null,
  largestWinnerPct: null, largestLoserPct: null, topWinnerShareOfGross: null,
});

/** Closed rows only. A row without a realized return is not an outcome. */
function closed(rows: readonly ShadowDecisionRow[]): ShadowDecisionRow[] {
  return rows.filter((r) => r.outcomeStatus === "CLOSED" && r.returnPct != null);
}

function armPerformance(
  rows: readonly ShadowDecisionRow[],
  transform: (x: number) => number = (x) => x,
): ArmPerformance {
  const v = closed(rows).map((r) => transform(r.returnPct!));
  if (!v.length) return { ...EMPTY_ARM };
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
    winRate: w.length / v.length,
    expectancyPct: v.reduce((s, x) => s + x, 0) / v.length,
    medianReturnPct: sorted.length % 2
      ? sorted[sorted.length >> 1]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2,
    profitFactor: lossSum > 0 ? gross / lossSum : null,
    avgWinnerPct: w.length ? gross / w.length : null,
    avgLoserPct: l.length ? -lossSum / l.length : null,
    largestWinnerPct: best,
    largestLoserPct: l.length ? Math.min(...l) : null,
    topWinnerShareOfGross: gross > 0 && best != null ? best / gross : null,
  };
}

export interface TrackedCase {
  symbol: string;
  optionSymbol: string;
  sessionDate: string;
  arm: string;
  paperTradeId: number | null;
  outcomeStatus: string | null;
  returnPct: number | null;
  blockedBy: string[];
  /** Excursion evidence, reported only where the mark series supports it. */
  peakPct: number | null;
  trajectoryTrustworthy: boolean;
}

const track = (r: ShadowDecisionRow): TrackedCase => ({
  symbol: r.symbol,
  optionSymbol: r.optionSymbol,
  sessionDate: r.sessionDate,
  arm: r.arm,
  paperTradeId: r.paperTradeId,
  outcomeStatus: r.outcomeStatus,
  returnPct: r.returnPct,
  blockedBy: r.experimentBlockedBy,
  peakPct: (r.sameContractMarks ?? 0) >= MIN_MARKS_FOR_TRAJECTORY ? r.peakPct : null,
  trajectoryTrustworthy: (r.sameContractMarks ?? 0) >= MIN_MARKS_FOR_TRAJECTORY,
});

export interface EvidenceQuality {
  /** Closed rows with enough same-contract marks to support a path claim. */
  trajectoryTrustworthy: number;
  trajectoryUntrustworthy: number;
  /** Decisions where a gate could not be evaluated — those admissions are weaker evidence. */
  decisionsWithUnavailableGates: number;
  /** Which gates could not be measured, and how often. */
  unavailableGateCounts: Record<string, number>;
  /** Honest verdict on whether the sample can support a conclusion yet. */
  verdict: "INSUFFICIENT_EVIDENCE" | "EMERGING" | "SUFFICIENT_FOR_REVIEW";
  verdictReason: string;
}

export interface ProspectiveScoreboard {
  experimentId: string;
  experimentVersion: number;
  mode: string;
  productionBehaviorChanged: false;
  definitionHashAtFreeze: string;
  prospectiveStartDate: string;

  sessionsObserved: number;
  sessions: string[];
  opportunitiesEvaluated: number;

  baselineAdmits: number;
  experimentAdmits: number;
  bothAdmit: number;
  baselineOnly: number;
  experimentOnly: number;
  bothReject: number;

  closedOutcomes: number;
  openOutcomes: number;
  ungradableOutcomes: number;
  unlinkedDecisions: number;

  /** Baseline arm = what the owner actually received. The comparison's denominator. */
  baseline: ArmPerformance;
  /** Experiment arm = what V1 would have admitted, closed outcomes only. */
  experiment: ArmPerformance;
  /** The same experiment arm with its single best trade removed. Always computed. */
  experimentExTopWinner: ArmPerformance;
  /** And with returns capped at +60%. */
  experimentCappedAt60: ArmPerformance;

  /** Baseline winners V1 retained. */
  winnersRetained: TrackedCase[];
  /** Baseline losses V1 rejected — the case FOR the rule. */
  lossesAvoided: TrackedCase[];
  /** Baseline WINNERS V1 rejected — the case AGAINST it. Reported first in any summary. */
  winnersRejected: TrackedCase[];
  /** Winners V1 admitted that the baseline did not deliver. */
  experimentOnlyWinners: TrackedCase[];
  /** Losses V1 admitted that the baseline did not deliver — the cost of recovering. */
  experimentOnlyLosses: TrackedCase[];

  tailDependence: {
    topWinnerReturnPct: number | null;
    topWinnerShareOfGross: number | null;
    profitFactorWithTopWinner: number | null;
    profitFactorWithoutTopWinner: number | null;
    profitFactorCappedAt60: number | null;
    /** True when the arm is only profitable because of one trade. */
    carriedBySingleTrade: boolean | null;
  };

  evidenceQuality: EvidenceQuality;

  /** The sentence a consumer must not replace with a shorter, better-sounding one. */
  honestSummary: string;
  mustNotBeSummarizedAs: string;
}

const MIN_CLOSED_FOR_REVIEW = 20;
const MIN_SESSIONS_FOR_REVIEW = 5;

/**
 * Build the scoreboard.
 *
 * `rows` should be every shadow decision for the experiment, including BOTH_REJECT — the
 * counts are only meaningful against the full population that was evaluated.
 */
export function buildProspectiveScoreboard(
  rows: readonly ShadowDecisionRow[],
  experiment = LHC_SELECT_V1,
): ProspectiveScoreboard {
  const mine = rows.filter(
    (r) => r.experimentId === experiment.experimentId && r.experimentVersion === experiment.experimentVersion,
  );
  const sessions = [...new Set(mine.map((r) => r.sessionDate))].sort();

  const byArm = (a: string) => mine.filter((r) => r.arm === a);
  const bothAdmit = byArm("BOTH_ADMIT");
  const baselineOnly = byArm("BASELINE_ONLY");
  const experimentOnly = byArm("EXPERIMENT_ONLY");
  const bothReject = byArm("BOTH_REJECT");

  // The baseline arm is everything the baseline admitted; the experiment arm is everything V1
  // admitted. They overlap on BOTH_ADMIT, which is the point — one canonical contract, two labels.
  const baselineRows = [...bothAdmit, ...baselineOnly];
  const experimentRows = [...bothAdmit, ...experimentOnly];

  const closedExp = closed(experimentRows);
  const bestExp = closedExp.length
    ? Math.max(...closedExp.filter((r) => r.returnPct! > 0).map((r) => r.returnPct!), Number.NEGATIVE_INFINITY)
    : Number.NEGATIVE_INFINITY;
  const hasTop = Number.isFinite(bestExp);
  // Drop exactly ONE trade at the maximum. Filtering by value would remove every trade tied at
  // the top, which on a flat return distribution deletes the entire winning side and turns this
  // robustness check into a much harsher test than the one it claims to be.
  const exTop = (() => {
    if (!hasTop) return [...experimentRows];
    let dropped = false;
    return experimentRows.filter((r) => {
      if (!dropped && r.returnPct === bestExp) { dropped = true; return false; }
      return true;
    });
  })();

  const experimentPerf = armPerformance(experimentRows);
  const exTopPerf = armPerformance(exTop);
  const cappedPerf = armPerformance(experimentRows, (x) => Math.min(x, 60));

  const isWinner = (r: ShadowDecisionRow) => r.outcomeStatus === "CLOSED" && r.returnPct != null && r.returnPct > 0;
  const isLoss = (r: ShadowDecisionRow) => r.outcomeStatus === "CLOSED" && r.returnPct != null && r.returnPct <= 0;

  const unavailableGateCounts: Record<string, number> = {};
  for (const r of mine) for (const g of r.experimentUnavailable) unavailableGateCounts[g] = (unavailableGateCounts[g] ?? 0) + 1;

  const closedAll = closed(mine);
  const trustworthy = closedAll.filter((r) => (r.sameContractMarks ?? 0) >= MIN_MARKS_FOR_TRAJECTORY).length;

  const verdict: EvidenceQuality["verdict"] =
    closedExp.length >= MIN_CLOSED_FOR_REVIEW && sessions.length >= MIN_SESSIONS_FOR_REVIEW
      ? "SUFFICIENT_FOR_REVIEW"
      : closedExp.length > 0 ? "EMERGING" : "INSUFFICIENT_EVIDENCE";

  const winnersRejected = baselineOnly.filter(isWinner).map(track);
  const lossesAvoided = baselineOnly.filter(isLoss).map(track);
  const winnersRetained = bothAdmit.filter(isWinner).map(track);

  const carriedBySingleTrade =
    experimentPerf.profitFactor == null || exTopPerf.profitFactor == null
      ? null
      : experimentPerf.profitFactor >= 1 && exTopPerf.profitFactor < 1;

  const honestSummary = (() => {
    if (!mine.length) {
      return `${experiment.experimentId} has recorded no prospective decisions yet. ` +
        `Prospective evaluation starts ${experiment.prospectiveStartDate}. Nothing can be claimed.`;
    }
    if (!closedExp.length) {
      return `${experiment.experimentId} has evaluated ${mine.length} opportunities across ` +
        `${sessions.length} session(s) and admitted ${experimentRows.length}, but NO prospective ` +
        `outcome has closed. Expectancy and profit factor are unavailable — not zero, unavailable.`;
    }
    const parts = [
      `${experiment.experimentId}: ${closedExp.length} closed prospective outcome(s) across ${sessions.length} session(s).`,
      `Baseline PF ${fmt(armPerformance(baselineRows).profitFactor)} on ${closed(baselineRows).length} closed;`,
      `experiment PF ${fmt(experimentPerf.profitFactor)} on ${closedExp.length} closed.`,
      `V1 rejected ${winnersRejected.length} baseline winner(s) and avoided ${lossesAvoided.length} baseline loss(es).`,
    ];
    if (carriedBySingleTrade) {
      parts.push(
        `The arm is above break-even ONLY with its best trade included ` +
        `(ex-top-winner PF ${fmt(exTopPerf.profitFactor)}).`,
      );
    }
    if (verdict !== "SUFFICIENT_FOR_REVIEW") {
      parts.push(
        `Sample is ${verdict}: ${closedExp.length}/${MIN_CLOSED_FOR_REVIEW} closed outcomes, ` +
        `${sessions.length}/${MIN_SESSIONS_FOR_REVIEW} sessions. No conclusion is supported yet.`,
      );
    }
    return parts.join(" ");
  })();

  return {
    experimentId: experiment.experimentId,
    experimentVersion: experiment.experimentVersion,
    mode: experiment.mode,
    productionBehaviorChanged: false,
    definitionHashAtFreeze: experiment.definitionHash,
    prospectiveStartDate: experiment.prospectiveStartDate,

    sessionsObserved: sessions.length,
    sessions,
    opportunitiesEvaluated: mine.length,

    baselineAdmits: baselineRows.length,
    experimentAdmits: experimentRows.length,
    bothAdmit: bothAdmit.length,
    baselineOnly: baselineOnly.length,
    experimentOnly: experimentOnly.length,
    bothReject: bothReject.length,

    closedOutcomes: closedAll.length,
    openOutcomes: mine.filter((r) => r.outcomeStatus === "OPEN").length,
    ungradableOutcomes: mine.filter((r) => r.outcomeStatus === "UNGRADABLE").length,
    unlinkedDecisions: mine.filter((r) => r.paperTradeId == null).length,

    baseline: armPerformance(baselineRows),
    experiment: experimentPerf,
    experimentExTopWinner: exTopPerf,
    experimentCappedAt60: cappedPerf,

    winnersRetained,
    lossesAvoided,
    winnersRejected,
    experimentOnlyWinners: experimentOnly.filter(isWinner).map(track),
    experimentOnlyLosses: experimentOnly.filter(isLoss).map(track),

    tailDependence: {
      topWinnerReturnPct: hasTop ? bestExp : null,
      topWinnerShareOfGross: experimentPerf.topWinnerShareOfGross,
      profitFactorWithTopWinner: experimentPerf.profitFactor,
      profitFactorWithoutTopWinner: exTopPerf.profitFactor,
      profitFactorCappedAt60: cappedPerf.profitFactor,
      carriedBySingleTrade,
    },

    evidenceQuality: {
      trajectoryTrustworthy: trustworthy,
      trajectoryUntrustworthy: closedAll.length - trustworthy,
      decisionsWithUnavailableGates: mine.filter((r) => r.experimentUnavailable.length > 0).length,
      unavailableGateCounts,
      verdict,
      verdictReason:
        verdict === "SUFFICIENT_FOR_REVIEW"
          ? `${closedExp.length} closed outcomes over ${sessions.length} sessions meets the review bar.`
          : `Needs >= ${MIN_CLOSED_FOR_REVIEW} closed experiment outcomes over >= ${MIN_SESSIONS_FOR_REVIEW} ` +
            `independent sessions; has ${closedExp.length} over ${sessions.length}.`,
    },

    honestSummary,
    mustNotBeSummarizedAs:
      "LHC_SELECT_V1 works. It is PROMISING and UNVALIDATED. Historically it is below break-even " +
      "without its single convex winner, and prospective evidence is reported above — if no outcome " +
      "has closed, there is no prospective result to report at all.",
  };
}

function fmt(v: number | null): string {
  return v == null ? "n/a" : v.toFixed(3);
}

/**
 * The deterministic verdict for the weekly review. Never returns a promotion — the best
 * available answer is READY_FOR_HUMAN_REVIEW, which is a request.
 */
export type WeeklyVerdict =
  | "INSUFFICIENT_EVIDENCE"
  | "KEEP_TESTING"
  | "PROMISING"
  | "FAILED"
  | "DEMOTE"
  | "READY_FOR_HUMAN_REVIEW";

export function weeklyVerdict(s: ProspectiveScoreboard): { verdict: WeeklyVerdict; reason: string } {
  if (s.evidenceQuality.verdict === "INSUFFICIENT_EVIDENCE") {
    return { verdict: "INSUFFICIENT_EVIDENCE", reason: s.evidenceQuality.verdictReason };
  }
  // A rejected winner is the failure mode this rule was built to avoid. It does not fail the
  // experiment on its own, but it is reported before anything flattering.
  if (s.winnersRejected.length > 0 && s.experiment.profitFactor != null && s.baseline.profitFactor != null
      && s.experiment.profitFactor <= s.baseline.profitFactor) {
    return {
      verdict: "FAILED",
      reason: `V1 rejected ${s.winnersRejected.length} baseline winner(s) and did not improve profit factor ` +
        `(${fmt(s.experiment.profitFactor)} vs baseline ${fmt(s.baseline.profitFactor)}).`,
    };
  }
  if (s.evidenceQuality.verdict === "EMERGING") {
    return {
      verdict: "KEEP_TESTING",
      reason: `${s.experiment.n} closed experiment outcome(s) over ${s.sessionsObserved} session(s) — ` +
        "too few to conclude either way.",
    };
  }
  const pf = s.experiment.profitFactor;
  const pfExTop = s.experimentExTopWinner.profitFactor;
  if (pf == null) return { verdict: "KEEP_TESTING", reason: "no closed experiment outcomes with losses to price a profit factor." };
  if (pf < 1) return { verdict: "DEMOTE", reason: `experiment profit factor ${fmt(pf)} is below break-even on prospective evidence.` };
  if (pfExTop != null && pfExTop < 1) {
    return {
      verdict: "PROMISING",
      reason: `PF ${fmt(pf)} but ${fmt(pfExTop)} without the single best trade — the arm is carried by one ` +
        "convex outcome and is not robust enough to put in front of a human as ready.",
    };
  }
  return {
    verdict: "READY_FOR_HUMAN_REVIEW",
    reason: `PF ${fmt(pf)} and ${fmt(pfExTop)} ex-top-winner over ${s.sessionsObserved} sessions with ` +
      `${s.winnersRejected.length} winner(s) rejected. A human is being asked to look; this is not approval.`,
  };
}
