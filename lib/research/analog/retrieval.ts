/**
 * retrieval.ts — ANALOG_RETRIEVAL_V1. Cohort retrieval with a chronological fence.
 *
 * ── The two leaks this closes ────────────────────────────────────────────────
 *
 * `AnalogScorer.explain()` retrieves from whatever it was fitted on. That is correct
 * inside the walk-forward harness, where `fit(train)` and `score(test.input)` are already
 * disjoint. It is NOT correct for the question a research surface asks — "given this
 * episode, what happened in similar prior setups?" — because there the query is very often
 * a member of the corpus. Measured directly against the current engine:
 *
 *     query ep_7      → nearest analog ep_7, distance 0        (retrieved ITSELF)
 *     query ep_0      → 4 of 5 nearest analogs are LATER episodes (retrieved the FUTURE)
 *
 * Both produce a beautiful, meaningless answer. This module makes the fence a property of
 * retrieval rather than a property of how carefully the caller assembled the corpus.
 *
 *   SELF     — the query id, and any duplicate manifestation of it, is removed.
 *   FUTURE   — an analog must have FINISHED RESOLVING before the query's decision time:
 *              `labelEndMs <= query.t0Ms`. Not `t0Ms < query.t0Ms` — an episode that began
 *              earlier but whose label was still resolving at T0 encodes information the
 *              query could not have had.
 *
 * ── Duplicate manifestations ─────────────────────────────────────────────────
 *
 * The same underlying move is routinely captured several times: the scanner re-observes a
 * symbol every couple of seconds, and one afternoon's run can emit dozens of near-identical
 * episodes. Counted as independent analogs they inflate every sample size and every
 * confidence. `dedupKey` (symbol + direction + a time bucket) collapses them, and the cap
 * per ticker is enforced on top of that.
 *
 * ── Determinism ──────────────────────────────────────────────────────────────
 *
 * Ordering is (distance, id) — the id tiebreak is what makes two runs over the same corpus
 * return the same neighbours in the same order even when distances tie exactly, which they
 * do whenever duplicate manifestations survive.
 */
import { fitMetric, mdistPartial, type MetricModel } from "./similarity.ts";
import {
  ANALOG_FEATURE_VECTOR_VERSION,
  COMPARABILITY_KEYS,
  DEDUP_KEY,
  DISTANCE_DIMENSIONS,
  type AnalogFeatureVector,
} from "./feature-vector.ts";
import {
  assertSingleEvidenceClass,
  evidenceClassComposition,
  type AnalogEvidenceClass,
} from "./evidence-class.ts";

export const ANALOG_RETRIEVAL_VERSION = "ANALOG_RETRIEVAL_V1";

/** One corpus member: a frozen T0 vector plus the forward label window it occupies. */
export interface AnalogCorpusMember {
  id: string;
  symbol: string;
  t0Ms: number;
  /** When the forward label finished resolving. An analog is usable only once this has passed. */
  labelEndMs: number;
  tradingDay: string;
  evidenceClass: AnalogEvidenceClass;
  vector: AnalogFeatureVector;
  /** Realized outcome, or null when censored / unresolved. Null NEVER becomes 0. */
  outcome: number | null;
  /** Optional explicit duplicate-manifestation key; derived when absent. */
  dedupKey?: string;
}

export interface AnalogQuery {
  id: string;
  symbol: string;
  t0Ms: number;
  vector: AnalogFeatureVector;
}

export interface RetrievalOptions {
  /** Neighbours to keep. */
  k?: number;
  /** Max analogs from any one ticker. */
  perSymbolCap?: number;
  /** Max analogs from any one duplicate-manifestation bucket. */
  perDuplicateCap?: number;
  /** Minimum fraction of distance dimensions two vectors must share. */
  minCoverage?: number;
  /** Distance ceiling; Infinity disables. */
  maxRadius?: number;
  /** Bucket width for duplicate-manifestation collapse. */
  duplicateBucketMs?: number;
  /** Restrict to one evidence class. Omit to accept the corpus's single class. */
  evidenceClass?: AnalogEvidenceClass;
}

export function defaultRetrievalOptions(): Required<Omit<RetrievalOptions, "evidenceClass">> {
  return {
    k: 30,
    perSymbolCap: 5,
    perDuplicateCap: 1,
    minCoverage: 0.6,
    maxRadius: Infinity,
    duplicateBucketMs: 15 * 60_000,
    };
}

export interface RetrievedAnalog {
  id: string;
  symbol: string;
  tradingDay: string;
  t0Ms: number;
  distance: number;
  /** Which dimensions actually contributed, and which were unavailable on one side. */
  sharedDims: string[];
  droppedDims: string[];
  coverage: number;
  evidenceClass: AnalogEvidenceClass;
  outcome: number | null;
  sameSymbol: boolean;
}

