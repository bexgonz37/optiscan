/**
 * High-Asymmetry Radar — deterministic outcome labelling. PURE, shadow-only.
 *
 * Grading contract, deliberately conservative and identical for every candidate:
 *
 *  - ENTRY is the ASK at the candidate timestamp. We never assume a mid fill.
 *  - MARKS are BID-side. We never assume we could sell at the ask or the mid.
 *  - Every mark must be the SAME exact OCC contract, in the same session, at or
 *    after entry, at or before the evaluation time, with a fresh provider quote
 *    timestamp. Stale, undated, future, after-hours, wrong-session, and
 *    wrong-OCC marks are refused and counted, never interpolated over.
 *  - No mark is ever synthesised. A horizon with no qualifying mark is `null`,
 *    which is NOT the same as 0%.
 *
 * The labels describe VERIFIED PAST option marks. They are not forecasts, and
 * nothing in this module asserts that a future candidate will repeat them.
 */
import { round, validateExecutableQuote, type AsymmetryQuoteObservation, type QuoteRejection } from "./evidence.ts";
import { tradingDay } from "../../trading-session.ts";
import type { PremiumChaseAnalysis } from "./premium-chase.ts";

export const ASYMMETRY_HORIZONS_MINUTES = [1, 3, 5, 10, 15, 30, 60] as const;
export const ASYMMETRY_MILESTONES_PCT = [25, 50, 100, 200, 500] as const;
/** Descending: the first threshold met by MFE wins. */
export const OUTSIZED_THRESHOLDS_PCT = [500, 200, 100, 50] as const;

/** A real but ordinary gain still counts as a win — it is never "outsized". */
export const ORDINARY_WIN_PCT = 10;
/** Symmetric band around zero that we call flat rather than a loss. */
export const FLAT_BAND_PCT = 10;

export type AsymmetryOutcomeLabel =
  | "OUTSIZED_500"
  | "OUTSIZED_200"
  | "OUTSIZED_100"
  | "OUTSIZED_50"
  | "ORDINARY_WIN"
  | "FLAT"
  | "FAILED"
  | "INSUFFICIENT_EVIDENCE";

export const ASYMMETRY_OUTCOME_LABELS: AsymmetryOutcomeLabel[] = [
  "OUTSIZED_500", "OUTSIZED_200", "OUTSIZED_100", "OUTSIZED_50",
  "ORDINARY_WIN", "FLAT", "FAILED", "INSUFFICIENT_EVIDENCE",
];

export const OUTSIZED_LABELS: AsymmetryOutcomeLabel[] = [
  "OUTSIZED_500", "OUTSIZED_200", "OUTSIZED_100", "OUTSIZED_50",
];

/** Where the outsized move sat relative to the premium that had already run. */
export type OutsizedMoveTiming =
  | "SURVIVED_PREMIUM_CHASE"
  | "CONSUMED_BY_PREMIUM_CHASE"
  | "NO_OUTSIZED_MOVE"
  | "UNKNOWN";

export interface AsymmetryOutcome {
  candidateId: string;
  occSymbol: string | null;
  label: AsymmetryOutcomeLabel;
  /** Highest outsized threshold the VERIFIED peak bid actually reached. */
  outsizedThresholdPct: number | null;
  entryAsk: number | null;
  entryAtMs: number | null;
  /** Horizon key ("1m", "3m", …) → bid-based return %, or null when unproven. */
  returnsByHorizon: Record<string, number | null>;
  mfePct: number | null;
  maePct: number | null;
  finalVerifiedReturnPct: number | null;
  finalVerifiedAtMs: number | null;
  /** Milestone % → ms from entry to the first verified mark at/above it. */
  timeToMilestoneMs: Record<string, number | null>;
  outsizedMoveTiming: OutsizedMoveTiming;
  /** True only when a fresh executable EXIT quote existed at the final mark. */
  freshExecutableExitQuote: boolean;
  usableMarkCount: number;
  rejectedMarks: Array<{ atMs: number; source: string; reason: QuoteRejection }>;
  limitation: string | null;
}

export interface AsymmetryGradingInput {
  candidateId: string;
  occSymbol: string | null;
  entryAtMs: number;
  /** Conservative ask entry at the candidate timestamp. */
  entryAsk: number | null;
  marks: AsymmetryQuoteObservation[];
  /** Optional; supplies the pre-chase baseline ask for move-timing. */
  premiumChase?: PremiumChaseAnalysis | null;
}

