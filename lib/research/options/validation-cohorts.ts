/**
 * Controlled validation cohorts.
 *
 * WHY THIS SHAPE
 *
 * The temptation with a change like "0DTE discovery now works" is to point at the SPY
 * +203% contract and call it validated. That is exactly the failure this module is built
 * to prevent: a cohort result is only reported as an improvement when it repeats across
 * INDEPENDENT sessions, and every cohort carries an explicit hindsight-leakage fence.
 *
 * PURE. No I/O. Callers supply the per-session results; this computes the comparison.
 */

export type CohortId =
  | "A_PRODUCTION"
  | "B_ZERO_DTE_DISCOVERY"
  | "C_STRATEGY_SELECTION"
  | "D_CONTRACT_RANKING"
  | "E_OPPORTUNITY_RANKING"
  | "F_COMBINED";

export type CohortMethod =
  | "HISTORICAL_REPLAY"
  | "OUT_OF_SAMPLE_REPLAY"
  | "SHADOW"
  | "DETERMINISTIC_PAPER"
  | "FORWARD";

/**
 * The fence that makes a replay honest.
 *
 * Every field pins something that, left floating, would let information from after the
 * decision leak backwards. A cohort without a complete fence is reported as
 * LEAKAGE_RISK rather than as a result.
 */
export interface LeakageFence {
  /** The instant the decision was made. Nothing after it may be read. */
  eligibilityAtMs: number | null;
  /** Hard cutoff applied to every data source. */
  dataCutoffMs: number | null;
  /** The chain as it existed then, not as it exists now. */
  chainSnapshotId: string | null;
  /** Option quotes as of the cutoff. */
  quoteSnapshotId: string | null;
  /** Provider budget state at the time (a replay that ignores exhaustion is fiction). */
  providerStateId: string | null;
  strategyVersion: string | null;
  rankingVersion: string | null;
}

export function fenceIsComplete(f: LeakageFence): boolean {
  return f.eligibilityAtMs != null
    && f.dataCutoffMs != null
    && f.chainSnapshotId != null
    && f.quoteSnapshotId != null
    && f.providerStateId != null
    && f.strategyVersion != null
    && f.rankingVersion != null;
}

export function missingFenceFields(f: LeakageFence): string[] {
  const missing: string[] = [];
  if (f.eligibilityAtMs == null) missing.push("eligibilityAtMs");
  if (f.dataCutoffMs == null) missing.push("dataCutoffMs");
  if (f.chainSnapshotId == null) missing.push("chainSnapshotId");
  if (f.quoteSnapshotId == null) missing.push("quoteSnapshotId");
  if (f.providerStateId == null) missing.push("providerStateId");
  if (f.strategyVersion == null) missing.push("strategyVersion");
  if (f.rankingVersion == null) missing.push("rankingVersion");
  return missing;
}

export interface CohortSessionResult {
  cohortId: CohortId;
  method: CohortMethod;
  sessionDate: string;
  fence: LeakageFence;

  candidatesDetected: number | null;
  alertsOrPaperEntries: number | null;
  verifiedWinnersRecovered: number | null;
  falsePositivesIntroduced: number | null;
  falseNegativesReduced: number | null;
  correctRejectionsPreserved: number | null;

  precision: number | null;
  recall: number | null;
  medianReturnPct: number | null;
  expectancyPct: number | null;
  profitFactor: number | null;
  medianMfePct: number | null;
  medianMaePct: number | null;
  immediateFailureRate: number | null;
  medianAlertLatencyMs: number | null;
  medianPremiumExpansionPct: number | null;

  providerRequests: number | null;
  providerBudgetRefusals: number | null;
  evidenceCompleteness: number | null;
}

export type CohortVerdict =
  | "IMPROVED_REPEATEDLY"
  | "IMPROVED_ONCE_NOT_REPEATED"
  | "NO_MATERIAL_CHANGE"
  | "REGRESSED"
  | "LEAKAGE_RISK"
  | "INSUFFICIENT_SESSIONS";

export interface CohortComparison {
  cohortId: CohortId;
  baselineCohortId: CohortId;
  sessionsCompared: string[];
  sessionsImproved: string[];
  sessionsRegressed: string[];
  verdict: CohortVerdict;
  rationale: string;
  leakageRisk: { sessionDate: string; missing: string[] }[];
  deltas: {
    expectancyPct: number | null;
    profitFactor: number | null;
    immediateFailureRate: number | null;
    verifiedWinnersRecovered: number | null;
    falsePositivesIntroduced: number | null;
    providerRequests: number | null;
  };
}

/** Repetition bar: an improvement in a single session is an anecdote. */
export const MIN_INDEPENDENT_SESSIONS = 3;

const d = (a: number | null, b: number | null): number | null =>
  a == null || b == null ? null : +(a - b).toFixed(6);

const mean = (xs: (number | null)[]): number | null => {
  const v = xs.filter((x): x is number => x != null && Number.isFinite(x));
  return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(6) : null;
};

/**
 * Did the cohort beat the baseline in this session?
 *
 * Improvement requires expectancy up AND immediate-failure not worse. A cohort that lifts
 * expectancy purely by adding a few huge winners while degrading the typical alert is not
 * an improvement — that is the exact shape of "optimise for the +203% contract".
 */
type SessionVerdict = "improved" | "regressed" | "neutral" | "unknown";

