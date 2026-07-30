/**
 * High-Asymmetry Radar — data-availability audit. PURE.
 *
 * Answers "what could we truthfully learn from the evidence that actually
 * exists?" before any conclusion is drawn from it. Every candidate that cannot
 * be graded is attributed to exactly ONE primary exclusion reason, evaluated in
 * a fixed order, so the exclusion counts sum to the ungradeable population and
 * nothing disappears silently.
 *
 * Missing data is never turned into zero. A count of candidates we could not
 * measure is reported as its own number, never folded into a denominator as if
 * it had been measured and found absent.
 */
import {
  round, validateExecutableQuote, verifyOccIdentity,
  type AsymmetryQuoteObservation,
} from "./evidence.ts";
import { ASYMMETRY_HORIZONS_MINUTES } from "./outcomes.ts";
import { tradingDay } from "../../trading-session.ts";
import type { AsymmetryObservationRow } from "./db-read.ts";

export type ExclusionReason =
  | "MISSING_OCC"
  | "WRONG_OCC"
  | "MISSING_ASK"
  | "FUTURE_EVIDENCE"
  | "AFTER_HOURS_EVIDENCE"
  | "WRONG_SESSION"
  | "STALE_QUOTE"
  | "MISSING_SUBSEQUENT_BID"
  | "INSUFFICIENT_OBSERVATION_HORIZON";

export const EXCLUSION_REASONS: ExclusionReason[] = [
  "MISSING_OCC", "WRONG_OCC", "MISSING_ASK", "FUTURE_EVIDENCE", "AFTER_HOURS_EVIDENCE",
  "WRONG_SESSION", "STALE_QUOTE", "MISSING_SUBSEQUENT_BID", "INSUFFICIENT_OBSERVATION_HORIZON",
];

/** One candidate as offered to the audit: its anchor row plus its OCC marks. */
export interface AuditCandidate {
  key: string;
  occSymbolRaw: string | null;
  anchor: AsymmetryObservationRow;
  marks: AsymmetryQuoteObservation[];
}

export interface CandidateAuditRow {
  key: string;
  symbol: string;
  sessionDate: string | null;
  occSymbol: string | null;
  detectionAtMs: number | null;
  gradeable: boolean;
  exclusionReason: ExclusionReason | null;
  entryAsk: number | null;
  usableMarkCount: number;
  /** Horizon key → whether a qualifying mark exists. Never a fabricated value. */
  horizonCoverage: Record<string, boolean>;
  observationWindowMs: number | null;
  hasPremiumChaseBaseline: boolean;
}

export interface DataAvailabilityAudit {
  advisoryOnly: true;
  productionBehaviorChanged: false;
  evaluationAtMs: number;
  maxQuoteAgeMs: number;

  totalObservations: number;
  observationsWithoutContract: number;
  distinctOccContracts: number;
  distinctCandidateDetections: number;
  distinctTradingSessions: number;
  distinctSymbols: number;

  candidatesWithFreshAskEntry: number;
  candidatesWithSubsequentFreshBidMarks: number;
  /** Horizon key ("1m"…"60m") → candidates with a qualifying verified mark. */
  gradeableByHorizon: Record<string, number>;
  candidatesWithMfeEvidence: number;
  candidatesWithMaeEvidence: number;
  candidatesWithPremiumChaseBaseline: number;

  gradeableCandidates: number;
  ungradeableCandidates: number;
  exclusions: Record<ExclusionReason, number>;

  candidates: CandidateAuditRow[];
  notes: string[];
}

/**
 * Attributes one candidate to its single primary exclusion reason, or accepts
 * it. The order is fixed and each step answers a strictly earlier question, so
 * a candidate is never counted twice.
 */
