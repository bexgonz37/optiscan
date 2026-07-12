/**
 * logistic-model.ts — interpretable, deterministic L2-regularized logistic
 * regression (Phase 4). PURE: no I/O, no RNG. Fixed zero-initialized weights and
 * a fixed number of full-batch gradient-descent steps ⇒ identical model for
 * identical data (reproducible training). Standardization params are baked into
 * the model so `predictProba` is self-contained.
 *
 * This is a calibrated EVIDENCE score, never a trading permission. It cannot and
 * does not override any hard gate — the caller enforces that.
 */
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export interface LogisticConfig {
  l2: number;
  learningRate: number;
  epochs: number;
}

export function defaultLogisticConfig(): LogisticConfig {
  return { l2: 1.0, learningRate: 0.1, epochs: 500 };
}

export interface LogisticModel {
  weights: number[];
  bias: number;
  means: number[];
  stds: number[];
  featureNames: string[];
  featureSchemaVersion: number;
  config: LogisticConfig;
  nTrain: number;
  baseRate: number;
}

function sigmoid(z: number): number {
  if (z >= 0) { const e = Math.exp(-z); return 1 / (1 + e); }
  const e = Math.exp(z); return e / (1 + e);
}

/** Column means/stds (std floored to 1 for constant columns ⇒ no divide-by-zero). */
export function standardizeParams(X: number[][]): { means: number[]; stds: number[] } {
  const n = X.length;
  const d = n ? X[0].length : 0;
  const means = new Array(d).fill(0);
  const stds = new Array(d).fill(1);
  if (!n) return { means, stds };
  for (const row of X) for (let j = 0; j < d; j++) means[j] += row[j];
  for (let j = 0; j < d; j++) means[j] /= n;
  const varr = new Array(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j++) varr[j] += (row[j] - means[j]) ** 2;
  for (let j = 0; j < d; j++) {
    const sd = Math.sqrt(varr[j] / n);
    stds[j] = sd > 1e-9 ? sd : 1;
  }
  return { means, stds };
}

function applyStandardize(x: number[], means: number[], stds: number[]): number[] {
  return x.map((v, j) => (v - means[j]) / stds[j]);
}

/** Train a deterministic L2 logistic regression. y ∈ {0,1}. */
export function trainLogistic(
  X: number[][],
  y: number[],
  featureNames: string[],
  featureSchemaVersion: number,
  config: LogisticConfig = defaultLogisticConfig(),
): LogisticModel {
  const n = X.length;
  const d = n ? X[0].length : 0;
  const { means, stds } = standardizeParams(X);
  const Xs = X.map((r) => applyStandardize(r, means, stds));
  const weights = new Array(d).fill(0);
  let bias = 0;
  const baseRate = n ? y.reduce((s, v) => s + (v > 0 ? 1 : 0), 0) / n : 0;

  for (let epoch = 0; epoch < config.epochs && n > 0; epoch++) {
    const gradW = new Array(d).fill(0);
    let gradB = 0;
    for (let i = 0; i < n; i++) {
      let z = bias;
      const xi = Xs[i];
      for (let j = 0; j < d; j++) z += weights[j] * xi[j];
      const err = sigmoid(z) - (y[i] > 0 ? 1 : 0);
      for (let j = 0; j < d; j++) gradW[j] += err * xi[j];
      gradB += err;
    }
    for (let j = 0; j < d; j++) {
      const g = gradW[j] / n + config.l2 * weights[j] / n;
      weights[j] -= config.learningRate * g;
    }
    bias -= config.learningRate * (gradB / n);
  }

  return { weights, bias, means, stds, featureNames, featureSchemaVersion, config, nTrain: n, baseRate };
}

/** Predict P(positive net outcome) for one standardized-on-the-fly feature vector. */
export function predictProba(model: LogisticModel, x: number[]): number {
  if (x.length !== model.weights.length) {
    // Schema mismatch ⇒ refuse to guess; fall back to the base rate.
    return model.baseRate;
  }
  const xs = applyStandardize(x, model.means, model.stds);
  let z = model.bias;
  for (let j = 0; j < model.weights.length; j++) z += model.weights[j] * xs[j];
  const p = sigmoid(z);
  return isNum(p) ? p : model.baseRate;
}

/** Serialize / restore (JSON-safe). */
export function serializeModel(m: LogisticModel): string {
  return JSON.stringify(m);
}
export function deserializeModel(raw: string): LogisticModel {
  return JSON.parse(raw) as LogisticModel;
}
