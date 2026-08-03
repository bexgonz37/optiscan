/**
 * entry-quality-decomposition.ts — separate MEASUREMENT artifacts from GENUINE
 * signal failure in delivered-alert performance. PURE. No DB, no network, no AI.
 *
 * WHY THIS EXISTS. The Quant Lab reported win rate 18.8 %, median −44.8 %,
 * profit factor 0.335 and MFE −24.6 % over 357 delivered alerts. Acting on that
 * aggregate would have been a mistake, because it silently mixes at least four
 * different things:
 *
 *   1. the fill convention (entry = MID, exit = 60 % toward the BID),
 *   2. a symmetric ±45 % bracket that is arithmetically unsurvivable at the
 *      observed win rate,
 *   3. a degenerate mark series — 84 % of trades carry ONE mark reused across
 *      every horizon bucket, so "return at 1m" is not a 1-minute measurement,
 *   4. an unverified population — 471 of 553 rows fail the paper-chain
 *      verifier, yet the Quant Lab query does not filter on verification.
 *
 * Each function below isolates ONE of those so a conclusion can name its cause.
 * Nothing here changes a threshold, a gate, or any delivered behaviour.
 */

export const DECOMPOSITION_VERSION = "ENTRY_QUALITY_DECOMP_V1" as const;

// ── 1. FILL CONVENTION ─────────────────────────────────────────────────────

/**
 * The conventions actually in use, read from source rather than assumed:
 *   entry  = `i.entry.mid`                       (delivery.ts)
 *   exit   = `mid - (mid - bid) * 0.6`           (paper.ts::realOptionExit)
 *
 * `ASK_TO_BID` and `MID_TO_MID` exist ONLY as diagnostic comparisons. They must
 * never replace the official conservative result.
 */
export type FillConvention = "OFFICIAL_MID_TO_60PCT_BID" | "ASK_TO_BID" | "ASK_TO_ASK" | "MID_TO_MID";

export const OFFICIAL_CONVENTION: FillConvention = "OFFICIAL_MID_TO_60PCT_BID";

/** Fraction of the way from mid toward the bid that the exit fill sits. */
export const EXIT_BID_LEAN = 0.6;

export interface Quote { bid: number; ask: number }

const mid = (q: Quote): number => (q.bid + q.ask) / 2;

/** Spread as a percentage of mid — the repo's own definition (paper.ts:58). */
export function spreadPct(q: Quote): number | null {
  const m = mid(q);
  return m > 0 ? ((q.ask - q.bid) / m) * 100 : null;
}

/** Entry fill under a convention. Null when the quote cannot support it. */
export function entryFillFor(convention: FillConvention, q: Quote): number | null {
  if (!(q.bid >= 0) || !(q.ask > 0) || q.ask < q.bid) return null;
  switch (convention) {
    case "OFFICIAL_MID_TO_60PCT_BID":
    case "MID_TO_MID": return mid(q);
    case "ASK_TO_BID":
    case "ASK_TO_ASK": return q.ask;
  }
}

/** Exit fill under a convention. */
export function exitFillFor(convention: FillConvention, q: Quote): number | null {
  if (!(q.bid >= 0) || !(q.ask > 0) || q.ask < q.bid) return null;
  const m = mid(q);
  switch (convention) {
    case "OFFICIAL_MID_TO_60PCT_BID": return m - (m - q.bid) * EXIT_BID_LEAN;
    case "ASK_TO_BID": return q.bid;
    case "ASK_TO_ASK": return q.ask;
    case "MID_TO_MID": return m;
  }
}

/**
 * The drag incurred at time ZERO — entering and immediately exiting on the SAME
 * quote. This is the part of a loss that is pure convention and contains no
 * information about whether the setup worked.
 *
 * For the official convention this is exactly `-0.3 x spreadPct`, because the
 * exit sits 60 % of a half-spread below mid. A 10 % spread costs 3 %, not 10 %.
 * That is far too small to explain a −24.6 % MFE, which is why the "it is all
 * spread" hypothesis fails.
 */
export function immediateDragPct(convention: FillConvention, q: Quote): number | null {
  const entry = entryFillFor(convention, q);
  const exit = exitFillFor(convention, q);
  if (entry == null || exit == null || !(entry > 0)) return null;
  return round4(((exit - entry) / entry) * 100);
}

