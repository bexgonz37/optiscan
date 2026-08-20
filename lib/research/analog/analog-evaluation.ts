/**
 * analog-evaluation.ts — ANALOG_EVAL_V1. Does the retrieval actually predict anything?
 *
 * ── Why a second evaluator next to eval/harness.ts ───────────────────────────
 *
 * `eval/harness.ts` evaluates a `Scorer` — fit on a train block, score a later test block.
 * It is correct and it stays. It cannot evaluate THIS engine, because retrieval here has no
 * fit/score split to enforce: the chronological fence lives inside `retrieveAnalogs`, which
 * re-derives the usable population per query from that query's own T0. What needs measuring
 * is therefore not "did the harness hold the split" but "does the fence hold when the corpus
 * is one undivided pile" — which is the configuration a research surface actually runs in.
 *
 * So this evaluator hands the WHOLE corpus to every query and relies on the fence, then
 * checks the fence's work: `leakageAudit` re-verifies, per prediction, that nothing it
 * retrieved began resolving after the query's decision time. An evaluation that trusted the
 * component it is evaluating would be worth nothing.
 *
 * ── Chronological separation on top of the fence ─────────────────────────────
 *
 * Queries are drawn only from the LAST `evalFraction` of the corpus by time. The fence
 * already makes an early query useless (nothing has resolved before it), so this is not
 * redundancy — it is what stops the reported coverage from being dominated by queries that
 * could never have had evidence.
 *
 * ── What is reported, and what is refused ────────────────────────────────────
 *
 * Calibration needs enough predictions per bucket to mean anything. A bucket with four
 * predictions has a "realized frequency" that moves 25 points per case, and printing it next
 * to a probability invites exactly the wrong conclusion. Buckets below the floor report
 * INSUFFICIENT_EVIDENCE and are excluded from ECE rather than smoothed into it.
 *
 * Brier and ECE are computed over ACTING predictions only, and the abstention rate is
 * reported beside them. A model that abstains on 97% of queries and is well calibrated on
 * the rest has not earned a calibration claim; it has earned a coverage problem.
 *
 * ── No tuning here ───────────────────────────────────────────────────────────
 *
 * This module has no search, no parameter sweep, no "best of". It runs one configuration and
 * reports it. Choosing the configuration that scored best on this set is how a backtest
 * becomes a story, and it is the specific thing the session brief forbids.
 */
import { countIndependentSessions } from "../historical/trading-sessions.ts";
import {
  ANALOG_MIN_INDEPENDENT_SESSIONS,
  ANALOG_MIN_OBSERVATIONS,
} from "./cohort-outcomes.ts";
import { ANALOG_FEATURE_VECTOR_VERSION } from "./feature-vector.ts";
import {
  ANALOG_RETRIEVAL_VERSION,
  retrieveAnalogs,
  type AnalogCorpusMember,
  type RetrievalOptions,
} from "./retrieval.ts";
import type { AnalogEvidenceClass } from "./evidence-class.ts";

export const ANALOG_EVAL_VERSION = "ANALOG_EVAL_V1";

/** Minimum predictions before a calibration bucket may state a realized frequency. */
export const MIN_BUCKET_PREDICTIONS = 20;

export interface AnalogEvalOptions {
  /** Fraction of the corpus (by time, from the end) used as evaluation queries. */
  evalFraction?: number;
  /** Retrieval configuration; passed through unchanged to every query. */
  retrieval?: RetrievalOptions;
  minObservations?: number;
  minIndependentSessions?: number;
  /** Cap on evaluation queries, for bounded runtime. Reported when it binds. */
  maxQueries?: number;
}

export interface AnalogPrediction {
  id: string;
  symbol: string;
  t0Ms: number;
  tradingDay: string;
  /** Null when the query abstained. */
  predicted: number | null;
  /** Realized outcome; null when the query episode itself is censored. */
  realized: number | null;
  win: boolean | null;
  abstained: boolean;
  abstainReason: string | null;
  retrievedCount: number;
  labeledCount: number;
  independentSessions: number;
  sameSymbol: number;
  crossSymbol: number;
  /** The latest labelEndMs among retrieved analogs — must be <= t0Ms. */
  maxAnalogLabelEndMs: number | null;
}

export interface CalibrationBucket {
  lo: number;
  hi: number;
  n: number;
  meanPredicted: number | null;
  realizedFrequency: number | null;
  verdict: "SUPPORTED" | "INSUFFICIENT_EVIDENCE";
}

