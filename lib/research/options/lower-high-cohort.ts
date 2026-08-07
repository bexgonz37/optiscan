/**
 * The frozen `lower_high_continuation` audit cohort.
 *
 * WHY THIS EXISTS
 *
 * Every previous measurement of this lane moved underneath the conclusion drawn from it —
 * "the recent 35" became 45 became 54 as sessions accumulated, and each packet quoted a
 * different denominator. A finding you cannot re-run against the same rows is not evidence.
 *
 * So membership is defined once, by rule, and versioned. `LHC_DELIVERED_V1` is: every
 * `options_paper_trades` row with `paper_kind='DELIVERED_ALERT_PAPER'` and
 * `strategy='lower_high_continuation'` — i.e. the exact mirrors of owner Discord openings,
 * nothing shadow, nothing research-only. Adding sessions extends the cohort; it never
 * reclassifies a row already in it, because the grade of a closed trade cannot change.
 *
 * Excursion trust is separate from membership. A row with one same-contract mark is a member
 * and is UNGRADABLE for anything path-shaped. Realized return survives on a single mark;
 * MFE, MAE and "never worked" do not.
 *
 * PURE. No I/O, no clock, no env.
 */

import {
  extractPreEntryFeatures, easternSessionDate,
  type PreEntryFeatures, type PreEntrySource,
} from "./pre-entry-features.ts";

export const COHORT_ID = "LHC_DELIVERED_V1";
export const COHORT_STRATEGY = "lower_high_continuation";
export const COHORT_PAPER_KIND = "DELIVERED_ALERT_PAPER";

/**
 * Minimum same-contract marks before a trajectory claim (peak, "never worked") is allowed.
 * Matches the excursion threshold already used by mark-evidence: an excursion is a statement
 * about a path, and a handful of points is not a path.
 */
export const MIN_MARKS_FOR_TRAJECTORY = 20;

export type CohortOutcome = "WINNER" | "LOSS" | "OPEN" | "UNGRADABLE";

export interface CohortRowSource extends PreEntrySource {
  paperTradeId: number;
  alertId: string | null;
  opportunityCaseId: string | null;
  discordMessageId: string | null;
  symbol: string | null;
  optionSymbol: string;
  side: string | null;
  expiration: string | null;
  status: string;
  exitReason: string | null;
  exitAtMs: number | null;
  returnPct: number | null;
  /** Same-contract marks only — marks on a re-selected OCC are a different instrument. */
  sameContractMarks: number;
  peakPct: number | null;
  troughPct: number | null;
  msToPct: { p5: number | null; p10: number | null; p25: number | null; p50: number | null; p100: number | null };
  strategyVersion: string | null;
  exitPolicyVersion: string | null;
  deploymentSha: string | null;
}

export interface CohortRow {
  cohortId: string;
  paperTradeId: number;
  alertId: string | null;
  opportunityCaseId: string | null;
  discordMessageId: string | null;
  symbol: string | null;
  optionSymbol: string;
  side: string | null;
  expiration: string | null;
  sessionDate: string;
  enteredAtMs: number;
  exitAtMs: number | null;
  entryFill: number | null;
  returnPct: number | null;
  outcome: CohortOutcome;
  exitReason: string | null;
  sameContractMarks: number;
  /** True when the cohort is allowed to make path-shaped claims about this row. */
  trajectoryTrustworthy: boolean;
  peakPct: number | null;
  troughPct: number | null;
  msToPct: CohortRowSource["msToPct"];
  /** Peak < +5% on a trustworthy path: no exit policy could have rescued it after entry. */
  neverWorked: boolean | null;
  features: PreEntryFeatures;
  strategyVersion: string;
  exitPolicyVersion: string;
  deploymentSha: string;
}

/** Attribution we genuinely do not have for historical rows. Never invented. */
export const UNKNOWN_LEGACY_VERSION = "UNKNOWN_LEGACY_VERSION";