export type ExclusionReason =
  | "SELF"
  | "FUTURE_OR_UNRESOLVED_AT_T0"
  | "EVIDENCE_CLASS_MISMATCH"
  | "COMPARABILITY_MISMATCH"
  | "NOT_COMPARABLE_VECTOR"
  | "INSUFFICIENT_FEATURE_COVERAGE"
  | "BEYOND_RADIUS"
  | "DUPLICATE_MANIFESTATION"
  | "PER_SYMBOL_CAP";

export interface RetrievalResult {
  retrievalVersion: string;
  featureVectorVersion: string;
  analogs: RetrievedAnalog[];
  /** Every member that was considered and why it was dropped. Counts only — bounded output. */
  exclusions: Record<ExclusionReason, number>;
  /** Population the fence admitted, before capping. */
  eligibleCount: number;
  /** Analogs finally kept. */
  retrievedCount: number;
  /** How many kept analogs carry a usable (non-censored) outcome. */
  labeledCount: number;
  composition: {
    symbolScope: "SAME_SYMBOL" | "CROSS_SYMBOL" | "MIXED" | "NONE";
    sameSymbol: number;
    crossSymbol: number;
    distinctSymbols: number;
    distinctTradingDays: number;
    evidenceClasses: Record<string, number>;
    /** Largest share any one ticker holds of the retrieved cohort. */
    topSymbolShare: number;
  };
  /** Mean feature coverage across retrieved analogs. */
  meanCoverage: number;
}

const EMPTY_EXCLUSIONS = (): Record<ExclusionReason, number> => ({
  SELF: 0,
  FUTURE_OR_UNRESOLVED_AT_T0: 0,
  EVIDENCE_CLASS_MISMATCH: 0,
  COMPARABILITY_MISMATCH: 0,
  NOT_COMPARABLE_VECTOR: 0,
  INSUFFICIENT_FEATURE_COVERAGE: 0,
  BEYOND_RADIUS: 0,
  DUPLICATE_MANIFESTATION: 0,
  PER_SYMBOL_CAP: 0,
});

/** Duplicate-manifestation identity: same ticker, same side, same short time bucket. */
export function duplicateKeyFor(m: { symbol: string; t0Ms: number; vector: AnalogFeatureVector }, bucketMs: number): string {
  const dir = m.vector.values.cmp_direction;
  return `${m.symbol}|${dir ?? "null"}|${Math.floor(m.t0Ms / Math.max(1, bucketMs))}`;
}

/**
 * Fit the metric from the corpus members that are usable for a given query time.
 *
 * The metric itself is fitted ONLY on members that pass the chronological fence, because a
 * metric learned from future outcomes is look-ahead even when the neighbours it selects are
 * not. This is the subtle leak that survives a correct neighbour filter.
 */
export function fitRetrievalMetric(eligible: readonly AnalogCorpusMember[], ridge = 0.1): MetricModel | null {
  const labeled = eligible.filter((m) => m.outcome !== null);
  if (labeled.length < 2) return null;
  const dims = [...DISTANCE_DIMENSIONS];
  const rows = labeled.map((m) => dims.map((d) => {
    const v = m.vector.values[d];
    return v === null || v === undefined ? NaN : v;
  }));
  const wins = labeled.map((m) => (m.outcome as number) > 0);
  return fitMetric(rows, wins, dims, ridge);
}

/**
 * Retrieve a deterministic, leak-fenced analog cohort.
 *
 * `nowFence` defaults to the query's own t0 and is the ONLY time reference used. Passing a
 * later fence is how the evaluation harness reproduces "what could have been known then"
 * without rebuilding the corpus.
 */