function improvedInSession(c: CohortSessionResult, base: CohortSessionResult): SessionVerdict {
  if (c.expectancyPct == null || base.expectancyPct == null) return "unknown";
  const expUp = c.expectancyPct > base.expectancyPct;
  const expDown = c.expectancyPct < base.expectancyPct;
  const failWorse = c.immediateFailureRate != null && base.immediateFailureRate != null
    && c.immediateFailureRate > base.immediateFailureRate + 1e-9;

  // Improvement needs BOTH: more expectancy and no worse typical alert. Expectancy bought
  // by a few huge winners while the median alert degrades is the "+203% contract" failure
  // mode and is deliberately not counted as an improvement.
  if (expUp && !failWorse) return "improved";
  // Regression means it actually got WORSE — lower expectancy, or a worse failure rate.
  // "Did not improve" is NOT the same as "regressed", and conflating them would let a
  // neutral change be reported as damage.
  if (expDown || failWorse) return "regressed";
  return "neutral";
}

export function compareCohorts(
  cohort: CohortSessionResult[],
  baseline: CohortSessionResult[],
): CohortComparison {
  const cohortId = cohort[0]?.cohortId ?? "F_COMBINED";
  const baselineCohortId = baseline[0]?.cohortId ?? "A_PRODUCTION";
  const baseBySession = new Map(baseline.map((b) => [b.sessionDate, b]));

  const paired = cohort
    .map((c) => ({ c, b: baseBySession.get(c.sessionDate) }))
    .filter((p): p is { c: CohortSessionResult; b: CohortSessionResult } => Boolean(p.b));

  const leakageRisk = paired
    .map(({ c }) => ({ sessionDate: c.sessionDate, missing: missingFenceFields(c.fence) }))
    .filter((x) => x.missing.length);

  const sessionsCompared = paired.map((p) => p.c.sessionDate).sort();
  const sessionsImproved: string[] = [];
  const sessionsRegressed: string[] = [];
  for (const { c, b } of paired) {
    const imp = improvedInSession(c, b);
    if (imp === "improved") sessionsImproved.push(c.sessionDate);
    else if (imp === "regressed") sessionsRegressed.push(c.sessionDate);
  }

  const deltas = {
    expectancyPct: d(mean(cohort.map((x) => x.expectancyPct)), mean(baseline.map((x) => x.expectancyPct))),
    profitFactor: d(mean(cohort.map((x) => x.profitFactor)), mean(baseline.map((x) => x.profitFactor))),
    immediateFailureRate: d(mean(cohort.map((x) => x.immediateFailureRate)), mean(baseline.map((x) => x.immediateFailureRate))),
    verifiedWinnersRecovered: d(mean(cohort.map((x) => x.verifiedWinnersRecovered)), mean(baseline.map((x) => x.verifiedWinnersRecovered))),
    falsePositivesIntroduced: d(mean(cohort.map((x) => x.falsePositivesIntroduced)), mean(baseline.map((x) => x.falsePositivesIntroduced))),
    providerRequests: d(mean(cohort.map((x) => x.providerRequests)), mean(baseline.map((x) => x.providerRequests))),
  };

  // A leaky replay is not evidence, however good the numbers look.
  if (leakageRisk.length) {
    return {
      cohortId, baselineCohortId, sessionsCompared, sessionsImproved, sessionsRegressed,
      verdict: "LEAKAGE_RISK",
      rationale: `${leakageRisk.length} session(s) have an incomplete hindsight fence: ${leakageRisk.map((l) => `${l.sessionDate}[${l.missing.join(",")}]`).join("; ")}`,
      leakageRisk, deltas,
    };
  }
  if (sessionsCompared.length < MIN_INDEPENDENT_SESSIONS) {
    return {
      cohortId, baselineCohortId, sessionsCompared, sessionsImproved, sessionsRegressed,
      verdict: "INSUFFICIENT_SESSIONS",
      rationale: `${sessionsCompared.length} paired session(s) < ${MIN_INDEPENDENT_SESSIONS} required for a repeated result`,
      leakageRisk, deltas,
    };
  }
  if (sessionsRegressed.length > sessionsImproved.length) {
    return {
      cohortId, baselineCohortId, sessionsCompared, sessionsImproved, sessionsRegressed,
      verdict: "REGRESSED",
      rationale: `regressed in ${sessionsRegressed.length} of ${sessionsCompared.length} sessions`,
      leakageRisk, deltas,
    };
  }
  if (sessionsImproved.length >= MIN_INDEPENDENT_SESSIONS) {
    return {
      cohortId, baselineCohortId, sessionsCompared, sessionsImproved, sessionsRegressed,
      verdict: "IMPROVED_REPEATEDLY",
      rationale: `improved in ${sessionsImproved.length} independent sessions (${sessionsImproved.join(", ")})`,
      leakageRisk, deltas,
    };
  }
  if (sessionsImproved.length > 0) {
    return {
      cohortId, baselineCohortId, sessionsCompared, sessionsImproved, sessionsRegressed,
      verdict: "IMPROVED_ONCE_NOT_REPEATED",
      rationale: `improved in only ${sessionsImproved.length} of ${sessionsCompared.length} sessions — not a repeated result`,
      leakageRisk, deltas,
    };
  }
  return {
    cohortId, baselineCohortId, sessionsCompared, sessionsImproved, sessionsRegressed,
    verdict: "NO_MATERIAL_CHANGE",
    rationale: "no session showed improvement on expectancy without worsening immediate failure",
    leakageRisk, deltas,
  };
}