const emptyRecord = <T extends readonly (string | number)[]>(keys: T, suffix = ""): Record<string, null> =>
  Object.fromEntries(keys.map((k) => [`${k}${suffix}`, null]));

/**
 * Grades one candidate from verified exact-OCC bid marks.
 * `evaluationAtMs` bounds the evidence: a mark stamped after it is future
 * evidence and cannot influence the label.
 */
export function gradeAsymmetryOutcome(
  input: AsymmetryGradingInput,
  opts: { evaluationAtMs?: number; maxQuoteAgeMs?: number; env?: NodeJS.ProcessEnv } = {},
): AsymmetryOutcome {
  const maxQuoteAgeMs = opts.maxQuoteAgeMs ?? 60_000;
  const evaluationAtMs = opts.evaluationAtMs ?? Number.POSITIVE_INFINITY;
  const rejectedMarks: AsymmetryOutcome["rejectedMarks"] = [];

  const insufficient = (limitation: string): AsymmetryOutcome => ({
    candidateId: input.candidateId,
    occSymbol: input.occSymbol,
    label: "INSUFFICIENT_EVIDENCE",
    outsizedThresholdPct: null,
    entryAsk: input.entryAsk ?? null,
    entryAtMs: Number.isFinite(input.entryAtMs) ? input.entryAtMs : null,
    returnsByHorizon: emptyRecord(ASYMMETRY_HORIZONS_MINUTES, "m"),
    mfePct: null,
    maePct: null,
    finalVerifiedReturnPct: null,
    finalVerifiedAtMs: null,
    timeToMilestoneMs: emptyRecord(ASYMMETRY_MILESTONES_PCT),
    outsizedMoveTiming: "UNKNOWN",
    freshExecutableExitQuote: false,
    usableMarkCount: 0,
    rejectedMarks,
    limitation,
  });

  if (!input.occSymbol) return insufficient("No verified exact OCC contract; the outcome cannot be graded.");
  if (!Number.isFinite(input.entryAtMs)) return insufficient("Entry timestamp is unusable.");
  const entryAsk = input.entryAsk;
  if (entryAsk == null || !Number.isFinite(entryAsk) || entryAsk <= 0) {
    return insufficient("No executable ask entry at the candidate timestamp.");
  }

  const usable = [...input.marks]
    .sort((a, b) => a.atMs - b.atMs)
    .map((mark) => ({
      mark,
      quote: validateExecutableQuote({
        occSymbol: mark.occSymbol,
        expectedOccSymbol: input.occSymbol,
        atMs: mark.atMs,
        bid: mark.bid,
        ask: mark.ask,
        quoteTimestampMs: mark.quoteTimestampMs,
        // A mark is judged against its OWN observation time; the evaluation
        // bound is applied separately so "too late to know yet" is not
        // confused with "the quote was bad".
        referenceAtMs: mark.atMs,
        maxQuoteAgeMs,
        env: opts.env,
      }),
    }))
    .filter((row) => {
      if (row.mark.atMs < input.entryAtMs) {
        rejectedMarks.push({ atMs: row.mark.atMs, source: row.mark.source, reason: "QUOTE_TIMESTAMP_IN_FUTURE" });
        return false;
      }
      // A mark is validated against its OWN observation time, which would let a
      // later SESSION's quote look perfectly fresh. The outcome must belong to
      // the same trading day as the entry, so that is checked separately.
      if (tradingDay(row.mark.atMs) !== tradingDay(input.entryAtMs)) {
        rejectedMarks.push({ atMs: row.mark.atMs, source: row.mark.source, reason: "QUOTE_FROM_DIFFERENT_SESSION" });
        return false;
      }
      if (row.mark.atMs > evaluationAtMs) {
        rejectedMarks.push({ atMs: row.mark.atMs, source: row.mark.source, reason: "QUOTE_TIMESTAMP_IN_FUTURE" });
        return false;
      }
      if (!row.quote.valid) {
        if (row.quote.reason) rejectedMarks.push({ atMs: row.mark.atMs, source: row.mark.source, reason: row.quote.reason });
        return false;
      }
      return true;
    })
    .map((row) => ({
      atMs: row.mark.atMs,
      bid: row.quote.bid as number,
      returnPct: round((((row.quote.bid as number) - entryAsk) / entryAsk) * 100, 4),
    }));

  if (!usable.length) {
    const out = insufficient("No fresh in-session exact-OCC bid marks exist at or after entry.");
    out.entryAsk = entryAsk;
    return out;
  }

  const returnsByHorizon: Record<string, number | null> = {};
  for (const minutes of ASYMMETRY_HORIZONS_MINUTES) {
    const target = input.entryAtMs + minutes * 60_000;
    const mark = usable.find((row) => row.atMs >= target);
    returnsByHorizon[`${minutes}m`] = mark ? mark.returnPct : null;
  }

  const returns = usable.map((row) => row.returnPct);
  const mfePct = Math.max(...returns);
  const maePct = Math.min(...returns);
  const finalMark = usable[usable.length - 1];

  const timeToMilestoneMs: Record<string, number | null> = {};
  for (const milestone of ASYMMETRY_MILESTONES_PCT) {
    const hit = usable.find((row) => row.returnPct >= milestone);
    timeToMilestoneMs[String(milestone)] = hit ? hit.atMs - input.entryAtMs : null;
  }

  const outsizedThresholdPct = OUTSIZED_THRESHOLDS_PCT.find((threshold) => mfePct >= threshold) ?? null;
  const label: AsymmetryOutcomeLabel = outsizedThresholdPct != null
    ? (`OUTSIZED_${outsizedThresholdPct}` as AsymmetryOutcomeLabel)
    : finalMark.returnPct >= ORDINARY_WIN_PCT ? "ORDINARY_WIN"
    : finalMark.returnPct > -FLAT_BAND_PCT ? "FLAT"
    : "FAILED";

  return {
    candidateId: input.candidateId,
    occSymbol: input.occSymbol,
    label,
    outsizedThresholdPct,
    entryAsk,
    entryAtMs: input.entryAtMs,
    returnsByHorizon,
    mfePct,
    maePct,
    finalVerifiedReturnPct: finalMark.returnPct,
    finalVerifiedAtMs: finalMark.atMs,
    timeToMilestoneMs,
    outsizedMoveTiming: classifyMoveTiming(outsizedThresholdPct, usable, input.premiumChase ?? null),
    // Every usable mark is by construction a fresh, in-session, exact-OCC
    // executable quote, so this is exactly "a real exit price was observable".
    freshExecutableExitQuote: usable.length > 0,
    usableMarkCount: usable.length,
    rejectedMarks,
    limitation: null,
  };
}