export function retrieveAnalogs(
  query: AnalogQuery,
  corpus: readonly AnalogCorpusMember[],
  options: RetrievalOptions = {},
): RetrievalResult {
  const opt = { ...defaultRetrievalOptions(), ...options };
  const exclusions = EMPTY_EXCLUSIONS();
  const fenceMs = query.t0Ms;

  // The corpus must be single-class; a mixed corpus is a caller error, not a filter.
  const requested = options.evidenceClass ?? (corpus.length ? assertSingleEvidenceClass(corpus) : undefined);

  const qDup = duplicateKeyFor(query, opt.duplicateBucketMs);
  const qComparable = COMPARABILITY_KEYS.map((k) => query.vector.values[k]);

  const eligible: AnalogCorpusMember[] = [];
  for (const m of corpus) {
    if (m.id === query.id) { exclusions.SELF++; continue; }
    // A duplicate manifestation of the query itself is still the query.
    if ((m.dedupKey ?? duplicateKeyFor(m, opt.duplicateBucketMs)) === qDup) { exclusions.SELF++; continue; }
    if (!(m.labelEndMs <= fenceMs)) { exclusions.FUTURE_OR_UNRESOLVED_AT_T0++; continue; }
    if (requested && m.evidenceClass !== requested) { exclusions.EVIDENCE_CLASS_MISMATCH++; continue; }
    if (!m.vector.comparable) { exclusions.NOT_COMPARABLE_VECTOR++; continue; }
    const mismatch = COMPARABILITY_KEYS.some((k, i) => m.vector.values[k] !== qComparable[i]);
    if (mismatch) { exclusions.COMPARABILITY_MISMATCH++; continue; }
    eligible.push(m);
  }

  const model = fitRetrievalMetric(eligible);
  if (!model) {
    return emptyResult(exclusions, eligible.length, requested);
  }

  const dims = model.dims;
  const qvec = dims.map((d) => {
    const v = query.vector.values[d];
    return v === null || v === undefined ? null : v;
  });

  const scored: { m: AnalogCorpusMember; distance: number; sharedDims: string[]; droppedDims: string[]; coverage: number }[] = [];
  for (const m of eligible) {
    const mvec = dims.map((d) => {
      const v = m.vector.values[d];
      return v === null || v === undefined ? null : v;
    });
    const pd = mdistPartial(model, qvec, mvec);
    if (pd.distance === null || pd.coverage < opt.minCoverage) { exclusions.INSUFFICIENT_FEATURE_COVERAGE++; continue; }
    if (pd.distance > opt.maxRadius) { exclusions.BEYOND_RADIUS++; continue; }
    scored.push({ m, distance: pd.distance, sharedDims: pd.sharedDims, droppedDims: pd.droppedDims, coverage: pd.coverage });
  }

  // Deterministic ordering: distance, then id. The id tiebreak is load-bearing.
  scored.sort((a, b) => (a.distance - b.distance) || (a.m.id < b.m.id ? -1 : a.m.id > b.m.id ? 1 : 0));

  const perSymbol = new Map<string, number>();
  const perDup = new Map<string, number>();
  const kept: RetrievedAnalog[] = [];
  for (const s of scored) {
    if (kept.length >= opt.k) break;
    const dup = s.m.dedupKey ?? duplicateKeyFor(s.m, opt.duplicateBucketMs);
    const dupCount = perDup.get(dup) ?? 0;
    if (dupCount >= opt.perDuplicateCap) { exclusions.DUPLICATE_MANIFESTATION++; continue; }
    const symCount = perSymbol.get(s.m.symbol) ?? 0;
    if (symCount >= opt.perSymbolCap) { exclusions.PER_SYMBOL_CAP++; continue; }
    perDup.set(dup, dupCount + 1);
    perSymbol.set(s.m.symbol, symCount + 1);
    kept.push({
      id: s.m.id,
      symbol: s.m.symbol,
      tradingDay: s.m.tradingDay,
      t0Ms: s.m.t0Ms,
      distance: +s.distance.toFixed(6),
      sharedDims: s.sharedDims,
      droppedDims: s.droppedDims,
      coverage: +s.coverage.toFixed(4),
      evidenceClass: s.m.evidenceClass,
      outcome: s.m.outcome,
      sameSymbol: s.m.symbol === query.symbol,
    });
  }

  const sameSymbol = kept.filter((a) => a.sameSymbol).length;
  const crossSymbol = kept.length - sameSymbol;
  const symbolScope: RetrievalResult["composition"]["symbolScope"] =
    kept.length === 0 ? "NONE" : crossSymbol === 0 ? "SAME_SYMBOL" : sameSymbol === 0 ? "CROSS_SYMBOL" : "MIXED";
  const symbolCounts = new Map<string, number>();
  for (const a of kept) symbolCounts.set(a.symbol, (symbolCounts.get(a.symbol) ?? 0) + 1);

  return {
    retrievalVersion: ANALOG_RETRIEVAL_VERSION,
    featureVectorVersion: ANALOG_FEATURE_VECTOR_VERSION,
    analogs: kept,
    exclusions,
    eligibleCount: eligible.length,
    retrievedCount: kept.length,
    labeledCount: kept.filter((a) => a.outcome !== null).length,
    composition: {
      symbolScope,
      sameSymbol,
      crossSymbol,
      distinctSymbols: symbolCounts.size,
      distinctTradingDays: new Set(kept.map((a) => a.tradingDay)).size,
      evidenceClasses: evidenceClassComposition(kept),
      topSymbolShare: kept.length ? +(Math.max(...symbolCounts.values()) / kept.length).toFixed(4) : 0,
    },
    meanCoverage: kept.length ? +(kept.reduce((a, x) => a + x.coverage, 0) / kept.length).toFixed(4) : 0,
  };
}

function emptyResult(
  exclusions: Record<ExclusionReason, number>,
  eligibleCount: number,
  cls: AnalogEvidenceClass | undefined,
): RetrievalResult {
  return {
    retrievalVersion: ANALOG_RETRIEVAL_VERSION,
    featureVectorVersion: ANALOG_FEATURE_VECTOR_VERSION,
    analogs: [],
    exclusions,
    eligibleCount,
    retrievedCount: 0,
    labeledCount: 0,
    composition: {
      symbolScope: "NONE",
      sameSymbol: 0,
      crossSymbol: 0,
      distinctSymbols: 0,
      distinctTradingDays: 0,
      evidenceClasses: cls ? {} : {},
      topSymbolShare: 0,
    },
    meanCoverage: 0,
  };
}
