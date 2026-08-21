/**
 * baselines.ts — ANALOG_BASELINE_V1. What a trivial model already knows, so the analog
 * engine can be asked the only question that matters about it.
 *
 * ── The question ─────────────────────────────────────────────────────────────
 *
 *     Does SIMILARITY add predictive information beyond a train-only base rate?
 *
 * The previous evaluation reported a 5d Brier of 0.2098 against a constant predictor's
 * 0.2496 and read as a signal. A constant predictor is the weakest possible comparison: it
 * cannot know that mega-caps drifted upward through 2023–2024, so ANY model that learns
 * "these names mostly went up" beats it. That is not setup edge. It is the base rate, and
 * the honest way to find out which one you have is to make the base rate a competitor.
 *
 * ── Every baseline obeys the retrieval fence, not a weaker one ───────────────
 *
 * A baseline that peeks is worse than no baseline: it makes the analog engine look modest
 * by inflating its opponent, and nobody checks the loser's methodology. So each estimator
 * here is built from the SAME eligible population `retrieveAnalogs` would admit:
 *
 *   · `labelEndMs <= query.t0Ms`   — finished resolving before the decision
 *   · not the query, and not a duplicate manifestation of the query
 *   · outcome !== null             — censored observations never enter a rate
 *
 * `eligibleTrainingSet` is the single implementation of that rule and every baseline calls
 * it. There is deliberately no way to construct a baseline in this module that sees a row
 * retrieval could not have seen.
 *
 * ── Backoff is explicit, and counted ─────────────────────────────────────────
 *
 * A symbol baseline needs prior observations OF THAT SYMBOL, and early queries do not have
 * them. Two options exist and both are defensible; only one keeps the comparison sound.
 *
 *   Abstain  → the baseline scores on a SUBSET of the analog's population, and the two
 *              Brier scores are then computed over different queries. That is not a
 *              comparison, and the difference would be dominated by which queries dropped.
 *   Back off → the baseline answers with the global base rate when its own stratum is thin,
 *              so the populations match exactly.
 *
 * This module backs off, and reports `backoffCount` next to every number so a baseline that
 * was mostly the global rate in disguise can be recognised as one. `MIN_STRATUM` is the
 * floor; below it the stratum is not consulted at all.
 *
 * ── No tuning ────────────────────────────────────────────────────────────────
 *
 * The trailing regime window is a fixed 20 trading sessions and is not searched over. A
 * window chosen because it scored well is a fitted parameter wearing a baseline's clothes,
 * and it would make the analog engine's margin unfalsifiable.
 */
import { duplicateKeyFor, type AnalogCorpusMember, type AnalogQuery } from "./retrieval.ts";
import { countIndependentSessions } from "../historical/trading-sessions.ts";

export const ANALOG_BASELINE_VERSION = "ANALOG_BASELINE_V1";

/** Minimum prior observations before a stratum may speak for itself. */
export const MIN_STRATUM = 20;

/**
 * Trailing window for the regime baseline, in TRADING SESSIONS.
 *
 * Fixed at 20 — roughly a month — because the hypothesis under test is "the 5d result is
 * multi-week regime drift", and a month is the coarsest window that can still distinguish
 * this month's tape from the whole sample. It is not tuned and must not become tuned: the
 * moment this number is chosen by score, the baseline stops being a baseline.
 */
export const REGIME_WINDOW_SESSIONS = 20;

export type BaselineId =
  | "CONSTANT"
  | "GLOBAL_BASE_RATE"
  | "SYMBOL_BASE_RATE"
  | "REGIME_BASE_RATE"
  | "DIRECTION_BASE_RATE";

export interface BaselineSpec {
  readonly id: BaselineId;
  readonly description: string;
  /** What it conditions on. "nothing" for the global rate. */
  readonly conditioning: string;
  /** Whether it may fall back to the global rate, and when. */
  readonly backoff: string;
}

