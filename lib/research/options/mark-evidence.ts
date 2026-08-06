/**
 * Outcome-evidence quality for option paper positions.
 *
 * WHY THIS EXISTS
 *
 * `recordObservedMark` sets MFE and MAE from `MAX(return_pct)` and `MIN(return_pct)` over
 * `options_paper_marks`. That is correct arithmetic over a real series — but over a series
 * of ONE it makes MFE and MAE identical, and the position's single mark is then reported
 * as though it were a full excursion history. Production carries segments where 55-89% of
 * priced rows are in exactly that state.
 *
 * A trade does not have "real MFE/MAE" because a mark exists. It has real MFE/MAE when
 * there are at least two DISTINCT post-entry observations at DISTINCT times, because an
 * excursion is a statement about a path, and one point is not a path.
 *
 * PURE. No I/O, no clock, no env. Callers supply rows.
 */

export type MarkEvidenceState =
  /** No post-entry observation at all. Entry is known; nothing after it is. */
  | "ENTRY_ONLY"
  /** Exactly one post-entry observation. A point, not a path — MFE/MAE are NOT derivable. */
  | "SINGLE_POST_ENTRY_MARK"
  /** Two or more distinct observations, but sparse relative to the holding period. */
  | "MULTI_MARK_PARTIAL"
  /** Dense enough through the holding period to trust the trajectory. */
  | "CONTINUOUS_RTH_MARKING"
  /** Marked through to a recorded exit. */
  | "COMPLETE_TO_EXIT"
  /** Rebuilt from a persisted contemporaneous quote series. */
  | "HISTORICAL_RECONSTRUCTED"
  /** Rebuilt, but with gaps that leave the extremes uncertain. */
  | "HISTORICAL_PARTIAL"
  /** Marks were attempted and the quote was never available. */
  | "QUOTE_UNAVAILABLE"
  /** Marks were skipped because optional provider capacity was exhausted. */
  | "PROVIDER_BUDGET_BLOCKED"
  /** Observations exist but are too old to describe the holding period. */
  | "STALE_MARKS"
  /** Observations exist but their timestamps are unusable. */
  | "INVALID_TIMESTAMPS"
  /** Predates the marking subsystem entirely. */
  | "LEGACY_NO_MARKING"
  /** Present but not classifiable. */
  | "INSUFFICIENT_EVIDENCE";

/** Which metrics a given evidence state is allowed to support. */
export interface MetricPermissions {
  /** Realized return from entry ask to exit bid. Independent of excursion history. */
  realizedReturn: boolean;
  /** Peak favorable excursion. Needs a path. */
  mfe: boolean;
  /** Worst adverse excursion. Needs a path. */
  mae: boolean;
  /** "Never gained 5%" — needs enough EARLY marks to know what happened early. */
  immediateFailure: boolean;
  /** +25/+50/+100 attainment. Needs the same path evidence as MFE. */
  attainment: boolean;
}

export interface MarkRow {
  markAtMs: number | null;
  returnPct: number | null;
  bid: number | null;
  ask: number | null;
  quoteAgeMs: number | null;
}

export interface TradeMarkInput {
  tradeId: number;
  enteredAtMs: number | null;
  exitAtMs: number | null;
  status: string | null;
  entryFill: number | null;
  marks: MarkRow[];
  /** Set when the marking subsystem provably could not run for this row. */
  knownBlocker?: "QUOTE_UNAVAILABLE" | "PROVIDER_BUDGET_BLOCKED" | "LEGACY_NO_MARKING" | null;
}

export interface MarkEvidence {
  tradeId: number;
  state: MarkEvidenceState;
  /** Total mark rows stored. */
  markCount: number;
  /** Marks strictly after entry with a usable timestamp and return. */
  usablePostEntryMarks: number;
  /** Distinct observation TIMES among usable marks. Two marks at one instant are one point. */
  distinctObservationTimes: number;
  /** Milliseconds between first and last usable post-entry observation. */
  observationSpanMs: number | null;
  /** Milliseconds the position was actually held, when knowable. */
  holdingPeriodMs: number | null;
  /** Fraction of the holding period covered by observations. */
  coverage: number | null;
  /** Marks inside the first 15 minutes — what "immediate failure" actually needs. */
  earlyMarks: number;
  permissions: MetricPermissions;
  /** MFE/MAE recomputed from the usable series only. Null when unsupported. */
  verifiedMfePct: number | null;
  verifiedMaePct: number | null;
  reasons: string[];
}

