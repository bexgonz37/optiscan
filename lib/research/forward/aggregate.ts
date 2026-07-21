/**
 * lib/research/forward/aggregate.ts — pure forward-performance statistics (Phase F).
 * No I/O. Operates on plain graded-item arrays so it is trivially testable.
 */
export interface GradedItem { bucketKey: string; confidence: number; returnPct: number; win: boolean; capturedAtMs: number }

export function winRate(items: { win: boolean }[]): number { return items.length ? +(items.filter((i) => i.win).length / items.length).toFixed(4) : 0; }
export function expectancy(items: { returnPct: number }[]): number { return items.length ? +(items.reduce((a, i) => a + i.returnPct, 0) / items.length).toFixed(6) : 0; }

/** Max peak-to-trough drawdown of the cumulative return path (chronological order). */
export function maxDrawdown(items: GradedItem[]): number {
  const seq = [...items].sort((a, b) => a.capturedAtMs - b.capturedAtMs);
  let cum = 0, peak = 0, mdd = 0;
  for (const i of seq) { cum += i.returnPct; peak = Math.max(peak, cum); mdd = Math.min(mdd, cum - peak); }
  return +mdd.toFixed(6);
}

export interface BucketStat { bucketKey: string; n: number; winRate: number; expectancy: number }
export function bucketStats(items: GradedItem[]): BucketStat[] {
  const by = new Map<string, GradedItem[]>();
  for (const i of items) { const a = by.get(i.bucketKey) ?? []; a.push(i); by.set(i.bucketKey, a); }
  return [...by.entries()].map(([bucketKey, arr]) => ({ bucketKey, n: arr.length, winRate: winRate(arr), expectancy: expectancy(arr) })).sort((a, b) => b.n - a.n);
}

export interface CalibrationBin { bucket: string; lo: number; hi: number; n: number; predicted: number; actual: number }
export interface Calibration { bins: CalibrationBin[]; brier: number | null; ece: number | null }

/** Calibration of confidence vs realized win rate, in fixed confidence bins + Brier + ECE. */
export function calibrationByConfidence(items: { confidence: number; win: boolean }[]): Calibration {
  const edges = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0001];
  const bins: CalibrationBin[] = [];
  let eceNum = 0;
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i], hi = edges[i + 1];
    const inBin = items.filter((x) => x.confidence >= lo && x.confidence < hi);
    if (inBin.length === 0) { bins.push({ bucket: `${lo}-${Math.min(hi, 1)}`, lo, hi: Math.min(hi, 1), n: 0, predicted: 0, actual: 0 }); continue; }
    const predicted = +(inBin.reduce((a, x) => a + x.confidence, 0) / inBin.length).toFixed(4);
    const actual = +(inBin.filter((x) => x.win).length / inBin.length).toFixed(4);
    bins.push({ bucket: `${lo}-${Math.min(hi, 1)}`, lo, hi: Math.min(hi, 1), n: inBin.length, predicted, actual });
    eceNum += inBin.length * Math.abs(predicted - actual);
  }
  const brier = items.length ? +(items.reduce((a, x) => a + (x.confidence - (x.win ? 1 : 0)) ** 2, 0) / items.length).toFixed(6) : null;
  const ece = items.length ? +(eceNum / items.length).toFixed(6) : null;
  return { bins, brier, ece };
}
