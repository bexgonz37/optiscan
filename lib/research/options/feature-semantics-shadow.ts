/**
 * feature-semantics-shadow.ts — Phase 12. FIVE MEASUREMENTS, ZERO AUTHORITY.
 *
 * The architecture audit found several strategy-science issues. Every one of
 * them is a change to what a feature MEANS, and a meaning change silently
 * revalues every historical row computed under the old meaning. So none of them
 * is applied. This module computes the alternative ALONGSIDE production so the
 * size of each effect is known before anything is decided.
 *
 * NOTHING HERE IS WIRED INTO A DECISION. No export is called from the scan path,
 * the strategy path, the delivery path or the grading path. Each function takes
 * evidence and returns a comparison.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A. CURRENT SESSION FEATURE WINDOW
 *
 * `computeOptionsFeatures` derives HOD, LOD, VWAP and cumVol from whatever bar
 * array it is handed — `Math.max(...bars.map(b => b.h))`, `bars.reduce(...)` —
 * with no session boundary anywhere. When the caller supplies two days of bars,
 * every one of those is a TWO-DAY figure wearing a session name. A "session
 * high" that includes yesterday is not a session high, and `fractionMove`, which
 * divides by (hod - lod), inherits the error twice.
 *
 * B. DIRECTION-AWARE LATE PHASE
 *
 * Production: `fractionMove = (price - lod) / (hod - lod)`, then earliness is
 * classified from it. That is DIRECTION-BLIND: it says where price sits in the
 * range, not how far through its own move the trade is. For a CALL, sitting at
 * the session low is EARLY; for a PUT, the same position is LATE. One number
 * currently answers both questions the same way.
 *
 * C. BEARISH SIGNAL DUPLICATION
 *
 * discovery.ts line 64:
 *   if ((u.accelPct ?? 0) < 0 || (u.velPct ?? 0) < 0) {
 *     s.add("downside_acceleration"); s.add("downside_momentum");
 *   }
 * ONE condition emits TWO signals. Strategy score is `matched / earlySignals`,
 * so any bearish strategy listing both gets two-for-one on a single observation
 * — its score rises without any additional evidence existing.
 *
 * D. STRATEGY TIES
 *
 * Score is a RATIO, so ties are common. `lower_high_continuation` lists more
 * early signals than several bullish peers, and a longer list changes which
 * ratios are reachable. This measures how often the top of the board is a tie
 * and how often the tie resolves to a PUT.
 *
 * E. RELATIVE VOLUME
 *
 * `relVolume` needs `ctx.timeOfDayAvgVolume`, which the whole-market snapshot
 * does not carry, so it is null in production. This determines whether a
 * POINT-IN-TIME-SAFE expectation can honestly be built from prior sessions, and
 * refuses to fabricate one where it cannot.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * PURE. No clock, no I/O, no env read.
 */
import type { Bar } from "./features.ts";

export const FEATURE_SEMANTICS_SHADOW_VERSION = "OPTIONS_FEATURE_SEMANTICS_SHADOW_V1" as const;

const r4 = (n: number) => +n.toFixed(4);

/* ---------------------------------------------------------------------------
 * A. SESSION WINDOW
 * -------------------------------------------------------------------------*/

export interface WindowFeatures {
  hod: number | null;
  lod: number | null;
  vwap: number | null;
  cumVol: number;
  fractionMove: number | null;
  barCount: number;
}

/** Exactly what production computes, over whatever bars it is given. */
export function windowFeatures(bars: readonly Bar[], price: number): WindowFeatures {
  if (!bars.length) return { hod: null, lod: null, vwap: null, cumVol: 0, fractionMove: null, barCount: 0 };
  const cumVol = bars.reduce((a, b) => a + b.v, 0);
  const vwapNum = bars.reduce((a, b) => a + ((b.h + b.l + b.c) / 3) * b.v, 0);
  const vwap = cumVol > 0 ? r4(vwapNum / cumVol) : null;
  const hod = Math.max(...bars.map((b) => b.h));
  const lod = Math.min(...bars.map((b) => b.l));
  const fractionMove = hod > lod ? +(((price - lod) / (hod - lod))).toFixed(3) : null;
  return { hod, lod, vwap, cumVol, fractionMove, barCount: bars.length };
}

