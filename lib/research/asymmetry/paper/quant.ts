/**
 * quant.ts — the deterministic Quant layer. PURE. No db, no clock, no AI.
 *
 * Everything here is arithmetic over rows that already exist. Given the same
 * positions, cases, and skips it returns the same report, so any number in a
 * review can be re-derived months later from the stored rows alone.
 *
 * FOUR RULES THAT SHAPE EVERY FUNCTION BELOW:
 *
 *  1. AN EMPTY COHORT HAS AN UNKNOWN RATE, NOT A ZERO RATE. Every rate is
 *     `number | null` and null is returned whenever the denominator is empty.
 *     A 0% win rate and "no trades yet" are different claims and must never
 *     render identically.
 *  2. AN UNVERIFIED OUTCOME IS NOT A LOSS. Positions without a verified exit
 *     are excluded from every return statistic and counted separately in
 *     `missingDataRate`. Treating them as zero would manufacture losers.
 *  3. NO CAUSAL CLAIMS. Evidence association reports differences between
 *     groups. It never says an attribute caused a result, and the field is
 *     named `association`, not `effect`.
 *  4. VERSIONS ARE NEVER MIXED. Every cohort carries its rules version and
 *     positions from different versions are reported separately.
 */
import { PAPER_RULES_VERSION } from "./lane.ts";
import { milestoneDistribution, PAPER_MILESTONES } from "./management.ts";
import type { PaperPositionRecord, PaperSkipRow } from "./store.ts";

/** Below this, a rate is reported but flagged as unable to support a conclusion. */
export const MIN_COHORT_SAMPLE = 10;
/** Below this, an evidence association is not reported at all. */
export const MIN_ASSOCIATION_SAMPLE = 5;
/** Fraction of a cohort, chronologically, held out of the in-sample view. */
export const HOLDOUT_FRACTION = 0.3;

export interface CohortMetrics {
  cohort: string;
  rulesVersion: string;
  count: number;
  /** Positions with a VERIFIED exit — the only ones any return statistic uses. */
  gradeableCount: number;
  winRatePct: number | null;
  /** Wilson score interval on the win rate. Null when the cohort is empty. */
  winRateCi95: { lowPct: number; highPct: number } | null;
  medianReturnPct: number | null;
  averageReturnPct: number | null;
  returnDistribution: Array<{ bucket: string; n: number }>;
  medianMfePct: number | null;
  medianMaePct: number | null;
  profitFactor: number | null;
  expectancyPct: number | null;
  medianHoldMs: number | null;
  milestones: Record<string, number>;
  stopFrequencyPct: number | null;
  invalidationFrequencyPct: number | null;
  sessionEndFrequencyPct: number | null;
  /** Verified exits that finished at or below zero after reaching no milestone. */
  falsePositiveRatePct: number | null;
  /** Share of the cohort with no verified exit. Data quality, not performance. */
  missingDataRatePct: number | null;
  totalPnlOneContractUsd: number | null;
  totalPnlSizedUsd: number | null;
  largestWinnerPct: number | null;
  largestLoserPct: number | null;
  minimumSampleWarning: string | null;
}

const RETURN_BUCKETS: Array<{ bucket: string; lo: number; hi: number }> = [
  { bucket: "<= -50%", lo: -Infinity, hi: -50 },
  { bucket: "-50% to -25%", lo: -50, hi: -25 },
  { bucket: "-25% to 0%", lo: -25, hi: 0 },
  { bucket: "0% to +25%", lo: 0, hi: 25 },
  { bucket: "+25% to +50%", lo: 25, hi: 50 },
  { bucket: "+50% to +100%", lo: 50, hi: 100 },
  { bucket: "+100% to +200%", lo: 100, hi: 200 },
  { bucket: "> +200%", lo: 200, hi: Infinity },
];

/**
 * Metrics for one cohort of paper positions.
 *
 * `count` is the whole cohort; every RETURN statistic uses only the verified
 * subset. The two denominators are deliberately different and both are
 * reported, so a cohort that is large but ungradeable cannot masquerade as a
 * confident result.
 */