/** Return under a convention, given an entry quote and an exit quote. */
export function returnPctFor(convention: FillConvention, entryQuote: Quote, exitQuote: Quote): number | null {
  const entry = entryFillFor(convention, entryQuote);
  const exit = exitFillFor(convention, exitQuote);
  if (entry == null || exit == null || !(entry > 0)) return null;
  return round4(((exit - entry) / entry) * 100);
}

export interface ConventionComparison {
  official: number | null;
  askToBid: number | null;
  askToAsk: number | null;
  midToMid: number | null;
  /** official minus askToAsk — the portion attributable to the spread crossing. */
  spreadAttributablePts: number | null;
  version: string;
}

/**
 * All four conventions side by side. The OFFICIAL value is always reported
 * first and is never replaced; the others exist so the spread component can be
 * quantified rather than argued about.
 */
export function compareConventions(entryQuote: Quote, exitQuote: Quote): ConventionComparison {
  const official = returnPctFor("OFFICIAL_MID_TO_60PCT_BID", entryQuote, exitQuote);
  const askToAsk = returnPctFor("ASK_TO_ASK", entryQuote, exitQuote);
  return {
    official,
    askToBid: returnPctFor("ASK_TO_BID", entryQuote, exitQuote),
    askToAsk,
    midToMid: returnPctFor("MID_TO_MID", entryQuote, exitQuote),
    spreadAttributablePts: official != null && askToAsk != null ? round4(official - askToAsk) : null,
    version: DECOMPOSITION_VERSION,
  };
}

// ── 2. BRACKET ARITHMETIC ──────────────────────────────────────────────────

export interface BracketAnalysis {
  winRate: number;
  targetPct: number;
  stopPct: number;
  riskRewardRatio: number | null;
  /** Expectancy implied by the bracket alone, ignoring everything else. */
  impliedExpectancyPct: number;
  /** Win rate needed to break even at this bracket. */
  breakevenWinRate: number | null;
  /** Target needed to break even at the observed win rate. */
  breakevenTargetPct: number | null;
  survivable: boolean;
  note: string;
}

/**
 * Is the bracket survivable at the observed win rate?
 *
 * This is the single most important calculation in the checkpoint. Production
 * runs a SYMMETRIC bracket — median target +44.94 %, median stop −44.94 %, a
 * 1:1 risk-reward — at an 18.3 % win rate. A 1:1 bracket needs a win rate above
 * 50 % simply to break even. No exit policy, spread fix, or signal tweak can
 * rescue that arithmetic; it is a structural defect, not a measurement one.
 */
export function analyzeBracket(winRate: number, targetPct: number, stopPct: number): BracketAnalysis {
  const w = Math.min(1, Math.max(0, winRate));
  const loss = Math.abs(stopPct);
  const rr = loss > 0 ? round4(targetPct / loss) : null;
  const impliedExpectancyPct = round4(w * targetPct - (1 - w) * loss);
  const breakevenWinRate = targetPct + loss > 0 ? round4(loss / (targetPct + loss)) : null;
  const breakevenTargetPct = w > 0 ? round4(((1 - w) / w) * loss) : null;
  const survivable = impliedExpectancyPct > 0;
  return {
    winRate: round4(w), targetPct: round4(targetPct), stopPct: round4(stopPct),
    riskRewardRatio: rr, impliedExpectancyPct, breakevenWinRate, breakevenTargetPct, survivable,
    note: survivable
      ? "Bracket is survivable at this win rate."
      : `Bracket is NOT survivable: it needs a ${breakevenWinRate != null ? (breakevenWinRate * 100).toFixed(1) : "?"}% win rate, or a target of ~${breakevenTargetPct != null ? breakevenTargetPct.toFixed(0) : "?"}% against this stop.`,
  };
}

// ── 3. MARK-SERIES INTEGRITY ───────────────────────────────────────────────

export type MarkSeriesIntegrity = "USABLE" | "DEGENERATE_SINGLE_MARK" | "SPARSE" | "EMPTY";

export interface MarkSeriesAudit {
  horizons: number;
  distinctValues: number;
  integrity: MarkSeriesIntegrity;
  /** True when horizon buckets cannot be read as time-separated observations. */
  horizonsUnreliable: boolean;
  note: string;
}

