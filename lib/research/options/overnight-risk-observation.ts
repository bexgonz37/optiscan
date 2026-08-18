/**
 * OVERNIGHT RISK — OBSERVATION ONLY. No stop is changed, proposed, or implied.
 *
 * THE SHAPE OF THE PROBLEM
 *
 * 42 of 74 owner callouts crossed a session boundary, 36 carried a measured between-session
 * gap, and 13 filled materially below the frozen stop. The obvious conclusion — close
 * everything before the bell — is the one this module is built to refuse, because some
 * `EVENTUAL_T1_WINNER` trades only reach Target 1 by being held. A policy read off the gap
 * statistics alone would eliminate the overnight losses and the overnight winners together,
 * and would report only the first half.
 *
 * So `winnersThatRequiredTheHold` is computed FIRST and returned unconditionally: the count of
 * trades that were NOT yet at their eventual outcome by the first close and went on to win. A
 * caller cannot obtain the gap distribution from this module without also obtaining what a
 * flat close-before-the-bell rule would have destroyed.
 *
 * WHAT IS MEASURED
 *
 * For each closed callout: whether it was held, its state at the last mark before the first
 * session boundary (return, running peak, distance to the frozen stop), its state at the first
 * mark of the next session, the gap between them, and the slippage between the frozen stop and
 * the actual exit fill. Entry time, DTE, strategy, side and selection strength come along so
 * the question "which held trades are the dangerous ones" can be asked conditionally.
 *
 * WHAT IS NOT PRODUCED
 *
 * A stop level, a cutoff time, a hold/close rule, or a recommendation. `conditionalPolicy`
 * exists only to state that none is proposed and what would be required first.
 *
 * PURE. No I/O, no clock, no env. Nothing here is read by any exit or stop path.
 */

export interface OvernightMark {
  atMs: number | null;
  returnPct: number | null;
  /** The observed contract price at this mark, for comparison against the frozen stop. */
  exitFill: number | null;
}

export type OvernightOutcome =
  | "EVENTUAL_T1_WINNER"
  | "GOOD_MOVE_THEN_REVERSED"
  | "OTHER_CLOSED"
  | "UNGRADED";

export interface OvernightCaseInput {
  opportunityCaseId: string;
  symbol: string | null;
  optionSymbol: string | null;
  side: "CALL" | "PUT" | null;
  strategyKey: string | null;
  sessionDate: string | null;
  exitSessionDate: string | null;
  dte: number | null;
  selectionStrength: number | null;
  /** The stop the callout froze. Never recomputed. */
  stopLevel: number | null;
  entryAtMs: number | null;
  closedAtMs: number | null;
  exitFill: number | null;
  realizedReturnPct: number | null;
  outcome: OvernightOutcome;
  marks: readonly OvernightMark[];
  occExact: boolean;
}

export interface OvernightCase {
  opportunityCaseId: string;
  symbol: string | null;
  optionSymbol: string | null;
  side: "CALL" | "PUT" | null;
  strategyKey: string | null;
  sessionDate: string | null;
  dte: number | null;
  selectionStrength: number | null;
  /** ET minute of day the position was opened. Null when it cannot be resolved. */
  entryMinuteOfSession: number | null;

  heldOvernight: boolean;
  /** Distinct trading sessions the mark series touched. 1 = same-day. */
  sessionsSpanned: number;

  // ── the last observation before the first session boundary ────────────────
  returnPctBeforeFirstClose: number | null;
  peakPctBeforeFirstClose: number | null;
  /** (lastFill − stop) / stop as a percentage. Positive = still above the frozen stop. */
  cushionToStopBeforeClosePct: number | null;

  // ── the first observation of the next session ─────────────────────────────
  returnPctAtNextOpen: number | null;
  /** returnPctAtNextOpen − returnPctBeforeFirstClose, in points. Negative = adverse gap. */
  overnightGapPct: number | null;
  /** True when the next session opened already below the frozen stop. */
  gappedThroughStop: boolean | null;

  // ── the outcome ───────────────────────────────────────────────────────────
  realizedReturnPct: number | null;
  /** (exit − stop) / stop in percent. Negative = filled below the intended stop. */
  stopSlippagePct: number | null;
  outcome: OvernightOutcome;
  /**
   * True when the trade was NOT already a winner at the first close and won anyway.
   * The reason a flat close-before-the-bell rule cannot be read off the gap statistics.
   */
  requiredTheHold: boolean;

