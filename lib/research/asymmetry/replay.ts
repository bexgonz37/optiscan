/**
 * High-Asymmetry Radar — real-data replay. READ-ONLY and IDEMPOTENT.
 *
 * Runs the Phase 1 grading engine over persisted evidence across one or more
 * trading sessions, and reports what could truthfully be learned:
 *
 *   coverage audit → identity audit → grading → cohort aggregation
 *
 * Every statement reached from here is a SELECT. The replay writes nothing, so
 * running it twice on the same database with the same `evaluationAtMs` produces
 * byte-identical output and there is no migration to review.
 *
 * `evaluationAtMs` is the evidence horizon: nothing stamped after it is read,
 * so a replay of a past session cannot borrow knowledge from later.
 */
import { tradingDay } from "../../trading-session.ts";
import { auditDataAvailability, sharePct, type AuditCandidate, type DataAvailabilityAudit } from "./coverage-audit.ts";
import {
  DAY_RE, hasTable, listAsymmetrySessionsOnDb, readAsymmetryObservationsOnDb, readMarksForOccOnDb,
  type AsymmetryObservationRow, type Db,
} from "./db-read.ts";
import { auditDetectionClusters, groupCandidates, type CandidateIdentityStrategy, type DuplicateDetectionAudit } from "./identity.ts";
import { KNOWN_UNSOURCED_FIELDS, candidateInputFromRows } from "./loader.ts";
import { buildAsymmetryResearchReport, type AsymmetryCandidateInput, type AsymmetryResearchReport } from "./report.ts";
import type { AsymmetryQuoteObservation } from "./evidence.ts";

export interface AsymmetryReplayOptions {
  /** Explicit sessions to replay. Defaults to the most recent available. */
  sessionDates?: string[];
  /** How many recent sessions to discover when none are named. */
  maxSessions?: number;
  evaluationAtMs?: number;
  maxQuoteAgeMs?: number;
  minimumSupportedSample?: number;
  identityStrategy?: CandidateIdentityStrategy;
  clusterGapMs?: number;
  detailLimit?: number;
  /** Verified historical examples to replay alongside persisted evidence. */
  extraCandidates?: AsymmetryCandidateInput[];
  env?: NodeJS.ProcessEnv;
}

export interface AsymmetryReplayResult {
  advisoryOnly: true;
  productionBehaviorChanged: false;
  readOnly: true;
  writesPerformed: 0;
  evaluationAtMs: number;
  maxQuoteAgeMs: number;
  identityStrategy: CandidateIdentityStrategy;

  sessionsRequested: string[];
  sessionsWithData: string[];
  sessionsAvailableInDb: string[];

  coverage: DataAvailabilityAudit;
  duplicateAudit: DuplicateDetectionAudit;
  report: AsymmetryResearchReport;

  /** Compact per-candidate replay rows, gradeable and excluded alike. */
  rows: ReplayRow[];
  knownUnsourcedFields: string[];
  warnings: string[];
  notes: string[];
}

export interface ReplayRow {
  candidateId: string;
  symbol: string;
  sessionDate: string | null;
  occSymbol: string | null;
  direction: string | null;
  setupFamily: string | null;
  candidateAtMs: number | null;
  entryAsk: number | null;
  peakVerifiedBid: number | null;
  mfePct: number | null;
  maePct: number | null;
  finalVerifiedReturnPct: number | null;
  timeToMilestoneMs: Record<string, number | null>;
  premiumChaseBucket: string;
  premiumChasePct: number | null;
  outsizedMoveTiming: string;
  label: string;
  cohort: string;
  researchState: string;
  evidenceCoverage: number;
  usableMarkCount: number;
  /** Set only when the candidate could not be graded. */
  exclusionReason: string | null;
  limitation: string | null;
}

/**
 * Replays persisted evidence. Read-only and deterministic for a fixed
 * `evaluationAtMs`; pass one explicitly to make a run reproducible.
 */