/**
 * Two distinct observations is the floor for an excursion, because MAX and MIN over a
 * single point are that point, which is what produced the MFE == MAE artifact.
 */
export const MIN_MARKS_FOR_EXCURSION = 2;

/**
 * "Never gained more than 5%" is a claim about the early life of a trade. Making it from
 * marks that all arrived an hour later would be describing a different question.
 */
export const EARLY_WINDOW_MS = 15 * 60_000;
export const MIN_EARLY_MARKS_FOR_IMMEDIATE_FAILURE = 2;

/** Coverage above this is treated as a trustworthy trajectory rather than a sample. */
export const CONTINUOUS_COVERAGE = 0.6;

const NO_PERMISSIONS: MetricPermissions = Object.freeze({
  realizedReturn: false, mfe: false, mae: false, immediateFailure: false, attainment: false,
});

export function classifyMarkEvidence(input: TradeMarkInput): MarkEvidence {
  const reasons: string[] = [];
  const markCount = input.marks.length;

  // A realized return needs an entry price and a closed position — nothing about the path.
  // This is deliberately independent: a verified loss stays a verified loss even when the
  // trajectory that produced it was never recorded.
  const hasEntry = input.entryFill != null && input.entryFill > 0;
  const closed = String(input.status ?? "").toUpperCase() === "EXITED" || input.exitAtMs != null;
  const realizedReturn = hasEntry && closed;

  const base = (state: MarkEvidenceState, extra: Partial<MarkEvidence> = {}): MarkEvidence => ({
    tradeId: input.tradeId,
    state,
    markCount,
    usablePostEntryMarks: 0,
    distinctObservationTimes: 0,
    observationSpanMs: null,
    holdingPeriodMs: input.enteredAtMs != null && input.exitAtMs != null
      ? input.exitAtMs - input.enteredAtMs : null,
    coverage: null,
    earlyMarks: 0,
    permissions: { ...NO_PERMISSIONS, realizedReturn },
    verifiedMfePct: null,
    verifiedMaePct: null,
    reasons,
    ...extra,
  });

  if (input.knownBlocker) {
    reasons.push(`marking blocked: ${input.knownBlocker}`);
    return base(input.knownBlocker);
  }

  const usable = input.marks.filter((m) =>
    m.markAtMs != null
    && Number.isFinite(m.markAtMs)
    && m.returnPct != null
    && Number.isFinite(m.returnPct)
    && (input.enteredAtMs == null || m.markAtMs > input.enteredAtMs));

  const badTimestamps = input.marks.filter((m) => m.markAtMs == null || !Number.isFinite(m.markAtMs));
  if (markCount > 0 && badTimestamps.length === markCount) {
    reasons.push("every stored mark has an unusable timestamp");
    return base("INVALID_TIMESTAMPS");
  }

  if (!usable.length) {
    reasons.push(markCount
      ? `${markCount} mark(s) stored but none is a usable post-entry observation`
      : "no marks stored");
    return base("ENTRY_ONLY");
  }

  const times = [...new Set(usable.map((m) => m.markAtMs as number))].sort((a, b) => a - b);
  const distinctObservationTimes = times.length;
  const observationSpanMs = times.length > 1 ? times[times.length - 1] - times[0] : 0;
  const holdingPeriodMs = input.enteredAtMs != null && input.exitAtMs != null
    ? Math.max(0, input.exitAtMs - input.enteredAtMs)
    : null;
  const coverage = holdingPeriodMs && holdingPeriodMs > 0
    ? Math.min(1, observationSpanMs / holdingPeriodMs)
    : null;
  const earlyMarks = input.enteredAtMs == null
    ? 0
    : new Set(usable
      .filter((m) => (m.markAtMs as number) - (input.enteredAtMs as number) <= EARLY_WINDOW_MS)
      .map((m) => m.markAtMs as number)).size;

  // One point is not a path. This is the exact artifact that made MFE == MAE.
  if (distinctObservationTimes < MIN_MARKS_FOR_EXCURSION) {
    reasons.push(
      `only ${distinctObservationTimes} distinct post-entry observation — MAX and MIN over one point are that point, so MFE/MAE are not derivable`,
    );
    return base("SINGLE_POST_ENTRY_MARK", {
      usablePostEntryMarks: usable.length,
      distinctObservationTimes,
      observationSpanMs,
      coverage,
      earlyMarks,
    });
  }

  const returns = usable.map((m) => m.returnPct as number);
  const verifiedMfePct = +Math.max(...returns).toFixed(6);
  const verifiedMaePct = +Math.min(...returns).toFixed(6);

  const immediateFailure = earlyMarks >= MIN_EARLY_MARKS_FOR_IMMEDIATE_FAILURE;
  if (!immediateFailure) {
    reasons.push(
      `${earlyMarks} observation(s) inside the first ${EARLY_WINDOW_MS / 60_000} minutes — too few to claim what happened early`,
    );
  }

  const permissions: MetricPermissions = {
    realizedReturn,
    mfe: true,
    mae: true,
    attainment: true,
    immediateFailure,
  };

  let state: MarkEvidenceState;
  if (closed && coverage != null && coverage >= CONTINUOUS_COVERAGE) {
    state = "COMPLETE_TO_EXIT";
  } else if (coverage != null && coverage >= CONTINUOUS_COVERAGE) {
    state = "CONTINUOUS_RTH_MARKING";
  } else {
    state = "MULTI_MARK_PARTIAL";
    reasons.push(coverage == null
      ? "holding period unknown, so trajectory completeness cannot be established"
      : `observations span ${(coverage * 100).toFixed(0)}% of the holding period`);
  }

  return base(state, {
    usablePostEntryMarks: usable.length,
    distinctObservationTimes,
    observationSpanMs,
    coverage,
    earlyMarks,
    permissions,
    verifiedMfePct,
    verifiedMaePct,
  });
}

