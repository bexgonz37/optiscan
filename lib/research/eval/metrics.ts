/**
 * lib/research/eval/metrics.ts — PURE evaluation metrics (Analog Engine, Phase B).
 *
 * These are the honesty instruments. A recommender is not judged by returns alone but by
 * calibrated expectancy and by whether it beats baselines with a confidence interval that
 * excludes zero. No metric here consults anything but the (score, outcome) pairs handed in.
 */

/** One graded prediction: a probability-of-win `p` in [0,1], the realized `win`, and the
 *  realized `outcome` (e.g. forward return or R-multiple) used for expectancy. */
export interface Prediction {
  p: number;          // predicted win probability / confidence, 0..1
  win: boolean;       // realized win
  outcome: number;    // realized signed outcome (e.g. return %) for expectancy
  selected?: boolean; // whether the recommender acted (default: p >= 0.5)
}

const sel = (ps: Prediction[]) => ps.filter((x) => x.selected ?? x.p >= 0.5);

export function coverage(ps: Prediction[]): number {
  return ps.length ? sel(ps).length / ps.length : 0;
}
export function expectancy(ps: Prediction[]): number {
  const s = sel(ps);
  return s.length ? s.reduce((a, x) => a + x.outcome, 0) / s.length : 0;
}
export function hitRate(ps: Prediction[]): number {
  const s = sel(ps);
  return s.length ? s.filter((x) => x.win).length / s.length : 0;
}
export function profitFactor(ps: Prediction[]): number | null {
  const s = sel(ps);
  const gain = s.filter((x) => x.outcome > 0).reduce((a, x) => a + x.outcome, 0);
  const loss = Math.abs(s.filter((x) => x.outcome <= 0).reduce((a, x) => a + x.outcome, 0));
  return loss > 0 ? +(gain / loss).toFixed(4) : null;
}

/** Brier score over ALL predictions (calibration of p vs realized win). Lower is better. */
export function brier(ps: Prediction[]): number {
  if (!ps.length) return 0;
  return ps.reduce((a, x) => a + (x.p - (x.win ? 1 : 0)) ** 2, 0) / ps.length;
}

export interface ReliabilityBucket { lo: number; hi: number; n: number; meanP: number; meanRealized: number }

/** Reliability curve: bucket by predicted p, compare mean predicted vs realized win rate. */
export function reliabilityCurve(ps: Prediction[], nBuckets = 10): ReliabilityBucket[] {
  const out: ReliabilityBucket[] = [];
  for (let b = 0; b < nBuckets; b++) {
    const lo = b / nBuckets, hi = (b + 1) / nBuckets;
    const inb = ps.filter((x) => (b === nBuckets - 1 ? x.p >= lo && x.p <= hi : x.p >= lo && x.p < hi));
    out.push({
      lo, hi, n: inb.length,
      meanP: inb.length ? inb.reduce((a, x) => a + x.p, 0) / inb.length : 0,
      meanRealized: inb.length ? inb.filter((x) => x.win).length / inb.length : 0,
    });
  }
  return out;
}

/** Expected Calibration Error — |predicted − realized| weighted by bucket population. */
export function ece(ps: Prediction[], nBuckets = 10): number {
  if (!ps.length) return 0;
  return reliabilityCurve(ps, nBuckets).reduce((a, b) => a + (b.n / ps.length) * Math.abs(b.meanP - b.meanRealized), 0);
}

// ── bootstrap CI (deterministic PRNG so runs are reproducible) ───────────────
function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export interface CI { point: number; lo: number; hi: number; significant: boolean }

/**
 * Paired bootstrap CI for the LIFT of a candidate over a baseline on a per-episode statistic
 * (e.g. per-episode outcome among selected). `significant` = the CI excludes zero. This is the
 * multiple-testing-aware honesty gate: a scorer only "wins" if lift CI is strictly above 0.
 */
export function bootstrapLiftCI(candidatePer: number[], baselinePer: number[], iters = 2000, alpha = 0.05, seed = 12345): CI {
  const n = Math.min(candidatePer.length, baselinePer.length);
  if (n === 0) return { point: 0, lo: 0, hi: 0, significant: false };
  const diff = Array.from({ length: n }, (_, i) => candidatePer[i] - baselinePer[i]);
  const point = diff.reduce((a, x) => a + x, 0) / n;
  const rnd = mulberry32(seed);
  const means: number[] = [];
  for (let b = 0; b < iters; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += diff[(rnd() * n) | 0];
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor((alpha / 2) * iters)];
  const hi = means[Math.floor((1 - alpha / 2) * iters)];
  return { point: +point.toFixed(6), lo: +lo.toFixed(6), hi: +hi.toFixed(6), significant: lo > 0 };
}
