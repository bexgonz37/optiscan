/**
 * lib/research/analog/similarity.ts — the Tier-1 (transparent) similarity metric
 * (Analog Engine, Phase D). PURE. Fit ONLY on training vectors.
 *
 * The metric is correlation-aware AND outcome-weighted:
 *   • z-score each feature (mean/std from TRAIN only),
 *   • decorrelate via a ridge-regularized precision matrix P = (Corr + λI)⁻¹ so a cluster
 *     of collinear features cannot dominate the distance,
 *   • scale each dimension by its outcome-separating power w_i (|point-biserial| with the
 *     win label) so an irrelevant feature contributes ~nothing.
 * Effective metric M = D·P·D (D = diag(w)); distance²(x,y) = (xz−yz)ᵀ M (xz−yz).
 * Everything is inspectable (weights, precision) — nothing is a black box.
 */

export interface MetricModel {
  dims: string[];
  mean: number[];
  std: number[];
  weights: number[];   // outcome-separating power per dim (0..1)
  M: number[][];       // effective metric (D P D)
}

const EPS = 1e-9;

export function zscore(vec: number[], mean: number[], std: number[]): number[] {
  return vec.map((v, i) => (Number.isFinite(v) ? (v - mean[i]) / (std[i] || 1) : 0));
}

/** Fit the metric from training vectors (rows) + win labels. `ridge` regularizes the
 *  correlation inverse; larger ridge → closer to plain weighted Euclidean. */
export function fitMetric(rows: number[][], wins: boolean[], dims: string[], ridge = 0.1): MetricModel {
  const n = rows.length, d = dims.length;
  const mean = new Array(d).fill(0), std = new Array(d).fill(1);
  for (let j = 0; j < d; j++) {
    let s = 0, c = 0;
    for (let i = 0; i < n; i++) if (Number.isFinite(rows[i][j])) { s += rows[i][j]; c++; }
    mean[j] = c ? s / c : 0;
    let v = 0; for (let i = 0; i < n; i++) if (Number.isFinite(rows[i][j])) v += (rows[i][j] - mean[j]) ** 2;
    std[j] = c > 1 ? Math.sqrt(v / (c - 1)) : 1; if (!(std[j] > EPS)) std[j] = 1;
  }
  const Z = rows.map((r) => zscore(r, mean, std));
  // Correlation matrix (Z already ~unit variance) + ridge.
  const corr = matrix(d, d);
  for (let a = 0; a < d; a++) for (let b = 0; b < d; b++) {
    let s = 0; for (let i = 0; i < n; i++) s += Z[i][a] * Z[i][b];
    corr[a][b] = s / Math.max(1, n - 1);
  }
  for (let a = 0; a < d; a++) corr[a][a] += ridge;
  const P = invert(corr);
  // Outcome weights: |point-biserial| of each z-feature with the win label, normalized to max 1.
  const weights = new Array(d).fill(0);
  const yMean = wins.filter(Boolean).length / Math.max(1, n);
  for (let j = 0; j < d; j++) {
    let cov = 0; for (let i = 0; i < n; i++) cov += Z[i][j] * ((wins[i] ? 1 : 0) - yMean);
    weights[j] = Math.abs(cov / Math.max(1, n));
  }
  const wMax = Math.max(EPS, ...weights);
  for (let j = 0; j < d; j++) weights[j] = 0.05 + 0.95 * (weights[j] / wMax); // floor so no dim is fully ignored
  // M = D P D.
  const M = matrix(d, d);
  for (let a = 0; a < d; a++) for (let b = 0; b < d; b++) M[a][b] = weights[a] * P[a][b] * weights[b];
  return { dims, mean, std, weights, M };
}

/** Squared distance between two RAW vectors under the fitted metric. */
export function mdist2(model: MetricModel, x: number[], y: number[]): number {
  const xz = zscore(x, model.mean, model.std), yz = zscore(y, model.mean, model.std);
  const d = model.dims.length; const diff = new Array(d);
  for (let i = 0; i < d; i++) diff[i] = xz[i] - yz[i];
  let s = 0;
  for (let a = 0; a < d; a++) { let row = 0; for (let b = 0; b < d; b++) row += model.M[a][b] * diff[b]; s += diff[a] * row; }
  return Math.max(0, s);
}
export const mdist = (m: MetricModel, x: number[], y: number[]): number => Math.sqrt(mdist2(m, x, y));

function matrix(r: number, c: number): number[][] { return Array.from({ length: r }, () => new Array(c).fill(0)); }

/** Gauss-Jordan inverse with partial pivoting (small d; ridge keeps it well-conditioned). */
function invert(A: number[][]): number[][] {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < EPS) { M[piv][col] = EPS; }
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let j = 0; j < 2 * n; j++) M[col][j] /= d;
    for (let r = 0; r < n; r++) if (r !== col) { const f = M[r][col]; for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[col][j]; }
  }
  return M.map((row) => row.slice(n));
}