export interface Cohort {
  cohortId: string;
  strategy: string;
  paperKind: string;
  builtFromRows: number;
  rows: CohortRow[];
  sessions: string[];
  counts: Record<CohortOutcome, number>;
}

export function buildCohort(sources: readonly CohortRowSource[]): Cohort {
  const ordered = [...sources].sort((a, b) => a.enteredAtMs - b.enteredAtMs);

  const rows: CohortRow[] = ordered.map((s) => {
    const trajectoryTrustworthy = s.sameContractMarks >= MIN_MARKS_FOR_TRAJECTORY;
    const closed = s.status === "EXITED" && s.returnPct != null;

    // A closed row is graded on realized return, which one mark supports. UNGRADABLE is
    // reserved for rows that closed without a usable return at all.
    const outcome: CohortOutcome = !closed
      ? (s.status === "EXITED" ? "UNGRADABLE" : "OPEN")
      : s.returnPct! > 0 ? "WINNER" : "LOSS";

    return {
      cohortId: COHORT_ID,
      paperTradeId: s.paperTradeId,
      alertId: s.alertId,
      opportunityCaseId: s.opportunityCaseId,
      discordMessageId: s.discordMessageId,
      symbol: s.symbol,
      optionSymbol: s.optionSymbol,
      side: s.side,
      expiration: s.expiration,
      sessionDate: easternSessionDate(s.enteredAtMs),
      enteredAtMs: s.enteredAtMs,
      exitAtMs: s.exitAtMs,
      entryFill: s.entryFill,
      returnPct: s.returnPct,
      outcome,
      exitReason: s.exitReason,
      sameContractMarks: s.sameContractMarks,
      trajectoryTrustworthy,
      peakPct: trajectoryTrustworthy ? s.peakPct : null,
      troughPct: trajectoryTrustworthy ? s.troughPct : null,
      msToPct: s.msToPct,
      neverWorked: trajectoryTrustworthy && s.peakPct != null ? s.peakPct < 5 : null,
      features: extractPreEntryFeatures(s),
      strategyVersion: s.strategyVersion ?? UNKNOWN_LEGACY_VERSION,
      exitPolicyVersion: s.exitPolicyVersion ?? UNKNOWN_LEGACY_VERSION,
      deploymentSha: s.deploymentSha ?? UNKNOWN_LEGACY_VERSION,
    };
  });

  // Crowding features need the whole session in view, so they are assigned after ordering.
  const perSession = new Map<string, number>();
  for (const r of rows) {
    const n = (perSession.get(r.sessionDate) ?? 0) + 1;
    perSession.set(r.sessionDate, n);
    r.features.sessionAlertOrdinal = n;
    r.features.concurrentOpen = rows.filter(
      (o) => o.paperTradeId !== r.paperTradeId &&
        o.enteredAtMs <= r.enteredAtMs &&
        (o.exitAtMs == null || o.exitAtMs > r.enteredAtMs),
    ).length;
  }

  const counts: Record<CohortOutcome, number> = { WINNER: 0, LOSS: 0, OPEN: 0, UNGRADABLE: 0 };
  for (const r of rows) counts[r.outcome]++;

  return {
    cohortId: COHORT_ID,
    strategy: COHORT_STRATEGY,
    paperKind: COHORT_PAPER_KIND,
    builtFromRows: sources.length,
    rows,
    sessions: [...new Set(rows.map((r) => r.sessionDate))].sort(),
    counts,
  };
}

/** Closed members only — the population any performance statement must be made over. */
export function closedRows(cohort: Cohort): CohortRow[] {
  return cohort.rows.filter((r) => r.outcome === "WINNER" || r.outcome === "LOSS");
}

export interface PerformanceStats {
  n: number; winners: number; losses: number; winRate: number | null;
  meanReturnPct: number | null; medianReturnPct: number | null;
  profitFactor: number | null; avgWinnerPct: number | null; avgLoserPct: number | null;
  largestWinnerPct: number | null; largestLoserPct: number | null;
  /** Sum of winner returns contributed by the single best trade. Convexity is load-bearing here. */
  topWinnerShareOfGross: number | null;
}