  limitations: string[];
}

const r4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/**
 * Measure one callout's overnight exposure.
 *
 * `tradingDayOf` is injected so the ET boundary is resolved by the repository's single
 * implementation. Resolving it here in UTC would move every post-20:00 ET entry into the
 * next day and manufacture overnight holds that never happened.
 */
export function observeOvernight(
  input: OvernightCaseInput,
  tradingDayOf: (ms: number) => string,
  minuteOfSession: (ms: number) => number | null,
): OvernightCase {
  const limitations: string[] = [];
  const base = {
    opportunityCaseId: input.opportunityCaseId,
    symbol: input.symbol,
    optionSymbol: input.optionSymbol,
    side: input.side,
    strategyKey: input.strategyKey,
    sessionDate: input.sessionDate,
    dte: input.dte,
    selectionStrength: input.selectionStrength,
    realizedReturnPct: input.realizedReturnPct,
    outcome: input.outcome,
  };

  const empty = (why: string): OvernightCase => ({
    ...base,
    entryMinuteOfSession: input.entryAtMs == null ? null : minuteOfSession(input.entryAtMs),
    heldOvernight: false, sessionsSpanned: 0,
    returnPctBeforeFirstClose: null, peakPctBeforeFirstClose: null, cushionToStopBeforeClosePct: null,
    returnPctAtNextOpen: null, overnightGapPct: null, gappedThroughStop: null,
    stopSlippagePct: null, requiredTheHold: false,
    limitations: [why],
  });

  if (!input.occExact) return empty("marks are not on the contract the callout froze");
  const entryMs = input.entryAtMs;
  if (entryMs == null) return empty("the trade has no entry instant");

  const marks = input.marks
    .filter((m): m is { atMs: number; returnPct: number; exitFill: number | null } =>
      m.atMs != null && m.returnPct != null && Number.isFinite(m.atMs) && Number.isFinite(m.returnPct) && m.atMs >= entryMs)
    .sort((a, b) => a.atMs - b.atMs);
  if (!marks.length) return empty("no same-contract marks after entry");

  const entryDay = tradingDayOf(entryMs);
  const days = [...new Set(marks.map((m) => tradingDayOf(m.atMs)))];
  const sessionsSpanned = days.length;
  const heldOvernight = days.some((d) => d !== entryDay);

  const entryMinuteOfSession = minuteOfSession(entryMs);

  // The stop-slippage figure does not need an overnight hold and is measured either way.
  const stopSlippagePct =
    input.stopLevel != null && input.stopLevel > 0 && input.exitFill != null
      ? r4(((input.exitFill - input.stopLevel) / input.stopLevel) * 100)
      : null;
  if (stopSlippagePct == null && input.stopLevel == null) {
    limitations.push("the callout froze no stop, so slippage against it cannot be measured");
  }

  if (!heldOvernight) {
    return {
      ...base, entryMinuteOfSession, heldOvernight: false, sessionsSpanned,
      returnPctBeforeFirstClose: null, peakPctBeforeFirstClose: null, cushionToStopBeforeClosePct: null,
      returnPctAtNextOpen: null, overnightGapPct: null, gappedThroughStop: null,
      stopSlippagePct, requiredTheHold: false,
      limitations,
    };
  }

  // The boundary: the last mark on the ENTRY session, and the first mark after it.
  const lastBefore = [...marks].reverse().find((m) => tradingDayOf(m.atMs) === entryDay) ?? null;
  const firstAfter = marks.find((m) => lastBefore != null && m.atMs > lastBefore.atMs) ?? null;

  const beforeSlice = lastBefore ? marks.filter((m) => m.atMs <= lastBefore.atMs) : [];
  const peakBefore = beforeSlice.length ? Math.max(...beforeSlice.map((m) => m.returnPct)) : null;

  const cushion =
    lastBefore?.exitFill != null && input.stopLevel != null && input.stopLevel > 0
      ? r4(((lastBefore.exitFill - input.stopLevel) / input.stopLevel) * 100)
      : null;
  if (cushion == null) limitations.push("no priced mark before the first close, so cushion to the frozen stop is unmeasured");

  const gap =
    lastBefore != null && firstAfter != null ? r4(firstAfter.returnPct - lastBefore.returnPct) : null;
  if (gap == null) limitations.push("no mark on the far side of the boundary, so the gap is unmeasured");

  const gappedThroughStop =
    firstAfter?.exitFill != null && input.stopLevel != null ? firstAfter.exitFill < input.stopLevel : null;

  // "Required the hold" means: not yet at its eventual result by the first close, and it won.
  // Deliberately conservative — a trade already above its realized return at the close did NOT
  // need the hold, and counting it would inflate the case for holding.
  const won = input.realizedReturnPct != null && input.realizedReturnPct > 0;
  const requiredTheHold =
    won && lastBefore != null && input.realizedReturnPct != null
      ? lastBefore.returnPct < input.realizedReturnPct
      : false;

  return {
    ...base,
    entryMinuteOfSession,
    heldOvernight: true,
    sessionsSpanned,
    returnPctBeforeFirstClose: lastBefore ? r4(lastBefore.returnPct) : null,
    peakPctBeforeFirstClose: peakBefore == null ? null : r4(peakBefore),
    cushionToStopBeforeClosePct: cushion,
    returnPctAtNextOpen: firstAfter ? r4(firstAfter.returnPct) : null,
    overnightGapPct: gap,
    gappedThroughStop,
    stopSlippagePct,
    requiredTheHold,
    limitations,
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface HoldingArm {
  label: "SAME_DAY" | "HELD_OVERNIGHT";
  n: number;
  winners: number;
  losses: number;
  winRate: number | null;
  meanReturnPct: number | null;
  medianReturnPct: number | null;
  profitFactor: number | null;
}

export interface GapProfile {
  n: number;
  medianGapPct: number | null;
  worstGapPct: number | null;
  bestGapPct: number | null;
  adverseGaps: number;
  favourableGaps: number;
  gappedThroughStop: number;
  medianStopSlippagePct: number | null;
  materialStopBreaches: number;
}

export interface ConditionalCut {
  key: string;
  heldN: number;
  heldMeanReturnPct: number | null;
  heldProfitFactor: number | null;
  winnersThatRequiredTheHold: number;
}

export interface OvernightObservationReport {
  version: "OVERNIGHT_RISK_OBSERVATION_V1";
  productionBehaviorChanged: false;
  /**
   * Returned FIRST and unconditionally. A flat "close everything before the bell" rule
   * destroys exactly these trades, and no caller may read the gap statistics without it.
   */
  winnersThatRequiredTheHold: number;
  winnerReturnPointsThatRequiredTheHold: number;
  sameDay: HoldingArm;
  overnight: HoldingArm;
  gaps: GapProfile;
  byEntryHour: ConditionalCut[];
  byStrategy: ConditionalCut[];
  bySide: ConditionalCut[];
  byDte: ConditionalCut[];
  conditionalPolicy: {
    /** Always false. A conditional rule requires prospective evidence this has never had. */
    policyProposed: false;
    mustNotConcludeThat: string;
    requirements: readonly string[];
  };
  limitations: readonly string[];
}

function arm(label: HoldingArm["label"], rows: readonly OvernightCase[]): HoldingArm {
  const v = rows.map((r) => r.realizedReturnPct).filter((x): x is number => x != null && Number.isFinite(x));
  if (!v.length) {
    return { label, n: 0, winners: 0, losses: 0, winRate: null, meanReturnPct: null, medianReturnPct: null, profitFactor: null };
  }
  const w = v.filter((x) => x > 0), l = v.filter((x) => x <= 0);
  const gross = w.reduce((s, x) => s + x, 0), lossSum = -l.reduce((s, x) => s + x, 0);
  const sorted = [...v].sort((a, b) => a - b);
  const m = sorted.length >> 1;
  return {
    label, n: v.length, winners: w.length, losses: l.length,
    winRate: r4(w.length / v.length),
    meanReturnPct: r4(v.reduce((s, x) => s + x, 0) / v.length),
    medianReturnPct: r4(sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2),
    profitFactor: lossSum > 0 ? r4(gross / lossSum) : null,
  };
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return r4(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}

function cut(keyOf: (c: OvernightCase) => string | null, held: readonly OvernightCase[]): ConditionalCut[] {
  const keys = [...new Set(held.map(keyOf).filter((k): k is string => k != null))].sort();
  return keys.map((key) => {
    const rows = held.filter((c) => keyOf(c) === key);
    const a = arm("HELD_OVERNIGHT", rows);
    return {
      key,
      heldN: a.n,
      heldMeanReturnPct: a.meanReturnPct,
      heldProfitFactor: a.profitFactor,
      winnersThatRequiredTheHold: rows.filter((c) => c.requiredTheHold).length,
    };
  });
}

/** Material stop breach threshold, in percent below the frozen stop. Shared with the owner lane. */
export const MATERIAL_STOP_BREACH_PCT = -5;

export function buildOvernightObservation(cases: readonly OvernightCase[]): OvernightObservationReport {
  const closed = cases.filter((c) => c.realizedReturnPct != null);
  const held = closed.filter((c) => c.heldOvernight);
  const sameDay = closed.filter((c) => !c.heldOvernight);

  const required = held.filter((c) => c.requiredTheHold);
  const gaps = held.map((c) => c.overnightGapPct).filter((x): x is number => x != null);
  const slips = closed.map((c) => c.stopSlippagePct).filter((x): x is number => x != null);

  return {
    version: "OVERNIGHT_RISK_OBSERVATION_V1",
    productionBehaviorChanged: false,
    winnersThatRequiredTheHold: required.length,
    winnerReturnPointsThatRequiredTheHold: r4(
      required.reduce((s, c) => s + (c.realizedReturnPct ?? 0), 0),
    ),
    sameDay: arm("SAME_DAY", sameDay),
    overnight: arm("HELD_OVERNIGHT", held),
    gaps: {
      n: gaps.length,
      medianGapPct: median(gaps),
      worstGapPct: gaps.length ? r4(Math.min(...gaps)) : null,
      bestGapPct: gaps.length ? r4(Math.max(...gaps)) : null,
      adverseGaps: gaps.filter((g) => g < 0).length,
      favourableGaps: gaps.filter((g) => g > 0).length,
      gappedThroughStop: held.filter((c) => c.gappedThroughStop === true).length,
      medianStopSlippagePct: median(slips),
      materialStopBreaches: slips.filter((s) => s <= MATERIAL_STOP_BREACH_PCT).length,
    },
    byEntryHour: cut((c) => (c.entryMinuteOfSession == null ? null : `${String(Math.floor(c.entryMinuteOfSession / 60)).padStart(2, "0")}:00 ET`), held),
    byStrategy: cut((c) => c.strategyKey, held),
    bySide: cut((c) => c.side, held),
    byDte: cut((c) => (c.dte == null ? null : `DTE ${c.dte}`), held),
    conditionalPolicy: {
      policyProposed: false,
      mustNotConcludeThat:
        "CLOSE EVERYTHING BEFORE THE BELL. " +
        `${required.length} winner(s) worth ${r4(required.reduce((s, c) => s + (c.realizedReturnPct ?? 0), 0))} ` +
        "return points were not yet at their eventual result by the first close. A flat rule " +
        "removes those alongside the gap losses and reports only the losses.",
      requirements: Object.freeze([
        "A CONDITIONAL cut — by entry time, DTE, cushion to the frozen stop, or strategy — in " +
        "which the held population is negative AND contains no winner that required the hold.",
        "The same cut measured prospectively, on trades that closed after it was frozen.",
        "A simulation whose downside is expressible: it must be able to close a trade that would " +
        "have won, and those trades must be reported before the losses avoided.",
      ]),
    },
    limitations: Object.freeze([
      "Every figure is IN-SAMPLE on the owner lane's current window and gates nothing.",
      "`requiredTheHold` is conservative: a trade already at or above its realized return by the " +
      "first close is not counted, so this is a FLOOR on what a flat close rule would destroy.",
      "The gap is measured between the last mark of the entry session and the first mark after " +
      "it. Where marks are sparse around the boundary, it understates the true overnight move.",
      "No stop, exit, target or overnight handling is changed, proposed, or implied.",
    ]),
  };
}
