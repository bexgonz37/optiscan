/**
 * High-Asymmetry Radar — deterministic cohort comparison. PURE, descriptive.
 *
 * Compares OUTSIZED, ORDINARY, and FAILED candidates feature by feature. What
 * this module will NOT do, by construction:
 *
 *  - It will not claim causation. Every output is a distribution summary.
 *  - It will not name a "best" or "discriminating" feature. `topFeature` is
 *    always null in Phase 1; `sufficientEvidence` is reported per feature so a
 *    later phase can decide when a claim becomes permissible at all.
 *  - It will not treat a missing value as a low value. Missing values are
 *    EXCLUDED from every statistic and counted separately in `missingCount`.
 *  - It will not describe a negative or empty cohort as profitable. There is no
 *    profitability verdict here at all — only outcome rates.
 */
import {
  ASYMMETRY_CATEGORICAL_FEATURES, ASYMMETRY_NUMERIC_FEATURES, moneynessPct, round,
  type AsymmetryCategoricalFeature, type AsymmetryEvidence, type AsymmetryNumericFeature,
} from "./evidence.ts";
import { isOutsized, type AsymmetryOutcome, type AsymmetryOutcomeLabel } from "./outcomes.ts";
import type { PremiumChaseAnalysis } from "./premium-chase.ts";

export type AsymmetryCohort = "OUTSIZED" | "ORDINARY" | "FAILED" | "UNGRADED";
export const ASYMMETRY_COHORTS: AsymmetryCohort[] = ["OUTSIZED", "ORDINARY", "FAILED", "UNGRADED"];
/** Cohorts that are actually compared; UNGRADED is coverage reporting only. */
export const COMPARED_COHORTS: AsymmetryCohort[] = ["OUTSIZED", "ORDINARY", "FAILED"];

export function cohortForLabel(label: AsymmetryOutcomeLabel): AsymmetryCohort {
  if (isOutsized(label)) return "OUTSIZED";
  if (label === "ORDINARY_WIN" || label === "FLAT") return "ORDINARY";
  if (label === "FAILED") return "FAILED";
  return "UNGRADED";
}

export interface NumericSummary {
  sampleSize: number;
  missingCount: number;
  median: number | null;
  average: number | null;
  p25: number | null;
  p75: number | null;
}

export interface NumericFeatureComparison {
  feature: AsymmetryNumericFeature;
  byCohort: Record<AsymmetryCohort, NumericSummary>;
  /** True only when EVERY compared cohort meets the minimum sample. */
  sufficientEvidence: boolean;
}

export interface CategoricalFeatureComparison {
  feature: AsymmetryCategoricalFeature;
  byCohort: Record<AsymmetryCohort, { sampleSize: number; missingCount: number; counts: Record<string, number> }>;
  sufficientEvidence: boolean;
}

export interface CohortComparison {
  advisoryOnly: true;
  productionBehaviorChanged: false;
  minimumSupportedSample: number;
  cohortSizes: Record<AsymmetryCohort, number>;
  outcomeRates: Record<AsymmetryCohort, { count: number; sharePct: number | null }>;
  numericFeatures: NumericFeatureComparison[];
  categoricalFeatures: CategoricalFeatureComparison[];
  /** Always null in Phase 1. No feature has earned a discriminating claim. */
  topFeature: null;
  notes: string[];
}

/** One candidate reduced to the values the comparison reads. */
export interface CohortRow {
  candidateId: string;
  evidence: AsymmetryEvidence;
  chase: PremiumChaseAnalysis;
  outcome: AsymmetryOutcome;
}

const quantile = (sorted: number[], q: number): number | null => {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  if (low === high) return round(sorted[low], 4);
  return round(sorted[low] + (sorted[high] - sorted[low]) * (position - low), 4);
};

function summarize(values: Array<number | null>): NumericSummary {
  const present = values.filter((value): value is number => value != null && Number.isFinite(value));
  const sorted = [...present].sort((a, b) => a - b);
  return {
    sampleSize: present.length,
    missingCount: values.length - present.length,
    median: quantile(sorted, 0.5),
    average: present.length ? round(present.reduce((a, b) => a + b, 0) / present.length, 4) : null,
    // p25/p75 are only meaningful with enough points to have a spread at all.
    p25: present.length >= 4 ? quantile(sorted, 0.25) : null,
    p75: present.length >= 4 ? quantile(sorted, 0.75) : null,
  };
}

