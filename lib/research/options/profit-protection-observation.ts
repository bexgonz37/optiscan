/**
 * PROFIT PROTECTION — OBSERVATION ONLY. There is no policy in this file.
 *
 * THE QUESTION
 *
 * 12 owner callouts are `GOOD_MOVE_THEN_REVERSED` and 25 are `EVENTUAL_T1_WINNER`. Both
 * groups go up first. If they are distinguishable AT THE MOMENT they are both still winning,
 * a profit-protection rule is possible; if they are not, then every "sell at +20", trailing
 * stop, break-even stop and profit lock is a rule that clips the winners to save the losers,
 * and the trailing-stop study already showed what that costs — trail-10% read mean +10.86% /
 * PF 1.652 until the simulator could clip a winner, then it read −8.03% / PF 0.549.
 *
 * So this module measures whether the separation EXISTS. It does not act on it. Nothing here
 * returns a threshold, an exit instruction, or a value any delivery or exit path reads.
 *
 * WHAT MAKES IT HONEST
 *
 * Every field in `MilestoneObservation` is computed from marks at or before the instant the
 * milestone was first touched. Not the trade's MFE, not its realized return, not its peak —
 * those are the ANSWER, and a feature set that contains the answer will separate perfectly
 * and predict nothing. `observeMilestones` slices the mark series at the touch index before
 * computing anything, so a later mark is not merely unused, it is not in scope. A regression
 * test appends absurd marks AFTER each milestone and asserts every observation is byte-identical.
 *
 * The outcome label is hindsight and is kept in a different object (`ProtectionCase.outcome`)
 * from the features (`ProtectionCase.observations`), so the two cannot be passed around
 * together by accident.
 *
 * WHAT IS DELIBERATELY NOT COMPUTED
 *
 * A recommended threshold, a "best" milestone, or a fitted rule. With 37 labelled trades
 * across one 7-session window, any threshold this data produced would be a description of it.
 * `readiness` states that plainly and is the only conclusion the module will draw.
 *
 * PURE. No I/O, no clock, no env.
 */

/** Points of give-back from a running high that count as one pullback. */
export const PULLBACK_POINTS = 5;

/** The levels the question is asked at. Fixed by the research brief, not swept. */
export const PROTECTION_MILESTONES = [10, 15, 20, 25, 30, 35] as const;
export type ProtectionMilestone = (typeof PROTECTION_MILESTONES)[number];

/** One same-contract mark. `returnPct` is relative to the entry fill. */
export interface ObservationMark {
  atMs: number | null;
  returnPct: number | null;
}

/**
 * What was knowable at the instant a milestone was first touched.
 *
 * Every value here is derived from `marks[0..touchIndex]` only.
 */
export interface MilestoneObservation {
  milestonePct: number;
  reachedAtMs: number;
  msFromEntry: number;
  /** The touching mark's own return. At or above the milestone, never exactly it. */
  returnPctAtTouch: number;

  /** How much of the trade has been observed so far. A thin path is a weak observation. */
  marksSoFar: number;
  /**
   * Worst return seen on the way here — the heat the position took before it worked.
   *
   * This replaced three fields that were structurally constant and therefore worthless:
   * running peak, retracement from it, and time since it. At a FIRST touch of +X the
   * touching mark is necessarily the running maximum — any earlier higher mark would itself
   * have been at or above +X and would have been the touch. So peak always equalled the
   * touch value, retracement was always 0, and time-since-peak was always 0. Three columns
   * that could not vary would have gone into a separation study as three features.
   */
  maePctBeforeTouch: number;
  /** Largest peak-to-trough give-back observed before this instant, in points. */
  maxDrawdownBeforeTouchPct: number;
  /** How many times it gave back at least 5 points from a running high on the way here. */
  pullbacksBeforeTouch: number;
  /** Whether the move is still accelerating: return gained over the last observed step. */
  lastStepPct: number | null;
  /** Average points per minute from entry to here. Null when the interval is degenerate. */
  pctPerMinuteToHere: number | null;
  /** ms from the previous milestone in the list. Null for the first one reached. */
  msFromPriorMilestone: number | null;
  /** True when this instant is already on a later trading session than entry. */
  crossedSessionBoundaryByNow: boolean;
}