export function computeCohortMetrics(
  cohort: string,
  positions: PaperPositionRecord[],
  rulesVersion: string = PAPER_RULES_VERSION,
): CohortMetrics {
  const count = positions.length;
  const graded = positions.filter((p) => p.outcomeState === "VERIFIED" && p.finalReturnPct != null);
  const returns = graded.map((p) => p.finalReturnPct as number);
  const n = graded.length;

  const wins = returns.filter((r) => r > 0);
  const losses = returns.filter((r) => r < 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));

  const holds = graded
    .map((p) => (p.exitAtMs != null ? p.exitAtMs - p.entryAtMs : null))
    .filter((v): v is number => v != null);

  const dist = RETURN_BUCKETS.map(({ bucket, lo, hi }) => ({
    bucket,
    n: returns.filter((r) => r > lo && r <= hi).length,
  }));

  const stopped = graded.filter((p) => String(p.exitReason ?? "").startsWith("PREMIUM_STOP")).length;
  const invalidated = graded.filter((p) => String(p.exitReason ?? "").startsWith("UNDERLYING_INVALIDATION")).length;
  const sessionEnded = graded.filter((p) => String(p.exitReason ?? "").startsWith("SESSION_END")).length;
  const falsePositives = graded.filter((p) => (p.finalReturnPct ?? 0) <= 0 && p.highestMilestone == null).length;
  const unverified = positions.filter((p) => p.outcomeState !== "VERIFIED").length;

  const pnl1 = graded.map((p) => p.pnlOneContractUsd).filter((v): v is number => v != null);
  const pnlSized = graded.map((p) => p.pnlSizedUsd).filter((v): v is number => v != null);

  return {
    cohort,
    rulesVersion,
    count,
    gradeableCount: n,
    winRatePct: n ? round1((wins.length / n) * 100) : null,
    winRateCi95: n ? wilson95(wins.length, n) : null,
    medianReturnPct: median(returns),
    averageReturnPct: n ? round2(returns.reduce((a, b) => a + b, 0) / n) : null,
    returnDistribution: dist,
    medianMfePct: median(graded.map((p) => p.mfePct).filter((v): v is number => v != null)),
    medianMaePct: median(graded.map((p) => p.maePct).filter((v): v is number => v != null)),
    // An undefined profit factor (no losses at all) is null, not Infinity.
    profitFactor: n && grossLoss > 0 ? round2(grossWin / grossLoss) : null,
    expectancyPct: n ? round2(returns.reduce((a, b) => a + b, 0) / n) : null,
    medianHoldMs: median(holds),
    milestones: milestoneDistribution(graded.map((p) => p.mfePct)),
    stopFrequencyPct: n ? round1((stopped / n) * 100) : null,
    invalidationFrequencyPct: n ? round1((invalidated / n) * 100) : null,
    sessionEndFrequencyPct: n ? round1((sessionEnded / n) * 100) : null,
    falsePositiveRatePct: n ? round1((falsePositives / n) * 100) : null,
    missingDataRatePct: count ? round1((unverified / count) * 100) : null,
    totalPnlOneContractUsd: pnl1.length ? round2(pnl1.reduce((a, b) => a + b, 0)) : null,
    totalPnlSizedUsd: pnlSized.length ? round2(pnlSized.reduce((a, b) => a + b, 0)) : null,
    largestWinnerPct: returns.length ? round2(Math.max(...returns)) : null,
    largestLoserPct: returns.length ? round2(Math.min(...returns)) : null,
    minimumSampleWarning: n < MIN_COHORT_SAMPLE
      ? `${n} graded outcome(s); below the ${MIN_COHORT_SAMPLE}-sample minimum. No rate here supports a conclusion.`
      : null,
  };
}

/**
 * Wilson score interval — chosen over the normal approximation because at the
 * sample sizes this lane will actually see (often under 20) the normal interval
 * is badly wrong and can extend past 0% or 100%.
 */
export function wilson95(successes: number, n: number): { lowPct: number; highPct: number } | null {
  if (n <= 0) return null;
  const z = 1.96;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    lowPct: round1((Math.max(0, (centre - margin) / denom)) * 100),
    highPct: round1((Math.min(1, (centre + margin) / denom)) * 100),
  };
}

export interface EvidenceAssociation {
  attribute: string;
  /** The two groups compared. Never framed as cause and effect. */
  groupA: { label: string; n: number; medianReturnPct: number | null; medianMfePct: number | null; medianMaePct: number | null; winRatePct: number | null };
  groupB: { label: string; n: number; medianReturnPct: number | null; medianMfePct: number | null; medianMaePct: number | null; winRatePct: number | null };
  /** Difference in median return, A − B. Null when either group is too small. */
  medianReturnDifferencePct: number | null;
  sufficientSample: boolean;
  note: string;
}