export interface AnalogEvalReport {
  evalVersion: string;
  retrievalVersion: string;
  featureVectorVersion: string;
  evidenceClass: AnalogEvidenceClass | null;
  corpusSize: number;
  /** Chronological boundary: queries are drawn at/after this time. */
  evalFromMs: number | null;
  evalToMs: number | null;
  queries: number;
  queriesCapped: boolean;
  acted: number;
  abstained: number;
  abstentionRate: number;
  coverage: number;
  /** Over acting predictions only. Null when nothing acted. */
  brier: number | null;
  ece: number | null;
  /** Mean realized outcome when the engine acted vs when it abstained. */
  meanOutcomeActed: number | null;
  meanOutcomeAbstained: number | null;
  /** Rank discrimination: realized win rate in the top vs bottom predicted tercile. */
  discrimination: {
    topTercileWinRate: number | null;
    bottomTercileWinRate: number | null;
    spread: number | null;
    verdict: "SUPPORTED" | "INSUFFICIENT_EVIDENCE";
  };
  calibration: CalibrationBucket[];
  composition: {
    sameSymbolPredictions: number;
    crossSymbolPredictions: number;
    mixedPredictions: number;
    distinctQuerySymbols: number;
    independentQuerySessions: number;
  };
  leakageAudit: {
    checkedPredictions: number;
    futureAnalogViolations: number;
    selfRetrievalViolations: number;
    verdict: "CLEAN" | "LEAK_DETECTED";
  };
  overallVerdict: "SUPPORTED" | "INSUFFICIENT_EVIDENCE";
  verdictReason: string;
  researchAuthority: "RESEARCH_ONLY";
  calibrationStatus: "NOT_CALIBRATED_FOR_LIVE_AUTHORITY";
}

const BUCKETS: Array<[number, number]> = [
  [0.0, 0.2], [0.2, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.8], [0.8, 1.0001],
];

/**
 * Run the chronological out-of-sample evaluation.
 * Deterministic: same corpus + same options ⇒ byte-identical report (no clock, no random).
 */