/** States whose excursion numbers may be used in aggregate reporting. */
export const EXCURSION_TRUSTWORTHY: ReadonlySet<MarkEvidenceState> = new Set<MarkEvidenceState>([
  "MULTI_MARK_PARTIAL",
  "CONTINUOUS_RTH_MARKING",
  "COMPLETE_TO_EXIT",
  "HISTORICAL_RECONSTRUCTED",
]);

export function excursionIsTrustworthy(state: MarkEvidenceState): boolean {
  return EXCURSION_TRUSTWORTHY.has(state);
}

export interface MarkEvidenceDistribution {
  total: number;
  byState: Record<string, number>;
  excursionTrustworthy: number;
  excursionUntrustworthy: number;
  realizedUsable: number;
  immediateFailureUsable: number;
  medianDistinctObservations: number | null;
  medianCoverage: number | null;
}

export function summariseMarkEvidence(rows: MarkEvidence[]): MarkEvidenceDistribution {
  const byState: Record<string, number> = {};
  for (const r of rows) byState[r.state] = (byState[r.state] ?? 0) + 1;
  const med = (xs: number[]): number | null => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : +(((s[m - 1] + s[m]) / 2).toFixed(4));
  };
  return {
    total: rows.length,
    byState,
    excursionTrustworthy: rows.filter((r) => excursionIsTrustworthy(r.state)).length,
    excursionUntrustworthy: rows.filter((r) => !excursionIsTrustworthy(r.state)).length,
    realizedUsable: rows.filter((r) => r.permissions.realizedReturn).length,
    immediateFailureUsable: rows.filter((r) => r.permissions.immediateFailure).length,
    medianDistinctObservations: med(rows.map((r) => r.distinctObservationTimes)),
    medianCoverage: med(rows.map((r) => r.coverage).filter((c): c is number => c != null)),
  };
}