/**
 * Split a graded cohort on one attribute and report both halves.
 *
 * This is ASSOCIATION ONLY. Two groups differing does not mean the attribute
 * produced the difference — sample size, time of day, and the market itself are
 * all uncontrolled here, and with cohorts this small a difference of any size
 * is routinely noise.
 */
export function associateEvidence(
  attribute: string,
  positions: PaperPositionRecord[],
  predicate: (p: PaperPositionRecord) => boolean | null,
  labels: { a: string; b: string },
): EvidenceAssociation {
  const graded = positions.filter((p) => p.outcomeState === "VERIFIED" && p.finalReturnPct != null);
  const a: PaperPositionRecord[] = [];
  const b: PaperPositionRecord[] = [];
  for (const p of graded) {
    const verdict = predicate(p);
    if (verdict === true) a.push(p);
    else if (verdict === false) b.push(p);
    // null = the attribute is unknown for this position; it joins neither group.
  }
  const side = (label: string, rows: PaperPositionRecord[]) => {
    const rs = rows.map((p) => p.finalReturnPct as number);
    return {
      label,
      n: rows.length,
      medianReturnPct: median(rs),
      medianMfePct: median(rows.map((p) => p.mfePct).filter((v): v is number => v != null)),
      medianMaePct: median(rows.map((p) => p.maePct).filter((v): v is number => v != null)),
      winRatePct: rs.length ? round1((rs.filter((r) => r > 0).length / rs.length) * 100) : null,
    };
  };
  const groupA = side(labels.a, a);
  const groupB = side(labels.b, b);
  const sufficient = a.length >= MIN_ASSOCIATION_SAMPLE && b.length >= MIN_ASSOCIATION_SAMPLE;
  return {
    attribute,
    groupA, groupB,
    medianReturnDifferencePct: sufficient && groupA.medianReturnPct != null && groupB.medianReturnPct != null
      ? round2(groupA.medianReturnPct - groupB.medianReturnPct)
      : null,
    sufficientSample: sufficient,
    note: sufficient
      ? "Association only. Not a causal claim and not controlled for time of day, symbol, or market regime."
      : `Not reported: both groups need ${MIN_ASSOCIATION_SAMPLE}+ graded outcomes (have ${a.length} and ${b.length}).`,
  };
}

export interface QuantProposal {
  id: string;
  observation: string;
  proposedExperiment: string;
  evidenceWindow: string;
  sampleSize: number;
  supportingMetrics: Record<string, number | string | null>;
  uncertainty: string;
  /** Quant may PROPOSE. It may never activate. Both are always false here. */
  approvalStatus: "PROPOSED";
  implementationStatus: "NOT_IMPLEMENTED";
}

export interface HoldoutSplit {
  inSample: CohortMetrics;
  holdout: CohortMetrics;
  /** True only when BOTH halves independently clear the minimum sample. */
  evaluable: boolean;
  note: string;
}

/**
 * Chronological holdout: earliest positions in-sample, latest held out. Time
 * order rather than a random split, because a random split would leak later
 * market conditions into the in-sample half and make the holdout meaningless.
 */
export function holdoutSplit(positions: PaperPositionRecord[], rulesVersion: string = PAPER_RULES_VERSION): HoldoutSplit {
  const sorted = positions.slice().sort((a, b) => a.entryAtMs - b.entryAtMs);
  const cut = Math.floor(sorted.length * (1 - HOLDOUT_FRACTION));
  const inSample = computeCohortMetrics("IN_SAMPLE", sorted.slice(0, cut), rulesVersion);
  const holdout = computeCohortMetrics("HOLDOUT", sorted.slice(cut), rulesVersion);
  const evaluable = inSample.gradeableCount >= MIN_COHORT_SAMPLE && holdout.gradeableCount >= MIN_COHORT_SAMPLE;
  return {
    inSample, holdout, evaluable,
    note: evaluable
      ? "Both halves clear the minimum sample; the holdout is a usable check."
      : `Not evaluable: in-sample ${inSample.gradeableCount} and holdout ${holdout.gradeableCount} graded, each needs ${MIN_COHORT_SAMPLE}.`,
  };
}