function auditOne(
  candidate: AuditCandidate,
  opts: { evaluationAtMs: number; maxQuoteAgeMs: number; env?: NodeJS.ProcessEnv },
): CandidateAuditRow {
  const anchor = candidate.anchor;
  const detectionAtMs = anchor.observedAtMs;
  const horizonCoverage = Object.fromEntries(
    ASYMMETRY_HORIZONS_MINUTES.map((minutes) => [`${minutes}m`, false]),
  ) as Record<string, boolean>;

  const row: CandidateAuditRow = {
    key: candidate.key,
    symbol: anchor.symbol,
    sessionDate: anchor.sessionDate,
    occSymbol: null,
    detectionAtMs,
    gradeable: false,
    exclusionReason: null,
    entryAsk: null,
    usableMarkCount: 0,
    horizonCoverage,
    observationWindowMs: null,
    hasPremiumChaseBaseline: false,
  };

  // 1. Do we know WHICH contract this is?
  if (!candidate.occSymbolRaw) {
    row.exclusionReason = "MISSING_OCC";
    return row;
  }
  const identity = verifyOccIdentity({
    occSymbol: candidate.occSymbolRaw,
    symbol: anchor.symbol,
    expiration: anchor.expiration,
    strike: anchor.strike,
    optionType: anchor.optionType,
  });
  if (!identity.ok) {
    row.exclusionReason = "WRONG_OCC";
    return row;
  }
  row.occSymbol = identity.occSymbol;

  // 2. Was there an executable ask to enter on?
  if (anchor.ask == null || anchor.bid == null || detectionAtMs == null) {
    row.exclusionReason = "MISSING_ASK";
    return row;
  }
  const entry = validateExecutableQuote({
    occSymbol: identity.occSymbol,
    expectedOccSymbol: identity.occSymbol,
    atMs: detectionAtMs,
    bid: anchor.bid,
    ask: anchor.ask,
    quoteTimestampMs: anchor.quoteTimestampMs ?? (anchor.quoteAgeMs != null ? detectionAtMs - anchor.quoteAgeMs : null),
    referenceAtMs: detectionAtMs,
    maxQuoteAgeMs: opts.maxQuoteAgeMs,
    env: opts.env,
  });
  if (!entry.valid) {
    row.exclusionReason =
      entry.reason === "QUOTE_TIMESTAMP_IN_FUTURE" ? "FUTURE_EVIDENCE"
      : entry.reason === "QUOTE_OUTSIDE_OPTIONS_SESSION" ? "AFTER_HOURS_EVIDENCE"
      : entry.reason === "QUOTE_FROM_DIFFERENT_SESSION" ? "WRONG_SESSION"
      : entry.reason === "QUOTE_STALE" ? "STALE_QUOTE"
      : "MISSING_ASK";
    return row;
  }
  row.entryAsk = entry.ask;

  // 3. Is there any verified bid to mark against, after entry?
  const usable = candidate.marks
    // Same-session only: a mark is validated against its own observation time,
    // which would let a later SESSION's quote look perfectly fresh.
    .filter((mark) => mark.atMs >= detectionAtMs && mark.atMs <= opts.evaluationAtMs
      && tradingDay(mark.atMs) === tradingDay(detectionAtMs))
    .map((mark) => ({
      atMs: mark.atMs,
      quote: validateExecutableQuote({
        occSymbol: mark.occSymbol,
        expectedOccSymbol: identity.occSymbol,
        atMs: mark.atMs,
        bid: mark.bid,
        ask: mark.ask,
        quoteTimestampMs: mark.quoteTimestampMs,
        referenceAtMs: mark.atMs,
        maxQuoteAgeMs: opts.maxQuoteAgeMs,
        env: opts.env,
      }),
    }))
    .filter((mark) => mark.quote.valid)
    .sort((a, b) => a.atMs - b.atMs);

  row.usableMarkCount = usable.length;
  if (!usable.length) {
    row.exclusionReason = "MISSING_SUBSEQUENT_BID";
    return row;
  }

  row.observationWindowMs = usable[usable.length - 1].atMs - detectionAtMs;
  for (const minutes of ASYMMETRY_HORIZONS_MINUTES) {
    horizonCoverage[`${minutes}m`] = usable.some((mark) => mark.atMs >= detectionAtMs + minutes * 60_000);
  }

  // 4. Has enough time even elapsed to observe the shortest horizon?
  if (row.observationWindowMs < ASYMMETRY_HORIZONS_MINUTES[0] * 60_000) {
    row.exclusionReason = "INSUFFICIENT_OBSERVATION_HORIZON";
    return row;
  }

  row.gradeable = true;
  return row;
}

/**
 * Audits what the available evidence can support.
 *
 * `allObservations` is the FULL row set including observations with no
 * contract, so the denominator is honest. `candidates` is the grouped, gradable
 * population under the active identity.
 */