export function runAsymmetryReplayOnDb(db: Db, opts: AsymmetryReplayOptions = {}): AsymmetryReplayResult {
  const evaluationAtMs = opts.evaluationAtMs ?? Date.now();
  const maxQuoteAgeMs = opts.maxQuoteAgeMs ?? 60_000;
  const identityStrategy = opts.identityStrategy ?? "OCC_SESSION_FIRST_OBSERVATION";
  const detailLimit = Math.max(1, Math.min(500, opts.detailLimit ?? 100));
  const warnings: string[] = [];

  const sessionsAvailableInDb = listAsymmetrySessionsOnDb(db, 90);
  if (!hasTable(db, "options_research_observations")) {
    warnings.push("options_research_observations unavailable; nothing can be replayed.");
  }
  if (!hasTable(db, "options_paper_marks")) {
    warnings.push("options_paper_marks unavailable; no outcome can be graded.");
  }

  const requested = (opts.sessionDates ?? []).filter((day) => DAY_RE.test(day));
  for (const day of opts.sessionDates ?? []) {
    if (!DAY_RE.test(day)) warnings.push(`Ignored session "${day}": not YYYY-MM-DD.`);
  }
  const sessionsRequested = requested.length
    ? requested
    : sessionsAvailableInDb.slice(0, Math.max(1, Math.min(90, opts.maxSessions ?? 5)));
  if (!sessionsRequested.length) {
    warnings.push(`No trading session with persisted research observations was found (checked up to ${tradingDay(evaluationAtMs)}).`);
  }

  const allObservations: AsymmetryObservationRow[] = [];
  const auditCandidates: AuditCandidate[] = [];
  const inputs: AsymmetryCandidateInput[] = [];
  const sessionsWithData: string[] = [];
  const groupedRowsByCandidateId = new Map<string, AsymmetryObservationRow[]>();

  for (const sessionDate of sessionsRequested) {
    // requireOcc:false so contract-less observations stay in the denominator
    // and are counted as MISSING_OCC instead of silently disappearing.
    const observations = readAsymmetryObservationsOnDb(db, { sessionDate, evaluationAtMs, requireOcc: false });
    if (!observations.length) continue;
    sessionsWithData.push(sessionDate);
    allObservations.push(...observations);

    const withContract = observations.filter((row) => String(row.occSymbolRaw ?? "").trim().length > 0);
    const contractless = observations.filter((row) => String(row.occSymbolRaw ?? "").trim().length === 0);

    // Contract-less observations can never be graded, but each is still a real
    // detection and is audited as MISSING_OCC rather than dropped.
    contractless.forEach((row, index) => {
      auditCandidates.push({
        key: `${sessionDate}:no-occ:${row.id ?? index}`,
        occSymbolRaw: null,
        anchor: row,
        marks: [],
      });
    });

    for (const group of groupCandidates(withContract, { strategy: identityStrategy, clusterGapMs: opts.clusterGapMs })) {
      const anchor = group.rows[0];
      const candidateAtMs = anchor?.observedAtMs;
      if (anchor == null || candidateAtMs == null) continue;
      const marks: AsymmetryQuoteObservation[] = readMarksForOccOnDb(db, group.occSymbol, candidateAtMs, evaluationAtMs);
      const candidateId = `${sessionDate}:${group.key}`;

      auditCandidates.push({ key: candidateId, occSymbolRaw: group.occSymbol, anchor, marks });
      groupedRowsByCandidateId.set(candidateId, group.rows);

      const input = candidateInputFromRows(group.rows, {
        sessionDate, occSymbol: group.occSymbol, groupKey: group.key, marks,
      });
      if (input) inputs.push(input);
    }
  }

  const extraCandidates = opts.extraCandidates ?? [];
  const coverage = auditDataAvailability(allObservations, auditCandidates, {
    evaluationAtMs, maxQuoteAgeMs, detailLimit, env: opts.env,
  });
  const duplicateAudit = auditDetectionClusters(
    allObservations.filter((row) => String(row.occSymbolRaw ?? "").trim().length > 0),
    { detailLimit: Math.min(detailLimit, 50) },
  );
  const report = buildAsymmetryResearchReport([...inputs, ...extraCandidates], {
    evaluationAtMs, maxQuoteAgeMs, minimumSupportedSample: opts.minimumSupportedSample, env: opts.env,
  });

  const exclusionByKey = new Map(coverage.candidates.map((row) => [row.key, row.exclusionReason]));
  const rows: ReplayRow[] = report.candidates.map((candidate) => {
    const marks = candidate.outcome;
    const peakVerifiedBid = marks.entryAsk != null && marks.mfePct != null
      ? Math.round(marks.entryAsk * (1 + marks.mfePct / 100) * 10_000) / 10_000
      : null;
    return {
      candidateId: candidate.candidateId,
      symbol: candidate.symbol,
      sessionDate: candidate.sessionDate,
      occSymbol: candidate.evidence.occSymbol,
      direction: candidate.evidence.direction,
      setupFamily: candidate.evidence.setupFamily,
      candidateAtMs: Number.isFinite(candidate.evidence.detectionAtMs) ? candidate.evidence.detectionAtMs : null,
      entryAsk: marks.entryAsk,
      peakVerifiedBid,
      mfePct: marks.mfePct,
      maePct: marks.maePct,
      finalVerifiedReturnPct: marks.finalVerifiedReturnPct,
      timeToMilestoneMs: marks.timeToMilestoneMs,
      premiumChaseBucket: candidate.premiumChaseBucket,
      premiumChasePct: candidate.premiumChasePct,
      outsizedMoveTiming: marks.outsizedMoveTiming,
      label: candidate.label,
      cohort: candidate.cohort,
      researchState: candidate.state,
      evidenceCoverage: candidate.evidenceCoverage,
      usableMarkCount: marks.usableMarkCount,
      exclusionReason: exclusionByKey.get(candidate.candidateId) ?? null,
      limitation: marks.limitation,
    };
  });

  if (sessionsWithData.length === 0 && sessionsRequested.length > 0) {
    warnings.push(`No observations found for the requested session(s): ${sessionsRequested.join(", ")}.`);
  }
  if (report.candidates.length > 0 && coverage.gradeableCandidates === 0) {
    warnings.push("Candidates were found but none is gradeable; see coverage.exclusions for the reason.");
  }
  if (duplicateAudit.candidatesWithVacuousPremiumChase > 0) {
    warnings.push(`${duplicateAudit.candidatesWithVacuousPremiumChase} candidate(s) have a structurally vacuous premium-chase figure under ${identityStrategy}: the candidate quote is also the earliest quote.`);
  }

  return {
    advisoryOnly: true,
    productionBehaviorChanged: false,
    readOnly: true,
    writesPerformed: 0,
    evaluationAtMs,
    maxQuoteAgeMs,
    identityStrategy,
    sessionsRequested,
    sessionsWithData,
    sessionsAvailableInDb,
    coverage,
    duplicateAudit,
    report,
    rows: rows.slice(0, detailLimit),
    knownUnsourcedFields: [...KNOWN_UNSOURCED_FIELDS],
    warnings,
    notes: [
      "Read-only: the replay performs SELECTs only, adds no migration, and writes nothing.",
      "Idempotent: the same database and the same evaluationAtMs produce identical output.",
      "evaluationAtMs is the evidence horizon; nothing stamped after it is read, so a past session cannot borrow later knowledge.",
      "Zero gradeable candidates means the evidence is absent, not that the strategy performed at zero.",
    ],
  };
}

/** Coverage percentages for a human reader. Empty denominators stay null. */
export function replayCoverageSummary(result: AsymmetryReplayResult): Record<string, number | null> {
  const detections = result.coverage.distinctCandidateDetections;
  return {
    gradeableSharePct: sharePct(result.coverage.gradeableCandidates, detections),
    askEntrySharePct: sharePct(result.coverage.candidatesWithFreshAskEntry, detections),
    markedSharePct: sharePct(result.coverage.candidatesWithSubsequentFreshBidMarks, detections),
    premiumChaseBaselineSharePct: sharePct(result.coverage.candidatesWithPremiumChaseBaseline, detections),
  };
}