export interface QuantReport {
  sessionDate: string;
  builtAtMs: number;
  rulesVersion: string;
  /** Versions actually present in the data. More than one means DO NOT POOL. */
  rulesVersionsPresent: string[];
  versionMixWarning: string | null;
  cohorts: CohortMetrics[];
  candidateFunnel: {
    captured: number;
    paperEntered: number;
    paperSkipped: number;
    skipReasons: Array<{ reason: string; count: number }>;
    openPositions: number;
    closedPositions: number;
    unverifiedOutcomes: number;
  };
  evidenceAssociations: EvidenceAssociation[];
  holdout: HoldoutSplit;
  leadTime: { measured: number; medianMs: number | null };
  premiumAvoided: { measured: number; medianPct: number | null };
  bestMissedOpportunity: { fingerprint: string; symbol: string; mfePct: number; reason: string } | null;
  proposals: QuantProposal[];
  /** Structural guarantees, executable rather than merely documented. */
  aiInvolved: false;
  advisoryOnly: true;
  productionBehaviorChanged: false;
}

export interface QuantInput {
  sessionDate: string;
  nowMs: number;
  positions: PaperPositionRecord[];
  skips: PaperSkipRow[];
  cases: Array<{
    fingerprint: string; symbol: string; state: string;
    leadMs: number | null; premiumAvoidedPct: number | null; missingEvidence: string[];
  }>;
  /** Best MFE among captured cases that never became a paper position. */
  ungradedCaseOutcomes?: Array<{ fingerprint: string; symbol: string; mfePct: number | null }>;
  rulesVersion?: string;
}

/** Build the whole deterministic report. Pure. */
export function buildQuantReport(input: QuantInput): QuantReport {
  const rulesVersion = input.rulesVersion ?? PAPER_RULES_VERSION;
  const positions = input.positions;
  const versions = [...new Set(positions.map((p) => p.rulesVersion))].sort();

  // Only positions on THIS version feed the headline cohorts. Pooling across a
  // rule change would attribute one rule set's results to another.
  const current = positions.filter((p) => p.rulesVersion === rulesVersion);
  const entered = new Set(current.map((p) => p.caseFingerprint));

  const byState = (state: string) => current.filter((p) => p.stateAtEntry === state);
  const cohorts: CohortMetrics[] = [
    computeCohortMetrics("ALL_PAPER_ENTERED", current, rulesVersion),
    computeCohortMetrics("ENTERED_EARLY_ASYMMETRY", byState("EARLY_ASYMMETRY"), rulesVersion),
    computeCohortMetrics("ENTERED_CONFIRMING", byState("CONFIRMING"), rulesVersion),
    computeCohortMetrics("ENTERED_HIGH_ASYMMETRY", byState("HIGH_ASYMMETRY"), rulesVersion),
    computeCohortMetrics("LINKED_TO_NORMAL_ALERT", current.filter((p) => p.alertId != null), rulesVersion),
    computeCohortMetrics("NEVER_ALERTED_BY_SCANNER", current.filter((p) => p.alertId == null), rulesVersion),
  ];

  const leads = input.cases.map((c) => c.leadMs).filter((v): v is number => v != null);
  const avoided = input.cases.map((c) => c.premiumAvoidedPct).filter((v): v is number => v != null);

  // The most valuable thing a research lane can report is what it did NOT take.
  const missed = (input.ungradedCaseOutcomes ?? [])
    .filter((o) => o.mfePct != null && !entered.has(o.fingerprint))
    .sort((a, b) => (b.mfePct as number) - (a.mfePct as number))[0] ?? null;

  return {
    sessionDate: input.sessionDate,
    builtAtMs: input.nowMs,
    rulesVersion,
    rulesVersionsPresent: versions,
    versionMixWarning: versions.length > 1
      ? `Positions from ${versions.length} rule versions are present (${versions.join(", ")}). They are reported separately and must not be pooled.`
      : null,
    cohorts,
    candidateFunnel: {
      captured: input.cases.length,
      paperEntered: current.length,
      paperSkipped: input.skips.reduce((a, s) => a + s.count, 0),
      skipReasons: input.skips.map((s) => ({ reason: s.reason, count: s.count })),
      openPositions: current.filter((p) => p.positionState === "OPEN").length,
      closedPositions: current.filter((p) => p.positionState !== "OPEN").length,
      unverifiedOutcomes: current.filter((p) => p.outcomeState !== "VERIFIED").length,
    },
    evidenceAssociations: [
      associateEvidence("entry_spread_tight", current,
        (p) => (p.entrySpreadPct == null ? null : p.entrySpreadPct <= 10),
        { a: "spread <= 10%", b: "spread > 10%" }),
      associateEvidence("state_at_entry_high_asymmetry", current,
        (p) => p.stateAtEntry === "HIGH_ASYMMETRY",
        { a: "HIGH_ASYMMETRY", b: "other eligible state" }),
      associateEvidence("complete_evidence_at_entry", current,
        (p) => p.missingEvidence.length === 0,
        { a: "no missing evidence", b: "some evidence missing" }),
      associateEvidence("later_confirmed_by_scanner", current,
        (p) => p.alertId != null,
        { a: "scanner alerted too", b: "scanner never alerted" }),
    ],
    holdout: holdoutSplit(current, rulesVersion),
    leadTime: { measured: leads.length, medianMs: median(leads) },
    premiumAvoided: { measured: avoided.length, medianPct: median(avoided) },
    bestMissedOpportunity: missed && missed.mfePct != null
      ? {
        fingerprint: missed.fingerprint, symbol: missed.symbol, mfePct: round2(missed.mfePct),
        reason: "captured as a case but never entered as a paper position",
      }
      : null,
    proposals: buildProposals(cohorts, current.length),
    aiInvolved: false,
    advisoryOnly: true,
    productionBehaviorChanged: false,
  };
}