export function auditDataAvailability(
  allObservations: AsymmetryObservationRow[],
  candidates: AuditCandidate[],
  opts: { evaluationAtMs: number; maxQuoteAgeMs?: number; detailLimit?: number; env?: NodeJS.ProcessEnv },
): DataAvailabilityAudit {
  const maxQuoteAgeMs = opts.maxQuoteAgeMs ?? 60_000;
  const detailLimit = Math.max(1, Math.min(500, opts.detailLimit ?? 100));

  const rows = candidates.map((candidate) => auditOne(candidate, { ...opts, maxQuoteAgeMs }));

  const exclusions = Object.fromEntries(EXCLUSION_REASONS.map((reason) => [reason, 0])) as Record<ExclusionReason, number>;
  for (const row of rows) if (row.exclusionReason) exclusions[row.exclusionReason] += 1;

  const gradeableByHorizon = Object.fromEntries(
    ASYMMETRY_HORIZONS_MINUTES.map((minutes) => [
      `${minutes}m`,
      rows.filter((row) => row.horizonCoverage[`${minutes}m`]).length,
    ]),
  ) as Record<string, number>;

  // Premium-chase baseline: a strictly EARLIER observation of the same contract
  // than the candidate anchor. Under the Phase 1 identity there is none.
  const withBaseline = candidates.filter((candidate) => {
    const anchorAtMs = candidate.anchor.observedAtMs;
    if (anchorAtMs == null) return false;
    return allObservations.some((row) =>
      row.observedAtMs != null && row.observedAtMs < anchorAtMs
      && String(row.occSymbolRaw ?? "").trim().toUpperCase() === String(candidate.occSymbolRaw ?? "").trim().toUpperCase()
      && row.ask != null && row.bid != null);
  });
  const baselineKeys = new Set(withBaseline.map((candidate) => candidate.key));
  for (const row of rows) row.hasPremiumChaseBaseline = baselineKeys.has(row.key);

  const withContract = allObservations.filter((row) => String(row.occSymbolRaw ?? "").trim().length > 0);

  return {
    advisoryOnly: true,
    productionBehaviorChanged: false,
    evaluationAtMs: opts.evaluationAtMs,
    maxQuoteAgeMs,

    totalObservations: allObservations.length,
    observationsWithoutContract: allObservations.length - withContract.length,
    distinctOccContracts: new Set(withContract.map((row) => String(row.occSymbolRaw).trim().toUpperCase())).size,
    distinctCandidateDetections: candidates.length,
    distinctTradingSessions: new Set(allObservations.map((row) => row.sessionDate).filter(Boolean)).size,
    distinctSymbols: new Set(allObservations.map((row) => row.symbol).filter(Boolean)).size,

    candidatesWithFreshAskEntry: rows.filter((row) => row.entryAsk != null).length,
    candidatesWithSubsequentFreshBidMarks: rows.filter((row) => row.usableMarkCount > 0).length,
    gradeableByHorizon,
    // MFE and MAE are both derived from the same verified mark series: one
    // usable mark is enough for each, and neither is inferred without one.
    candidatesWithMfeEvidence: rows.filter((row) => row.usableMarkCount > 0).length,
    candidatesWithMaeEvidence: rows.filter((row) => row.usableMarkCount > 0).length,
    candidatesWithPremiumChaseBaseline: baselineKeys.size,

    gradeableCandidates: rows.filter((row) => row.gradeable).length,
    ungradeableCandidates: rows.filter((row) => !row.gradeable).length,
    exclusions,

    candidates: rows.slice(0, detailLimit),
    notes: [
      "Each ungradeable candidate is attributed to exactly one primary exclusion reason, so the exclusion counts sum to the ungradeable population.",
      "A candidate we could not measure is counted as unmeasured. It is never folded into a rate as though it had been measured and found absent.",
      "Horizon coverage records whether a qualifying verified mark exists; a horizon with no mark is false, never a 0% return.",
      "A premium-chase baseline requires a strictly earlier observation of the same contract than the candidate anchor.",
    ],
  };
}

/** Share of `part` in `whole`, or null when the denominator is empty. */
export function sharePct(part: number, whole: number): number | null {
  return whole > 0 ? round((part / whole) * 100, 4) : null;
}