/** A trade's outcome. HINDSIGHT — deliberately kept out of the feature object. */
export type ProtectionOutcome =
  | "EVENTUAL_T1_WINNER"
  | "GOOD_MOVE_THEN_REVERSED"
  | "OTHER_CLOSED"
  | "UNGRADED";

export interface ProtectionCaseInput {
  opportunityCaseId: string;
  symbol: string | null;
  optionSymbol: string | null;
  side: "CALL" | "PUT" | null;
  strategyKey: string | null;
  sessionDate: string | null;
  dte: number | null;
  delta: number | null;
  selectionStrength: number | null;
  rewardRemainingFraction: number | null;
  moveConsumedFraction: number | null;
  entryAtMs: number | null;
  realizedReturnPct: number | null;
  outcome: ProtectionOutcome;
  marks: readonly ObservationMark[];
  /** Marks must be on the contract the callout froze. False disqualifies the case entirely. */
  occExact: boolean;
}

export interface ProtectionCase {
  opportunityCaseId: string;
  symbol: string | null;
  optionSymbol: string | null;
  side: "CALL" | "PUT" | null;
  strategyKey: string | null;
  sessionDate: string | null;
  dte: number | null;
  delta: number | null;
  selectionStrength: number | null;
  rewardRemainingFraction: number | null;
  moveConsumedFraction: number | null;
  realizedReturnPct: number | null;
  /** HINDSIGHT. Never an input to any observation above. */
  outcome: ProtectionOutcome;
  observations: MilestoneObservation[];
  /** Why a milestone has no observation, when it has none. */
  limitations: string[];
}

const r4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/**
 * Observe the milestone touches for one trade.
 *
 * The mark series is sliced at the touch index BEFORE any statistic is computed, so a later
 * mark cannot influence an earlier observation even through a refactor that forgets why.
 *
 * `sameTradingDay` is injected rather than imported so this module stays pure and so the ET
 * boundary logic lives in exactly one place in the codebase.
 */
export function observeMilestones(
  input: ProtectionCaseInput,
  sameTradingDay: (aMs: number, bMs: number) => boolean,
): ProtectionCase {
  const limitations: string[] = [];
  const base = {
    opportunityCaseId: input.opportunityCaseId,
    symbol: input.symbol,
    optionSymbol: input.optionSymbol,
    side: input.side,
    strategyKey: input.strategyKey,
    sessionDate: input.sessionDate,
    dte: input.dte,
    delta: input.delta,
    selectionStrength: input.selectionStrength,
    rewardRemainingFraction: input.rewardRemainingFraction,
    moveConsumedFraction: input.moveConsumedFraction,
    realizedReturnPct: input.realizedReturnPct,
    outcome: input.outcome,
  };

  if (!input.occExact) {
    return { ...base, observations: [], limitations: ["marks are not on the contract the callout froze"] };
  }
  const entryMs = input.entryAtMs;
  if (entryMs == null) {
    return { ...base, observations: [], limitations: ["the trade has no entry instant, so nothing can be timed from it"] };
  }

  // Usable marks only, in time order, from entry forward.
  const marks = input.marks
    .filter((m): m is { atMs: number; returnPct: number } =>
      m.atMs != null && m.returnPct != null && Number.isFinite(m.atMs) && Number.isFinite(m.returnPct) && m.atMs >= entryMs)
    .sort((a, b) => a.atMs - b.atMs);

  if (!marks.length) {
    return { ...base, observations: [], limitations: ["no same-contract marks after entry"] };
  }

  const observations: MilestoneObservation[] = [];
  let priorReachedAtMs: number | null = null;

  for (const milestone of PROTECTION_MILESTONES) {
    const touchIndex = marks.findIndex((m) => m.returnPct >= milestone);
    if (touchIndex < 0) {
      // Not a limitation worth listing per level — most trades never reach the higher ones,
      // and a list of six "never reached" notes would bury the ones that matter.
      continue;
    }
    // THE SLICE. Everything below sees only this.
    const seen = marks.slice(0, touchIndex + 1);
    const here = seen[seen.length - 1];

    // Path shape on the way here: the heat taken, the deepest give-back, and how many
    // give-backs there were. All three vary across trades that reach the same level.
    let runningPeak = seen[0].returnPct;
    let worst = seen[0].returnPct;
    let maxDrawdown = 0;
    let pullbacks = 0;
    let inPullback = false;
    for (const m of seen) {
      if (m.returnPct > runningPeak) { runningPeak = m.returnPct; inPullback = false; }
      if (m.returnPct < worst) worst = m.returnPct;
      const giveBack = runningPeak - m.returnPct;
      if (giveBack > maxDrawdown) maxDrawdown = giveBack;
      if (giveBack >= PULLBACK_POINTS && !inPullback) { pullbacks += 1; inPullback = true; }
    }

    const elapsedMs = here.atMs - entryMs;
    const elapsedMin = elapsedMs / 60_000;
    const prev = seen.length >= 2 ? seen[seen.length - 2] : null;

    observations.push({
      milestonePct: milestone,
      reachedAtMs: here.atMs,
      msFromEntry: elapsedMs,
      returnPctAtTouch: r4(here.returnPct),
      marksSoFar: seen.length,
      maePctBeforeTouch: r4(worst),
      maxDrawdownBeforeTouchPct: r4(maxDrawdown),
      pullbacksBeforeTouch: pullbacks,
      lastStepPct: prev ? r4(here.returnPct - prev.returnPct) : null,
      pctPerMinuteToHere: elapsedMin > 0 ? r4(here.returnPct / elapsedMin) : null,
      msFromPriorMilestone: priorReachedAtMs == null ? null : here.atMs - priorReachedAtMs,
      crossedSessionBoundaryByNow: !sameTradingDay(entryMs, here.atMs),
    });
    priorReachedAtMs = here.atMs;
  }

  if (!observations.length) limitations.push(`never reached +${PROTECTION_MILESTONES[0]}% on the frozen contract`);
  return { ...base, observations, limitations };
}