export interface SessionWindowComparison {
  version: typeof FEATURE_SEMANTICS_SHADOW_VERSION;
  /** What production computes today, over the full bar array it is handed. */
  production: WindowFeatures;
  /** The same features over the CURRENT SESSION only. */
  sessionOnly: WindowFeatures;
  /** Bars production included that belong to a previous session. */
  priorSessionBars: number;
  /** Signed differences. Null where either side could not be computed. */
  deltas: {
    hod: number | null; lod: number | null; vwap: number | null;
    cumVol: number; fractionMove: number | null;
  };
  /** True when the two windows disagree at all. */
  materiallyDifferent: boolean;
}

/**
 * Compare the two-day window against a properly sliced session.
 *
 * `sessionStartMs` is supplied by the caller rather than derived, because
 * session boundaries are a calendar question this module has no business
 * answering, and guessing one would be a second bug on top of the first.
 */
export function compareSessionWindow(
  bars: readonly Bar[],
  price: number,
  sessionStartMs: number,
): SessionWindowComparison {
  const sessionBars = bars.filter((b) => b.t >= sessionStartMs);
  const production = windowFeatures(bars, price);
  const sessionOnly = windowFeatures(sessionBars, price);
  const d = (a: number | null, b: number | null) => (a == null || b == null ? null : r4(a - b));
  const deltas = {
    hod: d(production.hod, sessionOnly.hod),
    lod: d(production.lod, sessionOnly.lod),
    vwap: d(production.vwap, sessionOnly.vwap),
    cumVol: production.cumVol - sessionOnly.cumVol,
    fractionMove: d(production.fractionMove, sessionOnly.fractionMove),
  };
  return {
    version: FEATURE_SEMANTICS_SHADOW_VERSION,
    production,
    sessionOnly,
    priorSessionBars: bars.length - sessionBars.length,
    deltas,
    materiallyDifferent: Object.values(deltas).some((v) => v != null && v !== 0),
  };
}

/* ---------------------------------------------------------------------------
 * B. DIRECTION-AWARE LATE PHASE
 * -------------------------------------------------------------------------*/

/**
 * How far through its OWN move a trade is, 0 = earliest, 1 = latest.
 *
 * A CALL bought at the session low has the whole range ahead of it; the same
 * price is where a PUT's move has already finished. Production's single
 * direction-blind number cannot express that, and this is the candidate that
 * can. It is NOT production's late-phase authority and does not feed it.
 */
export function directionAwareFractionMove(
  price: number, hod: number | null, lod: number | null, side: "call" | "put",
): number | null {
  if (hod == null || lod == null || !(hod > lod)) return null;
  const raw = (price - lod) / (hod - lod);
  const clamped = Math.max(0, Math.min(1, raw));
  return +(side === "call" ? clamped : 1 - clamped).toFixed(3);
}

export interface LatePhaseComparison {
  version: typeof FEATURE_SEMANTICS_SHADOW_VERSION;
  /** Production's direction-blind value. */
  productionFractionMove: number | null;
  /** The direction-aware candidate. */
  shadowFractionMove: number | null;
  side: "call" | "put";
  /** True when the two disagree about earliness. */
  disagrees: boolean;
  /** Plain statement of the disagreement, for a report. */
  note: string;
}

export function compareLatePhase(
  price: number, hod: number | null, lod: number | null, side: "call" | "put",
): LatePhaseComparison {
  const prod = hod != null && lod != null && hod > lod
    ? +(((price - lod) / (hod - lod))).toFixed(3) : null;
  const shadow = directionAwareFractionMove(price, hod, lod, side);
  const disagrees = prod != null && shadow != null && prod !== shadow;
  return {
    version: FEATURE_SEMANTICS_SHADOW_VERSION,
    productionFractionMove: prod,
    shadowFractionMove: shadow,
    side,
    disagrees,
    note: prod == null || shadow == null
      ? "range unavailable — no comparison"
      : disagrees
        ? `production reads ${prod} for both sides; direction-aware reads ${shadow} for a ${side}`
        : "the two agree at this range position",
  };
}

/* ---------------------------------------------------------------------------
 * C. BEARISH SIGNAL DUPLICATION
 * -------------------------------------------------------------------------*/

/** The pair that production emits from ONE negative observation. */
export const DUPLICATED_BEARISH_PAIR = Object.freeze(["downside_acceleration", "downside_momentum"] as const);