/** Reads one numeric feature off a row. Absent stays absent — never 0. */
export function numericFeatureValue(feature: AsymmetryNumericFeature, row: CohortRow): number | null {
  if (feature === "moneynessPct") return moneynessPct(row.evidence);
  if (feature === "premiumChasePct") return row.chase.chasePct;
  const value = row.evidence[feature as keyof AsymmetryEvidence];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Reads one categorical feature off a row. Null means "not sourced". */
export function categoricalFeatureValue(feature: AsymmetryCategoricalFeature, row: CohortRow): string | null {
  if (feature === "premiumChaseBucket") return row.chase.bucket === "UNKNOWN" ? null : row.chase.bucket;
  const value = row.evidence[feature as keyof AsymmetryEvidence];
  if (value == null) return null;
  const text = String(value);
  // "UNKNOWN" is an absence with a nicer name; it must not become a category.
  return text === "UNKNOWN" || text === "" ? null : text;
}

export function compareCohorts(
  rows: CohortRow[],
  opts: { minimumSupportedSample?: number } = {},
): CohortComparison {
  const minimumSupportedSample = opts.minimumSupportedSample ?? 30;
  const grouped = Object.fromEntries(ASYMMETRY_COHORTS.map((c) => [c, [] as CohortRow[]])) as Record<AsymmetryCohort, CohortRow[]>;
  for (const row of rows) grouped[cohortForLabel(row.outcome.label)].push(row);

  const cohortSizes = Object.fromEntries(
    ASYMMETRY_COHORTS.map((cohort) => [cohort, grouped[cohort].length]),
  ) as Record<AsymmetryCohort, number>;

  const total = rows.length;
  const outcomeRates = Object.fromEntries(ASYMMETRY_COHORTS.map((cohort) => [cohort, {
    count: grouped[cohort].length,
    sharePct: total > 0 ? round((grouped[cohort].length / total) * 100, 4) : null,
  }])) as CohortComparison["outcomeRates"];

  const numericFeatures = ASYMMETRY_NUMERIC_FEATURES.map((feature) => {
    const byCohort = Object.fromEntries(ASYMMETRY_COHORTS.map((cohort) => [
      cohort, summarize(grouped[cohort].map((row) => numericFeatureValue(feature, row))),
    ])) as Record<AsymmetryCohort, NumericSummary>;
    return {
      feature,
      byCohort,
      sufficientEvidence: COMPARED_COHORTS.every((cohort) => byCohort[cohort].sampleSize >= minimumSupportedSample),
    };
  });

  const categoricalFeatures = ASYMMETRY_CATEGORICAL_FEATURES.map((feature) => {
    const byCohort = Object.fromEntries(ASYMMETRY_COHORTS.map((cohort) => {
      const values = grouped[cohort].map((row) => categoricalFeatureValue(feature, row));
      const counts: Record<string, number> = {};
      for (const value of values) if (value != null) counts[value] = (counts[value] ?? 0) + 1;
      return [cohort, {
        sampleSize: values.filter((v) => v != null).length,
        missingCount: values.filter((v) => v == null).length,
        counts,
      }];
    })) as CategoricalFeatureComparison["byCohort"];
    return {
      feature,
      byCohort,
      sufficientEvidence: COMPARED_COHORTS.every((cohort) => byCohort[cohort].sampleSize >= minimumSupportedSample),
    };
  });

  return {
    advisoryOnly: true,
    productionBehaviorChanged: false,
    minimumSupportedSample,
    cohortSizes,
    outcomeRates,
    numericFeatures,
    categoricalFeatures,
    topFeature: null,
    notes: [
      "Descriptive distributions only. No causal relationship is asserted or implied.",
      "Missing values are excluded from every statistic and reported in missingCount; they are never treated as zero.",
      `A feature is marked sufficientEvidence only when OUTSIZED, ORDINARY, and FAILED each reach ${minimumSupportedSample} observations.`,
      "No feature is named as best or discriminating in this phase, regardless of the spread between cohorts.",
      "Cohort membership is a verified past option-mark classification, not a prediction about any future candidate.",
    ],
  };
}
