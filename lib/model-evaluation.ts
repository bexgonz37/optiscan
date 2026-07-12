/**
 * model-evaluation.ts — deterministic out-of-sample evaluation (Phase 4). PURE.
 *
 * Temporal (never random-only) validation: `chronologicalSplit` and `walkForward`
 * preserve completion order so a model is never evaluated on data that preceded
 * its training window. Metrics: Brier, log loss, ROC-AUC (only when BOTH classes
 * are present), calibration bins + ECE, and confusion at a documented threshold.
 */
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp01 = (p: number) => Math.min(1 - 1e-12, Math.max(1e-12, p));

export function baseRate(y: number[]): number {
  return y.length ? y.reduce((s, v) => s + (v > 0 ? 1 : 0), 0) / y.length : 0;
}

export function brierScore(yTrue: number[], yProb: number[]): number | null {
  const n = yTrue.length;
  if (!n || n !== yProb.length) return null;
  let s = 0;
  for (let i = 0; i < n; i++) s += (yProb[i] - (yTrue[i] > 0 ? 1 : 0)) ** 2;
  return +(s / n).toFixed(6);
}

export function logLoss(yTrue: number[], yProb: number[]): number | null {
  const n = yTrue.length;
  if (!n || n !== yProb.length) return null;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const p = clamp01(yProb[i]);
    s += (yTrue[i] > 0 ? -Math.log(p) : -Math.log(1 - p));
  }
  return +(s / n).toFixed(6);
}

/** ROC-AUC via rank statistic. Null unless BOTH classes are present. */
export function rocAuc(yTrue: number[], yProb: number[]): number | null {
  const n = yTrue.length;
  if (!n || n !== yProb.length) return null;
  const pos = yTrue.filter((v) => v > 0).length;
  const neg = n - pos;
  if (pos === 0 || neg === 0) return null;
  const idx = yProb.map((p, i) => ({ p, y: yTrue[i] > 0 ? 1 : 0 })).sort((a, b) => a.p - b.p);
  let rank = 1, i = 0, rankSumPos = 0;
  while (i < idx.length) {
    let j = i;
    while (j < idx.length && idx[j].p === idx[i].p) j++;
    const avgRank = (rank + (rank + (j - i) - 1)) / 2;
    for (let k = i; k < j; k++) if (idx[k].y === 1) rankSumPos += avgRank;
    rank += j - i;
    i = j;
  }
  const auc = (rankSumPos - (pos * (pos + 1)) / 2) / (pos * neg);
  return +auc.toFixed(6);
}

export interface CalibrationBin { lo: number; hi: number; count: number; meanPredicted: number | null; meanActual: number | null }

export function calibrationBins(yTrue: number[], yProb: number[], bins = 10): CalibrationBin[] {
  const out: CalibrationBin[] = [];
  for (let b = 0; b < bins; b++) {
    const lo = b / bins, hi = (b + 1) / bins;
    const inBin: number[] = [];
    const preds: number[] = [];
    for (let i = 0; i < yProb.length; i++) {
      const p = yProb[i];
      if ((p >= lo && p < hi) || (b === bins - 1 && p === 1)) { inBin.push(yTrue[i] > 0 ? 1 : 0); preds.push(p); }
    }
    out.push({
      lo, hi, count: inBin.length,
      meanPredicted: preds.length ? +(preds.reduce((s, v) => s + v, 0) / preds.length).toFixed(4) : null,
      meanActual: inBin.length ? +(inBin.reduce((s, v) => s + v, 0) / inBin.length).toFixed(4) : null,
    });
  }
  return out;
}

/** Expected Calibration Error (weighted |predicted − actual| over bins). */
export function expectedCalibrationError(yTrue: number[], yProb: number[], bins = 10): number | null {
  const n = yTrue.length;
  if (!n) return null;
  const cb = calibrationBins(yTrue, yProb, bins);
  let ece = 0;
  for (const b of cb) {
    if (!b.count || b.meanPredicted == null || b.meanActual == null) continue;
    ece += (b.count / n) * Math.abs(b.meanPredicted - b.meanActual);
  }
  return +ece.toFixed(6);
}

export interface Confusion { threshold: number; tp: number; fp: number; tn: number; fn: number; accuracy: number | null; precision: number | null; recall: number | null }

export function confusionAtThreshold(yTrue: number[], yProb: number[], threshold = 0.5): Confusion {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (let i = 0; i < yTrue.length; i++) {
    const pred = yProb[i] >= threshold ? 1 : 0;
    const act = yTrue[i] > 0 ? 1 : 0;
    if (pred && act) tp++; else if (pred && !act) fp++; else if (!pred && !act) tn++; else fn++;
  }
  const tot = tp + fp + tn + fn;
  return {
    threshold, tp, fp, tn, fn,
    accuracy: tot ? +((tp + tn) / tot).toFixed(4) : null,
    precision: tp + fp ? +(tp / (tp + fp)).toFixed(4) : null,
    recall: tp + fn ? +(tp / (tp + fn)).toFixed(4) : null,
  };
}

export interface EvaluationMetrics {
  n: number;
  baseRate: number;
  brier: number | null;
  baseRateBrier: number | null;   // Brier of always predicting the base rate
  logLoss: number | null;
  rocAuc: number | null;
  ece: number | null;
  calibration: CalibrationBin[];
  confusion: Confusion;
  bothClassesPresent: boolean;
}

export function evaluate(yTrue: number[], yProb: number[], threshold = 0.5): EvaluationMetrics {
  const n = yTrue.length;
  const br = baseRate(yTrue);
  const baseProbs = yTrue.map(() => br);
  const pos = yTrue.filter((v) => v > 0).length;
  return {
    n,
    baseRate: +br.toFixed(4),
    brier: brierScore(yTrue, yProb),
    baseRateBrier: brierScore(yTrue, baseProbs),
    logLoss: logLoss(yTrue, yProb),
    rocAuc: rocAuc(yTrue, yProb),
    ece: expectedCalibrationError(yTrue, yProb),
    calibration: calibrationBins(yTrue, yProb),
    confusion: confusionAtThreshold(yTrue, yProb, threshold),
    bothClassesPresent: pos > 0 && pos < n,
  };
}

/** Chronological split (data already ordered oldest→newest). No shuffling. */
export function chronologicalSplit<T>(rows: T[], trainFrac = 0.6, valFrac = 0.2): { train: T[]; val: T[]; test: T[] } {
  const n = rows.length;
  const a = Math.floor(n * trainFrac);
  const b = Math.floor(n * (trainFrac + valFrac));
  return { train: rows.slice(0, a), val: rows.slice(a, b), test: rows.slice(b) };
}

/** Walk-forward folds: expanding train window, each next block as the test fold. */
export function walkForwardFolds<T>(rows: T[], folds = 4, minTrain = 1): Array<{ train: T[]; test: T[] }> {
  const n = rows.length;
  const out: Array<{ train: T[]; test: T[] }> = [];
  if (n < folds + 1) return out;
  const blockSize = Math.floor(n / (folds + 1));
  if (blockSize < 1) return out;
  for (let f = 1; f <= folds; f++) {
    const trainEnd = blockSize * f;
    const testEnd = Math.min(n, blockSize * (f + 1));
    if (trainEnd < minTrain || testEnd <= trainEnd) continue;
    out.push({ train: rows.slice(0, trainEnd), test: rows.slice(trainEnd, testEnd) });
  }
  return out;
}