export interface DuplicationEffect {
  version: typeof FEATURE_SEMANTICS_SHADOW_VERSION;
  strategyKey: string;
  /** Score as production computes it, with both signals counted. */
  productionScore: number;
  /** Score counting the duplicated pair as the single observation it is. */
  dedupedScore: number;
  /** productionScore - dedupedScore. */
  inflation: number;
  /** True when this strategy lists BOTH members of the pair. */
  benefitsFromDuplication: boolean;
}

/**
 * What the double-emit is worth to one strategy.
 *
 * Deduplicating means: if a strategy lists both members and both are active,
 * count them as one matched signal out of a signal list one shorter. That keeps
 * the ratio comparable rather than merely shrinking the numerator.
 */
export function measureDuplicationEffect(
  strategyKey: string,
  earlySignals: readonly string[],
  activeSignals: ReadonlySet<string>,
): DuplicationEffect {
  const matched = earlySignals.filter((s) => activeSignals.has(s));
  const productionScore = earlySignals.length ? +(matched.length / earlySignals.length).toFixed(3) : 0;

  const listsBoth = DUPLICATED_BEARISH_PAIR.every((s) => earlySignals.includes(s));
  const bothActive = DUPLICATED_BEARISH_PAIR.every((s) => activeSignals.has(s));
  const benefitsFromDuplication = listsBoth && bothActive;

  const dedupedScore = benefitsFromDuplication
    ? +(((matched.length - 1) / (earlySignals.length - 1))).toFixed(3)
    : productionScore;

  return {
    version: FEATURE_SEMANTICS_SHADOW_VERSION,
    strategyKey,
    productionScore,
    dedupedScore,
    inflation: +(productionScore - dedupedScore).toFixed(3),
    benefitsFromDuplication,
  };
}

export interface DuplicationReport {
  version: typeof FEATURE_SEMANTICS_SHADOW_VERSION;
  observations: number;
  /** Observations where a strategy actually gained from the double-emit. */
  affected: number;
  /** Mean inflation across affected observations. */
  meanInflation: number;
  maxInflation: number;
  affectedStrategies: string[];
}

export function summarizeDuplication(effects: readonly DuplicationEffect[]): DuplicationReport {
  const affected = effects.filter((e) => e.benefitsFromDuplication && e.inflation !== 0);
  const total = affected.reduce((a, e) => a + e.inflation, 0);
  return {
    version: FEATURE_SEMANTICS_SHADOW_VERSION,
    observations: effects.length,
    affected: affected.length,
    meanInflation: affected.length ? +(total / affected.length).toFixed(4) : 0,
    maxInflation: affected.length ? +Math.max(...affected.map((e) => e.inflation)).toFixed(3) : 0,
    affectedStrategies: [...new Set(affected.map((e) => e.strategyKey))].sort(),
  };
}

/* ---------------------------------------------------------------------------
 * D. STRATEGY TIES
 * -------------------------------------------------------------------------*/

export interface TieObservation {
  /** Applicable strategies as production scored them, already ordered. */
  key: string;
  score: number;
  matchedCount: number;
  side: "call" | "put" | "either";
}

export interface TieReport {
  version: typeof FEATURE_SEMANTICS_SHADOW_VERSION;
  observations: number;
  /** Observations where the top score was shared by more than one strategy. */
  tiedAtTop: number;
  /** Ties whose winner was a PUT strategy. */
  tiesResolvedToPut: number;
  /** Ties whose winner was a PUT AND had strictly more matched keys than a tied CALL. */
  tiesResolvedToPutByKeyCount: number;
  tieRatePct: number;
  putResolutionPct: number;
}

/**
 * How often the board ties, and how often that tie hands the trade to a PUT.
 *
 * A ratio score ties easily, and a strategy with more matched keys at the same
 * ratio is not better-evidenced — it is differently-shaped. If ties resolve
 * systematically to one side, direction is being decided by catalog structure
 * rather than by the market.
 */