export const BASELINE_SPECS: Readonly<Record<BaselineId, BaselineSpec>> = Object.freeze({
  CONSTANT: {
    id: "CONSTANT",
    description:
      "Predicts 0.5 for every query, so its Brier is exactly 0.25 by construction. Kept because " +
      "it is the floor every other baseline must itself clear — NOT as a reproduction of the " +
      "earlier report's 0.2496 'constant predictor', which was a different estimator.",
    conditioning: "nothing at all",
    backoff: "never — it has no stratum",
  },
  GLOBAL_BASE_RATE: {
    id: "GLOBAL_BASE_RATE",
    description:
      "Share of ALL prior resolved training observations that were wins. Knows the sample's " +
      "drift and nothing about the setup. This is the number the analog engine has to beat " +
      "before 'similarity predicts' means anything.",
    conditioning: "nothing beyond the chronological fence",
    backoff: "never — it IS the fallback",
  },
  SYMBOL_BASE_RATE: {
    id: "SYMBOL_BASE_RATE",
    description:
      "Prior win rate of THIS TICKER only. Separates 'this setup works' from 'this name went up'.",
    conditioning: "symbol",
    backoff: `global rate when the symbol has < ${MIN_STRATUM} prior resolved observations`,
  },
  REGIME_BASE_RATE: {
    id: "REGIME_BASE_RATE",
    description:
      `Win rate over the trailing ${REGIME_WINDOW_SESSIONS} trading sessions before the query, ` +
      "across every symbol. A deterministic recency stratification standing in for market state: " +
      "if the analog engine is really tracking the last month's tape, this baseline matches it.",
    conditioning: `trailing ${REGIME_WINDOW_SESSIONS} trading sessions`,
    backoff: `global rate when the window holds < ${MIN_STRATUM} resolved observations`,
  },
  DIRECTION_BASE_RATE: {
    id: "DIRECTION_BASE_RATE",
    description:
      "Prior win rate for this thesis SIDE. The strategy-conditioned baseline the replay corpus " +
      "can actually support: replay episodes carry a direction and no selected_strategy, so " +
      "conditioning on strategy would silently condition on nothing.",
    conditioning: "cmp_direction (bullish/bearish)",
    backoff: `global rate when the side has < ${MIN_STRATUM} prior resolved observations`,
  },
});

export const ALL_BASELINES: readonly BaselineId[] = Object.freeze(
  (Object.keys(BASELINE_SPECS) as BaselineId[]).slice().sort(),
);

export interface BaselinePrediction {
  baseline: BaselineId;
  predicted: number;
  /** Observations the stratum was estimated from. 0 for CONSTANT. */
  stratumN: number;
  /** True when the stratum was too thin and the global rate answered instead. */
  backedOff: boolean;
}

/** The training population a query is allowed to learn from. The ONLY definition. */
export function eligibleTrainingSet(
  query: Pick<AnalogQuery, "id" | "symbol" | "t0Ms" | "vector">,
  corpus: readonly AnalogCorpusMember[],
  duplicateBucketMs: number,
): AnalogCorpusMember[] {
  const qDup = duplicateKeyFor(query, duplicateBucketMs);
  const out: AnalogCorpusMember[] = [];
  for (const m of corpus) {
    if (m.id === query.id) continue;
    if ((m.dedupKey ?? duplicateKeyFor(m, duplicateBucketMs)) === qDup) continue;
    if (!(m.labelEndMs <= query.t0Ms)) continue;
    if (m.outcome === null) continue;
    out.push(m);
  }
  return out;
}

const winRate = (xs: readonly AnalogCorpusMember[]): number =>
  xs.length ? xs.filter((m) => (m.outcome as number) > 0).length / xs.length : 0.5;

/**
 * Trading sessions, most recent first, present in a training set.
 * Only genuine sessions count — `countIndependentSessions` rejects weekends and holidays,
 * so a trailing "20 sessions" window can never be widened by a public holiday.
 */
function recentSessions(train: readonly AnalogCorpusMember[], n: number): Set<string> {
  const dates = countIndependentSessions(train.map((m) => m.tradingDay)).sessions;
  return new Set([...dates].sort().slice(-n));
}

export interface BaselineSet {
  version: string;
  predictions: Record<BaselineId, BaselinePrediction>;
  /** The training population every baseline above was estimated from. */
  trainingN: number;
}