export function performance(rows: readonly CohortRow[]): PerformanceStats {
  const closed = rows.filter((r) => r.returnPct != null);
  if (!closed.length) {
    return {
      n: 0, winners: 0, losses: 0, winRate: null, meanReturnPct: null, medianReturnPct: null,
      profitFactor: null, avgWinnerPct: null, avgLoserPct: null,
      largestWinnerPct: null, largestLoserPct: null, topWinnerShareOfGross: null,
    };
  }
  const w = closed.filter((r) => r.returnPct! > 0);
  const l = closed.filter((r) => r.returnPct! <= 0);
  const gross = w.reduce((s, r) => s + r.returnPct!, 0);
  const lossSum = -l.reduce((s, r) => s + r.returnPct!, 0);
  const sorted = closed.map((r) => r.returnPct!).sort((a, b) => a - b);
  const median = sorted.length % 2
    ? sorted[sorted.length >> 1]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const best = w.length ? Math.max(...w.map((r) => r.returnPct!)) : null;
  return {
    n: closed.length, winners: w.length, losses: l.length,
    winRate: closed.length ? w.length / closed.length : null,
    meanReturnPct: closed.reduce((s, r) => s + r.returnPct!, 0) / closed.length,
    medianReturnPct: median,
    profitFactor: lossSum > 0 ? gross / lossSum : null,
    avgWinnerPct: w.length ? gross / w.length : null,
    avgLoserPct: l.length ? -lossSum / l.length : null,
    largestWinnerPct: best,
    largestLoserPct: l.length ? Math.min(...l.map((r) => r.returnPct!)) : null,
    topWinnerShareOfGross: gross > 0 && best != null ? best / gross : null,
  };
}

/**
 * Deterministic primary failure cause. Assigned only where the evidence supports it —
 * a row without a trustworthy path gets INSUFFICIENT_EVIDENCE rather than a guess, because
 * "never worked" and "gave profit back" are indistinguishable on a single mark.
 */
export type FailureCause =
  | "INSUFFICIENT_EVIDENCE"
  | "CONTRACT_TOO_FAR_OTM"
  | "PREMIUM_CHASE"
  | "WIDE_SPREAD"
  | "WRONG_DTE"
  | "LOW_LIQUIDITY"
  | "IMMEDIATE_SETUP_FAILURE"
  | "WORKED_MARGINALLY_THEN_LOST"
  | "PROFIT_GIVEN_BACK";

export function classifyLoss(r: CohortRow): { cause: FailureCause; workedFirst: boolean | null } {
  if (!r.trajectoryTrustworthy || r.peakPct == null) {
    return { cause: "INSUFFICIENT_EVIDENCE", workedFirst: null };
  }
  const f = r.features;
  if (r.peakPct < 5) {
    // Never cleared +5%: no post-entry policy could have saved it, so the cause must be a
    // pre-entry property. Contract-fit first, because that is what the evidence separates on.
    const farOtm = f.moneynessPct != null && f.moneynessPct < -0.5;
    const richIv = f.iv != null && f.iv > 0.55;
    if (farOtm) return { cause: "CONTRACT_TOO_FAR_OTM", workedFirst: false };
    if (richIv) return { cause: "PREMIUM_CHASE", workedFirst: false };
    if (f.spreadPct != null && f.spreadPct > 5) return { cause: "WIDE_SPREAD", workedFirst: false };
    if (f.dte != null && f.dte > 3) return { cause: "WRONG_DTE", workedFirst: false };
    if (f.dollarVolume != null && f.dollarVolume < 4e9) return { cause: "LOW_LIQUIDITY", workedFirst: false };
    return { cause: "IMMEDIATE_SETUP_FAILURE", workedFirst: false };
  }
  if (r.peakPct >= 20) return { cause: "PROFIT_GIVEN_BACK", workedFirst: true };
  return { cause: "WORKED_MARGINALLY_THEN_LOST", workedFirst: true };
}