/**
 * Proposals are DESCRIPTIONS OF EXPERIMENTS, never changes. Every one is
 * emitted PROPOSED / NOT_IMPLEMENTED and nothing reads these back into a
 * threshold, gate, or rule. A proposal is generated only when the cohort it
 * refers to actually clears the minimum sample — otherwise it would be a
 * suggestion built on noise.
 */
export function buildProposals(cohorts: CohortMetrics[], totalPositions: number): QuantProposal[] {
  const proposals: QuantProposal[] = [];
  const usable = cohorts.filter((c) => c.gradeableCount >= MIN_COHORT_SAMPLE);
  if (!usable.length) {
    return [{
      id: "INSUFFICIENT_SAMPLE",
      observation: `No cohort has reached ${MIN_COHORT_SAMPLE} graded outcomes (${totalPositions} position(s) so far).`,
      proposedExperiment: "Continue collecting. Change nothing.",
      evidenceWindow: "current session",
      sampleSize: totalPositions,
      supportingMetrics: {},
      uncertainty: "Total. No rate computed from this data supports any conclusion.",
      approvalStatus: "PROPOSED",
      implementationStatus: "NOT_IMPLEMENTED",
    }];
  }
  const ranked = usable.slice().sort((a, b) => (b.expectancyPct ?? -Infinity) - (a.expectancyPct ?? -Infinity));
  const best = ranked[0];
  const worst = ranked[ranked.length - 1];
  if (best && worst && best.cohort !== worst.cohort) {
    proposals.push({
      id: `COMPARE_${best.cohort}_VS_${worst.cohort}`,
      observation: `${best.cohort} shows expectancy ${fmt(best.expectancyPct)}% over ${best.gradeableCount} graded; ${worst.cohort} shows ${fmt(worst.expectancyPct)}% over ${worst.gradeableCount}.`,
      proposedExperiment: `Continue collecting both cohorts unchanged until each clears a holdout, then compare again. Do not gate on this difference.`,
      evidenceWindow: "current session",
      sampleSize: best.gradeableCount + worst.gradeableCount,
      supportingMetrics: {
        bestWinRatePct: best.winRatePct,
        bestCi95Low: best.winRateCi95?.lowPct ?? null,
        bestCi95High: best.winRateCi95?.highPct ?? null,
        worstWinRatePct: worst.winRatePct,
      },
      uncertainty: best.winRateCi95
        ? `The 95% interval on the better cohort's win rate spans ${best.winRateCi95.lowPct}%–${best.winRateCi95.highPct}%, which is wide enough that the ordering could reverse.`
        : "Interval not computable.",
      approvalStatus: "PROPOSED",
      implementationStatus: "NOT_IMPLEMENTED",
    });
  }
  return proposals;
}

const fmt = (v: number | null): string => (v == null ? "unknown" : String(v));
const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? round2(s[mid]) : round2((s[mid - 1] + s[mid]) / 2);
}

export { PAPER_MILESTONES, PAPER_RULES_VERSION };