/**
 * Every baseline for one query, from one shared training set.
 *
 * Sharing the training set is not an optimisation: it is what guarantees the baselines are
 * comparable to each other and to the analog engine. Two estimators built from two
 * differently-fenced populations answer two different questions.
 */
export function baselinesForQuery(
  query: Pick<AnalogQuery, "id" | "symbol" | "t0Ms" | "vector">,
  corpus: readonly AnalogCorpusMember[],
  opts: { duplicateBucketMs?: number; minStratum?: number; regimeWindowSessions?: number } = {},
): BaselineSet {
  const bucketMs = opts.duplicateBucketMs ?? 15 * 60_000;
  const minStratum = opts.minStratum ?? MIN_STRATUM;
  const regimeWindow = opts.regimeWindowSessions ?? REGIME_WINDOW_SESSIONS;

  const train = eligibleTrainingSet(query, corpus, bucketMs);
  const global = winRate(train);

  const stratified = (id: BaselineId, subset: AnalogCorpusMember[]): BaselinePrediction =>
    subset.length >= minStratum
      ? { baseline: id, predicted: +winRate(subset).toFixed(6), stratumN: subset.length, backedOff: false }
      : { baseline: id, predicted: +global.toFixed(6), stratumN: subset.length, backedOff: true };

  const qDirection = query.vector.values.cmp_direction ?? null;
  const window = regimeWindow > 0 ? recentSessions(train, regimeWindow) : new Set<string>();

  return {
    version: ANALOG_BASELINE_VERSION,
    trainingN: train.length,
    predictions: {
      CONSTANT: { baseline: "CONSTANT", predicted: 0.5, stratumN: 0, backedOff: false },
      GLOBAL_BASE_RATE: {
        baseline: "GLOBAL_BASE_RATE",
        predicted: +global.toFixed(6),
        stratumN: train.length,
        // The global rate has nowhere to back off TO. An empty training set is reported by
        // stratumN = 0 rather than dressed up as a 0.5 prediction with evidence behind it.
        backedOff: false,
      },
      SYMBOL_BASE_RATE: stratified("SYMBOL_BASE_RATE", train.filter((m) => m.symbol === query.symbol)),
      REGIME_BASE_RATE: stratified("REGIME_BASE_RATE", train.filter((m) => window.has(m.tradingDay))),
      DIRECTION_BASE_RATE: stratified(
        "DIRECTION_BASE_RATE",
        // A null direction on either side is not a match. It is unknown, and an unknown
        // side pooled with bullish would make the baseline stronger than its evidence.
        qDirection === null ? [] : train.filter((m) => (m.vector.values.cmp_direction ?? null) === qDirection),
      ),
    },
  };
}

export interface BaselineScore {
  baseline: BaselineId;
  spec: BaselineSpec;
  /** Scored over the SAME predictions the analog engine was scored on. */
  n: number;
  brier: number | null;
  meanPredicted: number | null;
  /** How often the stratum was too thin and the global rate answered. */
  backoffCount: number;
  backoffRate: number;
  /** Median observations the stratum was estimated from, over non-backed-off queries. */
  medianStratumN: number | null;
}

export interface ScoreablePoint {
  id: string;
  win: boolean;
  baselines: Record<BaselineId, BaselinePrediction>;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Brier for each baseline over one shared population of scoreable predictions. */
export function scoreBaselines(points: readonly ScoreablePoint[]): BaselineScore[] {
  return ALL_BASELINES.map((id) => {
    const preds = points.map((p) => p.baselines[id]).filter(Boolean);
    const n = preds.length;
    const brier = n
      ? +(points.reduce((a, p) => a + (p.baselines[id].predicted - (p.win ? 1 : 0)) ** 2, 0) / n).toFixed(6)
      : null;
    const backoffCount = preds.filter((p) => p.backedOff).length;
    return {
      baseline: id,
      spec: BASELINE_SPECS[id],
      n,
      brier,
      meanPredicted: n ? +(preds.reduce((a, p) => a + p.predicted, 0) / n).toFixed(6) : null,
      backoffCount,
      backoffRate: n ? +(backoffCount / n).toFixed(4) : 0,
      medianStratumN: median(preds.filter((p) => !p.backedOff).map((p) => p.stratumN)),
    };
  });
}