/**
 * Detect a degenerate horizon series.
 *
 * When a position has one usable mark, every horizon bucket is filled with the
 * SAME value. The series then looks like a flat time series when it is really a
 * single observation repeated, and "the position did not deteriorate after
 * entry" becomes an artifact rather than a finding. Measured in production:
 * 84.1 % of verified trades are degenerate this way.
 */
export function auditMarkSeries(values: ReadonlyArray<number | null | undefined>): MarkSeriesAudit {
  const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const distinct = new Set(finite.map((v) => v.toFixed(4))).size;
  if (finite.length === 0) {
    return { horizons: 0, distinctValues: 0, integrity: "EMPTY", horizonsUnreliable: true, note: "No marks. Nothing is measurable." };
  }
  if (distinct === 1) {
    return {
      horizons: finite.length, distinctValues: 1, integrity: "DEGENERATE_SINGLE_MARK", horizonsUnreliable: true,
      note: "Every horizon carries the same value — one mark reused. Horizon-to-horizon comparisons are meaningless.",
    };
  }
  if (distinct <= 2) {
    return {
      horizons: finite.length, distinctValues: distinct, integrity: "SPARSE", horizonsUnreliable: true,
      note: "Two distinct marks across all horizons. Too sparse to read as a time series.",
    };
  }
  return { horizons: finite.length, distinctValues: distinct, integrity: "USABLE", horizonsUnreliable: false, note: "Series has enough distinct observations to compare horizons." };
}

// ── 4. SAMPLE INTEGRITY ────────────────────────────────────────────────────

export interface SampleIntegrity {
  total: number;
  verified: number;
  excluded: number;
  verifiedFraction: number | null;
  /** True when the majority of the population failed verification. */
  majorityUnverified: boolean;
  quotable: boolean;
  note: string;
}

/**
 * A performance number computed over an unverified population is not a
 * performance number. The Quant Lab query selects `status='EXITED' AND
 * return_pct IS NOT NULL` with NO verification filter, while the paper-chain
 * verifier rejects duplicates, stale marks, missing mirrors and unverified
 * entries/exits. In production that is 471 rejected of 553.
 */
export function assessSampleIntegrity(total: number, verified: number): SampleIntegrity {
  const excluded = Math.max(0, total - verified);
  const frac = total > 0 ? round4(verified / total) : null;
  const majorityUnverified = frac != null && frac < 0.5;
  return {
    total, verified, excluded, verifiedFraction: frac, majorityUnverified,
    quotable: frac != null && frac >= 0.8,
    note: frac == null
      ? "Empty sample."
      : majorityUnverified
        ? `Only ${(frac * 100).toFixed(1)}% verified — this population must NOT be quoted as performance.`
        : frac >= 0.8
          ? "Verified majority; quotable with the sample size stated."
          : `${(frac * 100).toFixed(1)}% verified — report with an explicit caveat.`,
  };
}

// ── 5. VERDICT ─────────────────────────────────────────────────────────────

export type Hypothesis =
  | "H1_MEASUREMENT_ARTIFACT_DOMINATES"
  | "H2_SIGNAL_FAILURE_DOMINATES"
  | "H3_BOTH_MATERIALLY_CONTRIBUTE"
  | "INSUFFICIENT_EVIDENCE";

export interface VerdictInput {
  /** Median immediate drag from the fill convention, percentage points. */
  medianImmediateDragPct: number | null;
  /** Median official realized return, percentage points. */
  medianRealizedPct: number | null;
  /** Fraction of trades whose MFE never exceeded zero. */
  neverProfitableFraction: number | null;
  /** Is the bracket survivable at the observed win rate? */
  bracketSurvivable: boolean | null;
  /**
   * How many trades actually passed verification. Sufficiency is judged on
   * this ABSOLUTE count, not on the verified fraction of a contaminated
   * superset — 82 clean trades support an attribution regardless of how many
   * dirty rows sit beside them, and treating a low fraction as "insufficient"
   * would discard the only trustworthy evidence available.
   */
  verifiedCount: number | null;
  /**
   * Fraction of trades whose horizon series is degenerate (one mark reused).
   *
   * This is a MEASUREMENT artifact that has nothing to do with spread: it does
   * not inflate the loss, it makes the loss unattributable in time. Modelling
   * only spread drag as "measurement" would have produced a confident
   * signal-failure verdict while 84 % of the evidence was a single repeated
   * observation — technically defensible and practically wrong.
   */
  degenerateMarkFraction?: number | null;
  /** True when most of the surrounding population failed verification. */
  majorityUnverified?: boolean | null;
}