// ---------------------------------------------------------------------------
// Aggregation — does the separation exist at all?
// ---------------------------------------------------------------------------

/** The feature names contrasted between the two outcome groups, at each milestone. */
export const CONTRASTED_FEATURES = [
  "msFromEntry",
  "maePctBeforeTouch",
  "maxDrawdownBeforeTouchPct",
  "pullbacksBeforeTouch",
  "lastStepPct",
  "pctPerMinuteToHere",
  "marksSoFar",
] as const;

export interface FeatureContrast {
  feature: string;
  winnerN: number;
  reversedN: number;
  winnerMedian: number | null;
  reversedMedian: number | null;
  /** winnerMedian − reversedMedian. Null when either side has nothing to compare. */
  medianDelta: number | null;
  /**
   * Whether BOTH groups have enough observations for the difference to be worth reading.
   * A median over two trades is a number, not evidence.
   */
  supported: boolean;
}

/** Observations of a group must reach this before a median is called supported. */
export const MIN_PER_GROUP_FOR_CONTRAST = 8;

export interface MilestoneSeparation {
  milestonePct: number;
  /** Trades that touched this level at all. */
  reached: number;
  eventualWinners: number;
  goodMoveThenReversed: number;
  otherClosed: number;
  ungraded: number;
  /**
   * Of the CLOSED trades that touched this level, the share that still ended at or below 0.
   * This is the number that says whether protection is even worth studying at this level.
   */
  shareReachingThenEndingNonPositive: number | null;
  featureContrast: FeatureContrast[];
  /** True when at least one feature is supported AND its groups differ at all. */
  anySupportedContrast: boolean;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return r4(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}

export interface ProtectionReadiness {
  /**
   * Always false in this version, and the field exists so the answer is explicit rather than
   * inferred from silence. A profit-protection rule requires a separation that holds
   * PROSPECTIVELY; nothing in this module has ever been measured forward.
   */
  ruleProposed: false;
  /** What would have to be true before PROFIT_PROTECTION_V1 could even be drafted. */
  requirements: readonly string[];
  note: string;
}

export interface ProtectionObservationReport {
  version: "PROFIT_PROTECTION_OBSERVATION_V1";
  productionBehaviorChanged: false;
  casesConsidered: number;
  casesWithObservations: number;
  casesExcluded: number;
  milestones: MilestoneSeparation[];
  readiness: ProtectionReadiness;
  limitations: readonly string[];
}

/**
 * Aggregate the observations and report whether the two groups look different.
 *
 * Reports the CONTRAST, never a rule. `anySupportedContrast` false at every milestone is the
 * finding that matters most: it would mean the two populations are indistinguishable while
 * both are winning, and therefore that no profit-protection rule can be honest yet.
 */
export function buildProtectionObservation(cases: readonly ProtectionCase[]): ProtectionObservationReport {
  const withObs = cases.filter((c) => c.observations.length > 0);

  const milestones: MilestoneSeparation[] = PROTECTION_MILESTONES.map((milestone) => {
    const here = withObs
      .map((c) => ({ c, o: c.observations.find((x) => x.milestonePct === milestone) }))
      .filter((x): x is { c: ProtectionCase; o: MilestoneObservation } => x.o != null);

    const winners = here.filter((x) => x.c.outcome === "EVENTUAL_T1_WINNER");
    const reversed = here.filter((x) => x.c.outcome === "GOOD_MOVE_THEN_REVERSED");
    const otherClosed = here.filter((x) => x.c.outcome === "OTHER_CLOSED");
    const ungraded = here.filter((x) => x.c.outcome === "UNGRADED");

    const closedHere = here.filter((x) => x.c.outcome !== "UNGRADED" && x.c.realizedReturnPct != null);
    const nonPositive = closedHere.filter((x) => (x.c.realizedReturnPct as number) <= 0);

    const featureContrast: FeatureContrast[] = CONTRASTED_FEATURES.map((feature) => {
      const pick = (rows: typeof here) =>
        rows.map((x) => (x.o as unknown as Record<string, number | null>)[feature])
          .filter((v): v is number => v != null && Number.isFinite(v));
      const w = pick(winners);
      const l = pick(reversed);
      const wm = median(w);
      const lm = median(l);
      return {
        feature,
        winnerN: w.length,
        reversedN: l.length,
        winnerMedian: wm,
        reversedMedian: lm,
        medianDelta: wm == null || lm == null ? null : r4(wm - lm),
        supported: w.length >= MIN_PER_GROUP_FOR_CONTRAST && l.length >= MIN_PER_GROUP_FOR_CONTRAST,
      };
    });

    return {
      milestonePct: milestone,
      reached: here.length,
      eventualWinners: winners.length,
      goodMoveThenReversed: reversed.length,
      otherClosed: otherClosed.length,
      ungraded: ungraded.length,
      shareReachingThenEndingNonPositive: closedHere.length ? r4(nonPositive.length / closedHere.length) : null,
      featureContrast,
      anySupportedContrast: featureContrast.some((f) => f.supported && f.medianDelta != null && f.medianDelta !== 0),
    };
  });

  return {
    version: "PROFIT_PROTECTION_OBSERVATION_V1",
    productionBehaviorChanged: false,
    casesConsidered: cases.length,
    casesWithObservations: withObs.length,
    casesExcluded: cases.length - withObs.length,
    milestones,
    readiness: {
      ruleProposed: false,
      requirements: Object.freeze([
        "A contrast that is SUPPORTED (both groups at or above " + MIN_PER_GROUP_FOR_CONTRAST +
        " observations) at the same milestone, in more than one independent window.",
        "The same contrast measured PROSPECTIVELY, on trades that closed after the observation " +
        "was frozen — every figure here is in-sample.",
        "A simulated policy whose downside is expressible: it must be able to clip a winner, and " +
        "the winners it clips must be reported before the losses it saves.",
        "Evidence that any separating feature actually VARIES at the instant it is read. Three " +
        "candidate features were removed for being structurally constant at a first touch, and " +
        "a constant is not a weak signal — it is no signal wearing one's clothes.",
      ]),
      note:
        "OBSERVATION ONLY. No trailing stop, break-even stop, profit lock or sell-at-level exists, " +
        "is proposed, or is implied by anything in this report. Exit policy is unchanged.",
    },
    limitations: Object.freeze([
      "Every observation is IN-SAMPLE on the owner lane's current window.",
      "The outcome labels are hindsight by construction. They are the thing being predicted, " +
      "never an input to any feature.",
      "A trade that never reached +10% contributes nothing, so these milestones describe the " +
      "trades that worked at least briefly — not the lane.",
      "Median differences are descriptive. No significance test is claimed and none is implied.",
    ]),
  };
}