export function evaluateAnalogRetrieval(
  corpus: readonly AnalogCorpusMember[],
  options: AnalogEvalOptions = {},
): AnalogEvalReport {
  const evalFraction = options.evalFraction ?? 0.3;
  const minObs = options.minObservations ?? ANALOG_MIN_OBSERVATIONS;
  const minSes = options.minIndependentSessions ?? ANALOG_MIN_INDEPENDENT_SESSIONS;
  const maxQueries = options.maxQueries ?? 2000;

  const sorted = [...corpus].sort((a, b) => (a.t0Ms - b.t0Ms) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const evidenceClass = sorted.length ? sorted[0].evidenceClass : null;

  const cut = Math.floor(sorted.length * (1 - evalFraction));
  const allQueries = sorted.slice(cut);
  const queriesCapped = allQueries.length > maxQueries;
  // Keep the LAST maxQueries — the most evidence-rich end of the corpus.
  const queries = queriesCapped ? allQueries.slice(allQueries.length - maxQueries) : allQueries;

  const predictions: AnalogPrediction[] = [];
  let futureViolations = 0;
  let selfViolations = 0;
  // Index once. Re-scanning the corpus per retrieved analog would make the audit itself
  // the most expensive part of the evaluation.
  const byId = new Map(sorted.map((m) => [m.id, m]));

  for (const q of queries) {
    const r = retrieveAnalogs(
      { id: q.id, symbol: q.symbol, t0Ms: q.t0Ms, vector: q.vector },
      sorted,
      options.retrieval,
    );
    const labeled = r.analogs.filter((a) => a.outcome !== null);
    const sessions = countIndependentSessions(labeled.map((a) => a.tradingDay)).independentSessions;

    // Audit the fence rather than trust it.
    let maxEnd: number | null = null;
    for (const a of r.analogs) {
      const member = byId.get(a.id);
      if (!member) continue;
      if (member.labelEndMs > q.t0Ms) futureViolations++;
      if (member.id === q.id) selfViolations++;
      maxEnd = maxEnd === null || member.labelEndMs > maxEnd ? member.labelEndMs : maxEnd;
    }

    const insufficient = labeled.length < minObs || sessions < minSes;
    const predicted = insufficient ? null : labeled.filter((a) => (a.outcome as number) > 0).length / labeled.length;

    predictions.push({
      id: q.id, symbol: q.symbol, t0Ms: q.t0Ms, tradingDay: q.tradingDay,
      predicted,
      realized: q.outcome,
      win: q.outcome === null ? null : q.outcome > 0,
      abstained: insufficient,
      abstainReason: insufficient
        ? `${labeled.length} resolved analogs (min ${minObs}) over ${sessions} independent sessions (min ${minSes})`
        : null,
      retrievedCount: r.retrievedCount,
      labeledCount: labeled.length,
      independentSessions: sessions,
      sameSymbol: r.composition.sameSymbol,
      crossSymbol: r.composition.crossSymbol,
      maxAnalogLabelEndMs: maxEnd,
    });
  }

  // Scoreable = the engine acted AND the query's own outcome resolved.
  const scoreable = predictions.filter((p) => !p.abstained && p.predicted !== null && p.win !== null);
  const acted = predictions.filter((p) => !p.abstained).length;
  const abstained = predictions.length - acted;

  const brier = scoreable.length
    ? +(scoreable.reduce((a, p) => a + ((p.predicted as number) - (p.win ? 1 : 0)) ** 2, 0) / scoreable.length).toFixed(6)
    : null;

  const calibration: CalibrationBucket[] = BUCKETS.map(([lo, hi]) => {
    const inBucket = scoreable.filter((p) => (p.predicted as number) >= lo && (p.predicted as number) < hi);
    const supported = inBucket.length >= MIN_BUCKET_PREDICTIONS;
    return {
      lo, hi: hi > 1 ? 1 : hi, n: inBucket.length,
      meanPredicted: supported
        ? +(inBucket.reduce((a, p) => a + (p.predicted as number), 0) / inBucket.length).toFixed(4)
        : null,
      realizedFrequency: supported
        ? +(inBucket.filter((p) => p.win).length / inBucket.length).toFixed(4)
        : null,
      verdict: supported ? "SUPPORTED" : "INSUFFICIENT_EVIDENCE",
    };
  });

  // ECE over supported buckets only; null when no bucket cleared the floor.
  const supportedBuckets = calibration.filter((b) => b.verdict === "SUPPORTED");
  const supportedN = supportedBuckets.reduce((a, b) => a + b.n, 0);
  const ece = supportedN
    ? +(supportedBuckets.reduce(
        (a, b) => a + (b.n / supportedN) * Math.abs((b.meanPredicted as number) - (b.realizedFrequency as number)),
        0,
      ).toFixed(6))
    : null;

  const outcomesActed = predictions.filter((p) => !p.abstained && p.realized !== null).map((p) => p.realized as number);
  const outcomesAbstained = predictions.filter((p) => p.abstained && p.realized !== null).map((p) => p.realized as number);
  const mean = (xs: number[]): number | null => (xs.length ? +(xs.reduce((a, x) => a + x, 0) / xs.length).toFixed(6) : null);

  // Discrimination by predicted tercile.
  const ranked = [...scoreable].sort((a, b) => ((a.predicted as number) - (b.predicted as number)) || (a.id < b.id ? -1 : 1));
  const third = Math.floor(ranked.length / 3);
  const bottom = ranked.slice(0, third);
  const top = ranked.slice(ranked.length - third);
  const discSupported = third >= MIN_BUCKET_PREDICTIONS;
  const topWr = discSupported ? +(top.filter((p) => p.win).length / top.length).toFixed(4) : null;
  const botWr = discSupported ? +(bottom.filter((p) => p.win).length / bottom.length).toFixed(4) : null;

  const querySessions = countIndependentSessions(predictions.map((p) => p.tradingDay)).independentSessions;

  const reasons: string[] = [];
  if (scoreable.length < ANALOG_MIN_OBSERVATIONS) reasons.push(`${scoreable.length} scoreable predictions < ${ANALOG_MIN_OBSERVATIONS}`);
  if (querySessions < ANALOG_MIN_INDEPENDENT_SESSIONS) reasons.push(`${querySessions} independent query sessions < ${ANALOG_MIN_INDEPENDENT_SESSIONS}`);
  if (supportedN === 0) reasons.push("no calibration bucket reached the minimum prediction count");

  return {
    evalVersion: ANALOG_EVAL_VERSION,
    retrievalVersion: ANALOG_RETRIEVAL_VERSION,
    featureVectorVersion: ANALOG_FEATURE_VECTOR_VERSION,
    evidenceClass,
    corpusSize: sorted.length,
    evalFromMs: queries.length ? queries[0].t0Ms : null,
    evalToMs: queries.length ? queries[queries.length - 1].t0Ms : null,
    queries: predictions.length,
    queriesCapped,
    acted,
    abstained,
    abstentionRate: predictions.length ? +(abstained / predictions.length).toFixed(4) : 1,
    coverage: predictions.length ? +(acted / predictions.length).toFixed(4) : 0,
    brier,
    ece,
    meanOutcomeActed: mean(outcomesActed),
    meanOutcomeAbstained: mean(outcomesAbstained),
    discrimination: {
      topTercileWinRate: topWr,
      bottomTercileWinRate: botWr,
      spread: topWr !== null && botWr !== null ? +(topWr - botWr).toFixed(4) : null,
      verdict: discSupported ? "SUPPORTED" : "INSUFFICIENT_EVIDENCE",
    },
    calibration,
    composition: {
      sameSymbolPredictions: predictions.filter((p) => p.sameSymbol > 0 && p.crossSymbol === 0).length,
      crossSymbolPredictions: predictions.filter((p) => p.crossSymbol > 0 && p.sameSymbol === 0).length,
      mixedPredictions: predictions.filter((p) => p.sameSymbol > 0 && p.crossSymbol > 0).length,
      distinctQuerySymbols: new Set(predictions.map((p) => p.symbol)).size,
      independentQuerySessions: querySessions,
    },
    leakageAudit: {
      checkedPredictions: predictions.length,
      futureAnalogViolations: futureViolations,
      selfRetrievalViolations: selfViolations,
      verdict: futureViolations === 0 && selfViolations === 0 ? "CLEAN" : "LEAK_DETECTED",
    },
    overallVerdict: reasons.length === 0 ? "SUPPORTED" : "INSUFFICIENT_EVIDENCE",
    verdictReason: reasons.length === 0
      ? `${scoreable.length} scoreable out-of-sample predictions over ${querySessions} independent sessions`
      : reasons.join("; "),
    researchAuthority: "RESEARCH_ONLY",
    calibrationStatus: "NOT_CALIBRATED_FOR_LIVE_AUTHORITY",
  };
}
