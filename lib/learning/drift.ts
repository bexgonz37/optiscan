/**
 * learning/drift.ts — deterministic drift-state classification (Phase 7). PURE.
 *
 * Compares current health signals against a baseline + absolute thresholds and
 * returns ONE drift state with reason codes. It NEVER changes a rule or a model —
 * it only diagnoses. A DEGRADED/MODEL_STALE diagnosis tells the store to flag the
 * champion warning-only (never bypassing a hard gate).
 */
export type DriftState =
  | "HEALTHY"
  | "WATCH"
  | "DEGRADED"
  | "MODEL_STALE"
  | "DATA_DRIFT"
  | "PERFORMANCE_DRIFT"
  | "INSUFFICIENT_DATA";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export interface DriftThresholds {
  minGraded: number;
  modelStaleMs: number;
  minCoverage: number;
  maxStaleFreq: number;
  maxRejectFreq: number;
  brierWorsenAbs: number;   // Brier increase that counts as performance drift
  winRateDropAbs: number;   // win-rate drop (fraction) that counts as drift
  eceWorsenAbs: number;
}

export function defaultDriftThresholds(env: NodeJS.ProcessEnv = process.env): DriftThresholds {
  const n = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    minGraded: n(env.DRIFT_MIN_GRADED, 20),
    modelStaleMs: n(env.DRIFT_MODEL_STALE_DAYS, 14) * 86_400_000,
    minCoverage: n(env.DRIFT_MIN_COVERAGE, 0.9),
    maxStaleFreq: n(env.DRIFT_MAX_STALE_FREQ, 0.4),
    maxRejectFreq: n(env.DRIFT_MAX_REJECT_FREQ, 0.6),
    brierWorsenAbs: n(env.DRIFT_BRIER_WORSEN, 0.05),
    winRateDropAbs: n(env.DRIFT_WINRATE_DROP, 0.15),
    eceWorsenAbs: n(env.DRIFT_ECE_WORSEN, 0.1),
  };
}

export interface DriftInputs {
  gradedSample: number;
  coverage: number | null;
  staleDataFreq: number | null;      // fraction of recent decisions blocked by stale data
  contractRejectFreq: number | null; // fraction of selections rejected
  modelAgeMs: number | null;         // age of the active champion, null if none
  baseWinRate: number | null;        // fraction
  curWinRate: number | null;
  baseBrier: number | null;
  curBrier: number | null;
  baseEce: number | null;
  curEce: number | null;
}

export interface DriftResult {
  state: DriftState;
  reasons: string[];
  signals: string[]; // every triggered signal (for audit), even when overall HEALTHY/WATCH
}

/** Classify the drift state deterministically. */
export function classifyDrift(input: DriftInputs, t: DriftThresholds = defaultDriftThresholds()): DriftResult {
  const signals: string[] = [];

  if (input.gradedSample < t.minGraded) {
    return { state: "INSUFFICIENT_DATA", reasons: [`only ${input.gradedSample} graded outcomes (< ${t.minGraded})`], signals };
  }

  // Data-quality / pipeline drift.
  let dataDrift = false;
  if (isNum(input.coverage) && input.coverage < t.minCoverage) { signals.push(`coverage ${Math.round(input.coverage * 100)}% < ${Math.round(t.minCoverage * 100)}%`); dataDrift = true; }
  if (isNum(input.staleDataFreq) && input.staleDataFreq > t.maxStaleFreq) { signals.push(`stale-data frequency ${Math.round(input.staleDataFreq * 100)}% high`); dataDrift = true; }
  if (isNum(input.contractRejectFreq) && input.contractRejectFreq > t.maxRejectFreq) { signals.push(`contract-rejection frequency ${Math.round(input.contractRejectFreq * 100)}% high`); dataDrift = true; }

  // Model staleness.
  const modelStale = isNum(input.modelAgeMs) && input.modelAgeMs > t.modelStaleMs;
  if (modelStale) signals.push(`champion age exceeds ${Math.round(t.modelStaleMs / 86_400_000)}d`);

  // Performance / calibration drift.
  let perfDrift = false;
  if (isNum(input.baseBrier) && isNum(input.curBrier) && input.curBrier - input.baseBrier > t.brierWorsenAbs) { signals.push(`Brier worsened ${(input.curBrier - input.baseBrier).toFixed(3)}`); perfDrift = true; }
  if (isNum(input.baseWinRate) && isNum(input.curWinRate) && input.baseWinRate - input.curWinRate > t.winRateDropAbs) { signals.push(`win rate dropped ${Math.round((input.baseWinRate - input.curWinRate) * 100)}pts`); perfDrift = true; }
  if (isNum(input.baseEce) && isNum(input.curEce) && input.curEce - input.baseEce > t.eceWorsenAbs) { signals.push(`calibration (ECE) worsened ${(input.curEce - input.baseEce).toFixed(3)}`); perfDrift = true; }

  const flags = [dataDrift, modelStale, perfDrift].filter(Boolean).length;

  let state: DriftState;
  if (flags >= 2) state = "DEGRADED";
  else if (perfDrift) state = "PERFORMANCE_DRIFT";
  else if (dataDrift) state = "DATA_DRIFT";
  else if (modelStale) state = "MODEL_STALE";
  else if (signals.length) state = "WATCH";
  else state = "HEALTHY";

  return { state, reasons: signals.length ? signals : ["all monitored signals within tolerance"], signals };
}

/** Whether a drift state should flag the champion warning-only (never bypasses gates). */
export function isDegraded(state: DriftState): boolean {
  return state === "DEGRADED" || state === "MODEL_STALE" || state === "PERFORMANCE_DRIFT";
}