/** Below this many verified trades, cause cannot be attributed. */
export const MIN_VERIFIED_FOR_VERDICT = 30;
/** Above this share of degenerate mark series, measurement is materially impaired. */
export const DEGENERATE_MARK_MATERIAL_THRESHOLD = 0.5;

/**
 * Deterministic verdict. Total and single-valued.
 *
 * A structurally unsurvivable bracket is treated as SIGNAL-SIDE, not
 * measurement-side: it is a real property of what was delivered to
 * subscribers, and no change to how it is measured makes it survivable.
 */
export function decideHypothesis(input: VerdictInput): { hypothesis: Hypothesis; rationale: string } {
  const {
    medianImmediateDragPct: drag, medianRealizedPct: realized,
    neverProfitableFraction: never, bracketSurvivable, verifiedCount,
  } = input;

  if (realized == null || never == null || bracketSurvivable == null) {
    return { hypothesis: "INSUFFICIENT_EVIDENCE", rationale: "Realized return, never-profitable fraction and bracket survivability are all required." };
  }
  if (verifiedCount == null || verifiedCount < MIN_VERIFIED_FOR_VERDICT) {
    return { hypothesis: "INSUFFICIENT_EVIDENCE", rationale: `Only ${verifiedCount ?? 0} verified trades — below the ${MIN_VERIFIED_FOR_VERDICT} needed to attribute cause.` };
  }

  const dragShare = drag != null && realized < 0 ? Math.abs(drag) / Math.abs(realized) : null;
  const degenerate = input.degenerateMarkFraction ?? null;

  // Measurement impairment has TWO independent forms. Spread drag distorts the
  // magnitude of the loss; degenerate marks and an unverified population
  // distort its attributability. Either one alone is material.
  const dragHeavy = dragShare != null && dragShare >= 0.6;
  const evidenceImpaired = (degenerate != null && degenerate >= DEGENERATE_MARK_MATERIAL_THRESHOLD)
    || input.majorityUnverified === true;
  const measurementMaterial = dragHeavy || evidenceImpaired;
  const signalHeavy = !bracketSurvivable || never >= 0.5;

  const dragTxt = dragShare != null ? `${(dragShare * 100).toFixed(0)}%` : "an unmeasured share";
  const impairTxt = [
    degenerate != null && degenerate >= DEGENERATE_MARK_MATERIAL_THRESHOLD ? `${(degenerate * 100).toFixed(0)}% of mark series are degenerate` : null,
    input.majorityUnverified === true ? "the surrounding population is majority-unverified" : null,
  ].filter(Boolean).join(" and ");

  if (measurementMaterial && !signalHeavy) {
    return { hypothesis: "H1_MEASUREMENT_ARTIFACT_DOMINATES", rationale: `Convention drag accounts for ${dragTxt} of the realized loss${impairTxt ? `, and ${impairTxt}` : ""}, while the bracket is survivable and most trades traded profitably at some point.` };
  }
  if (signalHeavy && !measurementMaterial) {
    return { hypothesis: "H2_SIGNAL_FAILURE_DOMINATES", rationale: `${(never * 100).toFixed(0)}% never traded profitably${bracketSurvivable ? "" : " and the bracket is arithmetically unsurvivable"}; convention drag explains only ${dragTxt} and the evidence is otherwise sound.` };
  }
  if (signalHeavy && measurementMaterial) {
    return { hypothesis: "H3_BOTH_MATERIALLY_CONTRIBUTE", rationale: `Signal side: ${(never * 100).toFixed(0)}% never traded profitably${bracketSurvivable ? "" : " against an arithmetically unsurvivable bracket"}. Measurement side: convention drag explains ${dragTxt}${impairTxt ? `, and ${impairTxt}` : ""}.` };
  }
  return { hypothesis: "INSUFFICIENT_EVIDENCE", rationale: "Neither measurement nor signal effects reached a decisive threshold." };
}

function round4(n: number): number { return Math.round(n * 10_000) / 10_000; }
