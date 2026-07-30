/**
 * High-Asymmetry Radar — replay/aggregation foundation. PURE, shadow-only.
 *
 * Takes raw candidate submissions, normalizes evidence, measures premium chase,
 * derives a shadow research state, grades the outcome from verified exact-OCC
 * bid marks, and aggregates the cohorts.
 *
 * Deterministic: same inputs, same report. No clock reads beyond the supplied
 * `evaluationAtMs`, no I/O, no provider access, no writes.
 */
import { normalizeAsymmetryEvidence, type AsymmetryEvidence, type AsymmetryQuoteObservation, type MissingReason, type RawAsymmetryEvidence } from "./evidence.ts";
import { analyzePremiumChase, premiumChaseDistribution, type PremiumChaseAnalysis, type PremiumChaseBucket } from "./premium-chase.ts";
import { deriveResearchState, researchStateCounts, type AsymmetryResearchState, type ResearchStateResult, type ResearchStateSignals } from "./states.ts";
import { gradeAsymmetryOutcome, isOutsized, outcomeLabelCounts, type AsymmetryOutcome, type AsymmetryOutcomeLabel } from "./outcomes.ts";
import { compareCohorts, cohortForLabel, type AsymmetryCohort, type CohortComparison, type CohortRow } from "./cohorts.ts";

/** One candidate as submitted to the radar. */
export interface AsymmetryCandidateInput {
  evidence: RawAsymmetryEvidence;
  /** Exact-OCC quotes observed at or before the candidate timestamp. */
  priorQuotes?: AsymmetryQuoteObservation[];
  /** Exact-OCC quotes observed at or after the candidate timestamp. */
  marks?: AsymmetryQuoteObservation[];
  signals?: ResearchStateSignals;
}

export interface AsymmetryCandidateReport {
  candidateId: string;
  symbol: string;
  sessionDate: string | null;
  state: AsymmetryResearchState;
  stateReason: string;
  evidenceCoverage: number;
  missingFields: string[];
  label: AsymmetryOutcomeLabel;
  cohort: AsymmetryCohort;
  premiumChaseBucket: PremiumChaseBucket;
  premiumChasePct: number | null;
  evidence: AsymmetryEvidence;
  chase: PremiumChaseAnalysis;
  outcome: AsymmetryOutcome;
  canSend: false;
  notSubscriberReady: true;
}

export interface DataCoverageReport {
  candidates: number;
  evidenceComplete: number;
  withVerifiedOcc: number;
  withExecutableQuote: number;
  withUsableMarks: number;
  withPremiumChaseBaseline: number;
  withConfirmedCatalyst: number;
  rejectedUnsourcedCatalysts: number;
  /** Field name → how many candidates are missing it, and why. */
  missingByField: Record<string, { count: number; reasons: Record<string, number> }>;
  quoteRejections: Record<string, number>;
  markRejections: Record<string, number>;
}

export interface AsymmetryResearchReport {
  advisoryOnly: true;
  productionBehaviorChanged: false;
  shadowOnly: true;
  evaluationAtMs: number;
  candidates: AsymmetryCandidateReport[];
  stateCounts: Record<AsymmetryResearchState, number>;
  outcomeCounts: Record<AsymmetryOutcomeLabel, number>;
  outsizedCount: number;
  premiumChaseDistribution: Record<PremiumChaseBucket, number>;
  cohortComparison: CohortComparison;
  coverage: DataCoverageReport;
  limitations: string[];
}

const bump = (into: Record<string, number>, key: string | null | undefined): void => {
  if (!key) return;
  into[key] = (into[key] ?? 0) + 1;
};