export function measureStrategyTies(observations: readonly (readonly TieObservation[])[]): TieReport {
  let tiedAtTop = 0, tiesResolvedToPut = 0, tiesResolvedToPutByKeyCount = 0;

  for (const board of observations) {
    if (!board.length) continue;
    const top = board[0];
    const tied = board.filter((s) => s.score === top.score);
    if (tied.length < 2) continue;
    tiedAtTop += 1;
    if (top.side === "put") {
      tiesResolvedToPut += 1;
      const tiedCalls = tied.filter((s) => s.side === "call");
      if (tiedCalls.length && tiedCalls.every((c) => top.matchedCount > c.matchedCount)) {
        tiesResolvedToPutByKeyCount += 1;
      }
    }
  }

  const n = observations.length;
  return {
    version: FEATURE_SEMANTICS_SHADOW_VERSION,
    observations: n,
    tiedAtTop,
    tiesResolvedToPut,
    tiesResolvedToPutByKeyCount,
    tieRatePct: n > 0 ? +((tiedAtTop / n) * 100).toFixed(2) : 0,
    putResolutionPct: tiedAtTop > 0 ? +((tiesResolvedToPut / tiedAtTop) * 100).toFixed(2) : 0,
  };
}

/* ---------------------------------------------------------------------------
 * E. RELATIVE VOLUME FEASIBILITY
 * -------------------------------------------------------------------------*/

export type RelVolumeFeasibility = "AVAILABLE" | "INSUFFICIENT_SESSIONS" | "INSUFFICIENT_COVERAGE" | "NO_INTRADAY_HISTORY";

export interface RelVolumeAssessment {
  version: typeof FEATURE_SEMANTICS_SHADOW_VERSION;
  feasibility: RelVolumeFeasibility;
  /** Prior sessions with usable intraday volume for this symbol. */
  usableSessions: number;
  /** Expected cumulative volume at this time of day, ONLY when feasible. */
  expectedCumVolume: number | null;
  /** What is missing, in words. Empty when AVAILABLE. */
  blockers: string[];
}

export interface PriorSessionVolume {
  sessionDate: string;
  /** Cumulative volume at the SAME time of day, from that session's bars. */
  cumVolumeAtSameTimeOfDay: number | null;
  /** Bars that session actually had before this time of day. */
  barsBeforeTimeOfDay: number;
}

/**
 * Can a point-in-time-safe expected volume be built from prior sessions?
 *
 * THE POINT-IN-TIME RULE. Only volume accumulated by the SAME time of day in
 * PRIOR sessions may contribute. Using a prior session's full-day volume, or any
 * part of the current session's future, is lookahead — it would make relVolume
 * predictive of its own outcome and quietly poison every model trained on it.
 *
 * REFUSES RATHER THAN FABRICATES. Too few sessions, or sessions too sparse to
 * have reached this time of day, return a feasibility verdict and a null
 * expectation. A relVolume computed against a guessed baseline is worse than no
 * relVolume, because it is indistinguishable from a real one.
 */
export function assessRelativeVolume(
  priorSessions: readonly PriorSessionVolume[],
  opts: { minSessions?: number; minBarsPerSession?: number } = {},
): RelVolumeAssessment {
  const minSessions = opts.minSessions ?? 10;
  const minBars = opts.minBarsPerSession ?? 5;
  const blockers: string[] = [];

  const usable = priorSessions.filter((s) =>
    typeof s.cumVolumeAtSameTimeOfDay === "number"
    && Number.isFinite(s.cumVolumeAtSameTimeOfDay)
    && (s.cumVolumeAtSameTimeOfDay as number) > 0
    && s.barsBeforeTimeOfDay >= minBars);

  if (priorSessions.length === 0) {
    return {
      version: FEATURE_SEMANTICS_SHADOW_VERSION, feasibility: "NO_INTRADAY_HISTORY",
      usableSessions: 0, expectedCumVolume: null,
      blockers: ["no prior-session intraday bars are retained for this symbol"],
    };
  }
  if (usable.length < minSessions) {
    blockers.push(`${usable.length} usable prior sessions, need ${minSessions}`);
    const sparse = priorSessions.length - usable.length;
    if (sparse > 0) blockers.push(`${sparse} prior sessions had too few bars before this time of day`);
    return {
      version: FEATURE_SEMANTICS_SHADOW_VERSION,
      feasibility: usable.length === 0 ? "INSUFFICIENT_COVERAGE" : "INSUFFICIENT_SESSIONS",
      usableSessions: usable.length, expectedCumVolume: null, blockers,
    };
  }

  // Median, not mean: one halted or news-driven session should not redefine
  // "normal" for every subsequent comparison.
  const sorted = usable.map((s) => s.cumVolumeAtSameTimeOfDay as number).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

  return {
    version: FEATURE_SEMANTICS_SHADOW_VERSION,
    feasibility: "AVAILABLE",
    usableSessions: usable.length,
    expectedCumVolume: Math.round(median),
    blockers: [],
  };
}