/**
 * Was the outsized move still available AFTER the premium had already run, or
 * had the chase already consumed it?
 *
 * Measured by re-grading the same verified peak bid against the earliest valid
 * executable ask. If the threshold is reached from the pre-chase baseline but
 * NOT from the candidate's own ask, the move was consumed by the chase.
 */
function classifyMoveTiming(
  outsizedThresholdPct: number | null,
  usable: Array<{ bid: number }>,
  chase: PremiumChaseAnalysis | null,
): OutsizedMoveTiming {
  if (outsizedThresholdPct != null) return "SURVIVED_PREMIUM_CHASE";
  if (chase == null || chase.earliestAsk == null || chase.earliestAsk <= 0) return "UNKNOWN";
  const peakBid = Math.max(...usable.map((row) => row.bid));
  const preChaseMfePct = ((peakBid - chase.earliestAsk) / chase.earliestAsk) * 100;
  const reachedBeforeChase = OUTSIZED_THRESHOLDS_PCT.some((threshold) => preChaseMfePct >= threshold);
  return reachedBeforeChase ? "CONSUMED_BY_PREMIUM_CHASE" : "NO_OUTSIZED_MOVE";
}

/** Counts per label. Every label is always present, including the zero ones. */
export function outcomeLabelCounts(outcomes: AsymmetryOutcome[]): Record<AsymmetryOutcomeLabel, number> {
  const counts = Object.fromEntries(ASYMMETRY_OUTCOME_LABELS.map((l) => [l, 0])) as Record<AsymmetryOutcomeLabel, number>;
  for (const outcome of outcomes) counts[outcome.label] += 1;
  return counts;
}

export function isOutsized(label: AsymmetryOutcomeLabel): boolean {
  return OUTSIZED_LABELS.includes(label);
}
