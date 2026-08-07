/**
 * Winner-vs-loser comparison over pre-entry features only.
 *
 * WHY THIS SHAPE
 *
 * With 8 winners, a small p-value is worth nothing: any of ~40 features will separate
 * something by chance, and one +343.93% trade can drag a mean anywhere. So this reports
 * rank-based separation (AUC, which one outlier cannot move), the sample sizes behind it,
 * how much data was missing, and — the part that decides whether a feature is usable —
 * whether the SAME direction of separation reappears in an independent block of sessions.
 *
 * `repeatsAcrossDates` is the gate. A feature that separates in development and reverses in
 * validation is a description of four days, not a finding.
 *
 * PURE. No I/O, no clock, no env.
 */
import type { CohortRow } from "./lower-high-cohort.ts";
import type { PreEntryFeatures } from "./pre-entry-features.ts";

/** Numeric features eligible for comparison. Categorical/degenerate ones are excluded. */
export const COMPARABLE_FEATURES: readonly (keyof PreEntryFeatures)[] = Object.freeze([
  "dte", "entryFill", "spreadPct", "contractVolume", "openInterest", "iv", "absDelta",
  "moneynessPct", "dollarVolume", "vwapDistPct", "velPct", "accelPct", "volumeAccel",
  "compressionScore", "expansionScore", "atrPct", "hodProxPct", "lodProxPct",
  "nearestSupportDistPct", "nearestResistanceDistPct", "gapPct",
  "callPutVolRatio", "ivLevel", "medianSpreadPct", "zeroBidRate", "ntmConcentration",
  "etMinute", "sessionAlertOrdinal", "concurrentOpen",
]);

export interface FeatureComparison {
  feature: string;
  winnerN: number; loserN: number;
  winnerMedian: number | null; loserMedian: number | null;
  winnerMean: number | null; loserMean: number | null;
  /** P(random winner > random loser). 0.5 = no separation; rank-based, outlier-resistant. */
  auc: number | null;
  /** |auc - 0.5| * 2, so 0 = none and 1 = perfect. */
  separation: number | null;
  cohensD: number | null;
  missingWinners: number; missingLosers: number;
  /** Direction of separation in each block, and whether they agree. */
  developmentAuc: number | null;
  validationAuc: number | null;
  repeatsAcrossDates: boolean;
  /** Not enough data in one of the blocks to test repetition at all. */
  repetitionTestable: boolean;
}

const vals = (rows: readonly CohortRow[], k: keyof PreEntryFeatures): number[] =>
  rows.map((r) => r.features[k]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));

const mean = (v: readonly number[]): number | null =>
  v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;

const median = (v: readonly number[]): number | null => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const sd = (v: readonly number[]): number | null => {
  if (v.length < 2) return null;
  const m = mean(v)!;
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
};

/** Mann-Whitney U expressed as an AUC, ties counted as half. */
export function auc(winners: readonly number[], losers: readonly number[]): number | null {
  if (!winners.length || !losers.length) return null;
  let gt = 0, eq = 0;
  for (const a of winners) for (const b of losers) { if (a > b) gt++; else if (a === b) eq++; }
  return (gt + eq / 2) / (winners.length * losers.length);
}

const MIN_PER_GROUP = 3;

function compareOne(
  feature: keyof PreEntryFeatures,
  all: readonly CohortRow[],
  development: readonly CohortRow[],
  validation: readonly CohortRow[],
): FeatureComparison {
  const split = (rows: readonly CohortRow[]) => ({
    w: vals(rows.filter((r) => r.outcome === "WINNER"), feature),
    l: vals(rows.filter((r) => r.outcome === "LOSS"), feature),
  });
  const A = split(all), D = split(development), V = split(validation);
  const wRows = all.filter((r) => r.outcome === "WINNER").length;
  const lRows = all.filter((r) => r.outcome === "LOSS").length;

  const overall = auc(A.w, A.l);
  const dAuc = D.w.length >= MIN_PER_GROUP && D.l.length >= MIN_PER_GROUP ? auc(D.w, D.l) : null;
  const vAuc = V.w.length >= MIN_PER_GROUP && V.l.length >= MIN_PER_GROUP ? auc(V.w, V.l) : null;
  const repetitionTestable = dAuc != null && vAuc != null;
  // Same side of 0.5 in both blocks, and materially separated in both.
  const repeats = repetitionTestable &&
    Math.sign(dAuc! - 0.5) === Math.sign(vAuc! - 0.5) &&
    Math.abs(dAuc! - 0.5) >= 0.1 && Math.abs(vAuc! - 0.5) >= 0.1;

  const sw = sd(A.w), sl = sd(A.l);
  const pooled = sw != null && sl != null && A.w.length + A.l.length > 2
    ? Math.sqrt(((A.w.length - 1) * sw * sw + (A.l.length - 1) * sl * sl) / (A.w.length + A.l.length - 2))
    : null;
  const mw = mean(A.w), ml = mean(A.l);

  const round = (x: number | null, d = 4) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

  return {
    feature: String(feature),
    winnerN: A.w.length, loserN: A.l.length,
    winnerMedian: round(median(A.w)), loserMedian: round(median(A.l)),
    winnerMean: round(mw), loserMean: round(ml),
    auc: round(overall), separation: overall == null ? null : round(Math.abs(overall - 0.5) * 2),
    cohensD: pooled && pooled > 0 && mw != null && ml != null ? round((mw - ml) / pooled, 3) : null,
    missingWinners: wRows - A.w.length, missingLosers: lRows - A.l.length,
    developmentAuc: round(dAuc), validationAuc: round(vAuc),
    repeatsAcrossDates: repeats, repetitionTestable,
  };
}

export interface ComparisonReport {
  winners: number;
  losses: number;
  minimumPerGroupForRepetitionTest: number;
  features: FeatureComparison[];
  /** The only ones a rule is entitled to use. */
  repeatedDiscriminators: string[];
  /** Separated overall but did NOT repeat — explicitly not evidence. */
  singleBlockOnly: string[];
  caveat: string;
}

export function compareWinnersToLosers(
  all: readonly CohortRow[],
  development: readonly CohortRow[],
  validation: readonly CohortRow[],
): ComparisonReport {
  const features = COMPARABLE_FEATURES
    .map((f) => compareOne(f, all, development, validation))
    .sort((a, b) => (b.separation ?? 0) - (a.separation ?? 0));

  return {
    winners: all.filter((r) => r.outcome === "WINNER").length,
    losses: all.filter((r) => r.outcome === "LOSS").length,
    minimumPerGroupForRepetitionTest: MIN_PER_GROUP,
    features,
    repeatedDiscriminators: features.filter((f) => f.repeatsAcrossDates).map((f) => f.feature),
    singleBlockOnly: features
      .filter((f) => !f.repeatsAcrossDates && (f.separation ?? 0) >= 0.3)
      .map((f) => f.feature),
    caveat:
      "AUC is rank-based and outlier-resistant, but the winner group is single-digit. " +
      "Separation here is a reason to run a shadow experiment, never a reason to change a live threshold.",
  };
}