/** Normalizes, grades, and aggregates one cohort of candidates. */
export function buildAsymmetryResearchReport(
  inputs: AsymmetryCandidateInput[],
  opts: { evaluationAtMs?: number; maxQuoteAgeMs?: number; minimumSupportedSample?: number; env?: NodeJS.ProcessEnv } = {},
): AsymmetryResearchReport {
  const evaluationAtMs = opts.evaluationAtMs ?? Date.now();
  const maxQuoteAgeMs = opts.maxQuoteAgeMs ?? 60_000;

  const missingByField: DataCoverageReport["missingByField"] = {};
  const quoteRejections: Record<string, number> = {};
  const markRejections: Record<string, number> = {};

  const candidates: AsymmetryCandidateReport[] = inputs.map((input) => {
    const evidence = normalizeAsymmetryEvidence(input.evidence, { maxQuoteAgeMs, env: opts.env });
    const chase = analyzePremiumChase({
      occSymbol: evidence.occSymbol,
      candidateAtMs: evidence.detectionAtMs,
      candidateAsk: evidence.ask,
      priorQuotes: input.priorQuotes ?? [],
      maxQuoteAgeMs,
      env: opts.env,
    });
    const state: ResearchStateResult = deriveResearchState(evidence, chase, input.signals ?? {});
    const outcome = gradeAsymmetryOutcome({
      candidateId: evidence.candidateId,
      occSymbol: evidence.occSymbol,
      entryAtMs: evidence.detectionAtMs,
      entryAsk: evidence.ask,
      marks: input.marks ?? [],
      premiumChase: chase,
    }, { evaluationAtMs, maxQuoteAgeMs, env: opts.env });

    for (const [field, reason] of Object.entries(evidence.missing) as Array<[string, MissingReason]>) {
      const entry = missingByField[field] ?? (missingByField[field] = { count: 0, reasons: {} });
      entry.count += 1;
      bump(entry.reasons, reason);
    }
    bump(quoteRejections, evidence.quoteRejection);
    for (const rejection of outcome.rejectedMarks) bump(markRejections, rejection.reason);
    for (const rejection of chase.rejected) bump(quoteRejections, rejection.reason);

    return {
      candidateId: evidence.candidateId,
      symbol: evidence.symbol,
      sessionDate: evidence.sessionDate,
      state: state.state,
      stateReason: state.reason,
      evidenceCoverage: state.evidenceCoverage,
      missingFields: state.missingFields,
      label: outcome.label,
      cohort: cohortForLabel(outcome.label),
      premiumChaseBucket: chase.bucket,
      premiumChasePct: chase.chasePct,
      evidence,
      chase,
      outcome,
      canSend: false,
      notSubscriberReady: true,
    };
  });

  const rows: CohortRow[] = candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    evidence: candidate.evidence,
    chase: candidate.chase,
    outcome: candidate.outcome,
  }));

  const coverage: DataCoverageReport = {
    candidates: candidates.length,
    evidenceComplete: candidates.filter((c) => c.evidence.evidenceComplete).length,
    withVerifiedOcc: candidates.filter((c) => c.evidence.occSymbol != null).length,
    withExecutableQuote: candidates.filter((c) => c.evidence.ask != null).length,
    withUsableMarks: candidates.filter((c) => c.outcome.usableMarkCount > 0).length,
    withPremiumChaseBaseline: candidates.filter((c) => c.chase.earliestAsk != null).length,
    withConfirmedCatalyst: candidates.filter((c) => c.evidence.catalystState === "CONFIRMED").length,
    rejectedUnsourcedCatalysts: candidates.filter((c) => c.evidence.catalystState === "REJECTED_UNSOURCED").length,
    missingByField,
    quoteRejections,
    markRejections,
  };

  return {
    advisoryOnly: true,
    productionBehaviorChanged: false,
    shadowOnly: true,
    evaluationAtMs,
    candidates,
    stateCounts: researchStateCounts(candidates.map((c) => ({
      state: c.state, reason: c.stateReason, evidenceCoverage: c.evidenceCoverage,
      missingFields: c.missingFields, canSend: false, notSubscriberReady: true,
    }))),
    outcomeCounts: outcomeLabelCounts(candidates.map((c) => c.outcome)),
    outsizedCount: candidates.filter((c) => isOutsized(c.label)).length,
    premiumChaseDistribution: premiumChaseDistribution(candidates.map((c) => c.chase)),
    cohortComparison: compareCohorts(rows, { minimumSupportedSample: opts.minimumSupportedSample }),
    coverage,
    limitations: [
      "Research only. This module cannot send, rank, gate, or alter any live alert, contract, entry, stop, target, or paper position.",
      "Entries are ask-side and marks are bid-side; no mid or theoretical fill is ever assumed.",
      "Outcome labels describe verified past exact-OCC option marks. They are not predictions and imply no future gain.",
      "A missing feature is reported as missing. It is never substituted with zero, a default, or an inferred value.",
      "Research states are evidence-coverage classifications, not subscriber readiness and not authority to deliver.",
      "Premium-chase buckets are diagnostics only; in this phase nothing is blocked or altered because of them.",
    ],
  };
}
