/**
 * quant-zero-state.ts — decide WHY the Quant Lab has nothing to show, so a
 * system fault can never be rendered as a statistical result.
 *
 * The defect this exists to prevent, measured on 2026-08-03 against production:
 * `/api/research/options/quant-lab` returned `lanes.delivered.sampleSize = 92`
 * (of 364 delivered paper trades, 272 excluded by the verification contract),
 * while the page displayed **"Sample size 0 · closed outcomes 0 · Not enough
 * data"**. The page had failed to load the snapshot and rendered `report ?? 0`
 * for every tile. A load failure and an empty lane produced byte-identical UI.
 *
 * Zero is a measurement. It must be earned from rows that were actually read.
 * When nothing was read, the answer is UNKNOWN — never 0, and never "not enough
 * data", which asserts that the data was looked at and found wanting.
 *
 * Pure and DB-free on purpose: the page passes what it has, and the decision is
 * unit-testable without a browser or a database.
 */

export type QuantZeroStateKind =
  /** Rows were read and there are some. Metric tiles may render numbers. */
  | "DATA_PRESENT"
  /** The request has not resolved yet. NOT a failure — no attempt has finished. */
  | "LOADING"
  /** The snapshot never loaded. NOT a statistical zero — nothing was measured. */
  | "LOAD_FAILED"
  /** The lane read 0 official rows, but its underlying population is non-empty:
   *  every row was excluded, and the reasons are known and must be shown. */
  | "LANE_EMPTY_ALL_EXCLUDED"
  /** The lane read 0 rows and there was nothing to exclude. A true empty set. */
  | "LANE_GENUINELY_EMPTY";

export interface ExclusionReason {
  reason: string;
  n: number;
}

export interface QuantZeroState {
  kind: QuantZeroStateKind;
  /** Whether metric tiles may show numbers. FALSE for every non-DATA_PRESENT kind. */
  metricsRenderable: boolean;
  /** Whether a numeric sample size may be shown. False when nothing was read. */
  sampleSizeKnown: boolean;
  headline: string;
  detail: string;
  /** Populated for LANE_EMPTY_ALL_EXCLUDED and alongside DATA_PRESENT. */
  exclusions: ExclusionReason[];
}

export interface VerificationCensus {
  officialLane: string;
  officialStatus: string;
  deliveredTotal: number;
  deliveredVerified: number;
  deliveredExcluded: number;
  byStatus?: Record<string, number>;
  byLinkage?: Record<string, number>;
  /** Present on the API payload; carried so the census panel can render it. */
  verifiedFraction?: number | null;
  quotable?: boolean;
  quotableBlockers?: string[];
  note?: string;
}

export interface QuantZeroStateInput {
  /** Non-null when the fetch failed, returned non-ok, or the token was rejected. */
  loadError?: string | null;
  /** The lane report. `null`/`undefined` means nothing was read. */
  report?: { sampleSize?: number } | null;
  /** Census for the official lane, when the snapshot carried one. */
  verification?: VerificationCensus | null;
  /** The lane being displayed, for message accuracy. */
  lane?: string;
  /**
   * True while no fetch attempt has completed yet. Distinguishes "not loaded"
   * from "load failed" — without it the first paint reports a failure that never
   * happened. Ignored once loadError is set, since a real fault outranks it.
   */
  pending?: boolean;
}

/**
 * Rank exclusion reasons largest-first, dropping the bucket that represents the
 * INCLUDED rows — an included row is not an exclusion reason.
 */
export function exclusionReasons(
  census: VerificationCensus | null | undefined,
): ExclusionReason[] {
  if (!census?.byStatus) return [];
  const includedBucket = census.officialStatus;
  return Object.entries(census.byStatus)
    .filter(([reason, n]) => reason !== includedBucket && Number(n) > 0)
    .map(([reason, n]) => ({ reason, n: Number(n) }))
    .sort((a, b) => b.n - a.n);
}

export function decideQuantZeroState(input: QuantZeroStateInput): QuantZeroState {
  const { loadError, report, verification, lane, pending } = input;
  const laneLabel = lane ? `the ${lane} lane` : "this lane";

  // "Not finished" is not "failed". The page mounts with report=null and
  // loadError=null, so without this branch the very first render reported
  // "Could not load Quant Lab — the snapshot request returned no data" on every
  // visit, before any request had resolved. The API was healthy the whole time
  // (verified in production: HTTP 200, sampleSize 102), so the page was accusing
  // a working backend. Only claim a failure once an attempt has actually ended.
  if (pending && loadError == null) {
    return {
      kind: "LOADING",
      metricsRenderable: false,
      sampleSizeKnown: false,
      headline: "Loading Quant Lab…",
      detail: "Reading the verified outcome snapshot. These figures are UNKNOWN until it returns — not zero.",
      exclusions: [],
    };
  }

  // A fault outranks everything. Nothing was read, so nothing may be reported —
  // not a sample size, not a win rate, and above all not a zero.
  if (loadError != null || report == null) {
    return {
      kind: "LOAD_FAILED",
      metricsRenderable: false,
      sampleSizeKnown: false,
      headline: "Could not load Quant Lab",
      detail:
        loadError != null
          ? `The snapshot request failed (${loadError}). These figures are UNKNOWN, not zero — no outcome was read.`
          : "The snapshot request returned no data. These figures are UNKNOWN, not zero — no outcome was read.",
      exclusions: [],
    };
  }

  const n = Number(report.sampleSize ?? 0);
  const exclusions = exclusionReasons(verification);

  if (n > 0) {
    return {
      kind: "DATA_PRESENT",
      metricsRenderable: true,
      sampleSizeKnown: true,
      headline: `${n} verified closed outcome${n === 1 ? "" : "s"}`,
      detail:
        verification && verification.deliveredExcluded > 0
          ? `${verification.deliveredVerified} of ${verification.deliveredTotal} delivered paper trades pass the verification contract. ${verification.deliveredExcluded} are excluded and listed below — excluded rows are never deleted and never blended into official performance.`
          : "Official metrics count verified, graded outcomes only.",
      exclusions,
    };
  }

  // n === 0 with a non-empty population: the lane is empty BECAUSE of exclusion.
  // Saying "not enough data" here would be false — there is data, and it was rejected.
  const population = Number(verification?.deliveredTotal ?? 0);
  if (population > 0) {
    return {
      kind: "LANE_EMPTY_ALL_EXCLUDED",
      metricsRenderable: false,
      sampleSizeKnown: true,
      headline: `All ${population} record${population === 1 ? "" : "s"} excluded`,
      detail:
        `${laneLabel} has ${population} closed record${population === 1 ? "" : "s"}, and every one fails the verification `
        + "contract. This is an exclusion result, not an absence of data. The reasons are listed below.",
      exclusions,
    };
  }

  return {
    kind: "LANE_GENUINELY_EMPTY",
    metricsRenderable: false,
    sampleSizeKnown: true,
    headline: "No records yet",
    detail: `${laneLabel} has recorded no closed outcomes. Nothing has been excluded — the set is genuinely empty.`,
    exclusions: [],
  };
}
