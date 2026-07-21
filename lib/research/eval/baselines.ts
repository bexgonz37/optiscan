/**
 * lib/research/eval/baselines.ts — the baseline recommenders the analog engine MUST beat
 * out-of-sample (Analog Engine, Phase B). PURE. If a candidate cannot beat these on
 * strictly out-of-sample data, it has no edge — that is the Phase D go/no-go.
 */
import type { Scorer } from "./types.ts";

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

/** Random selection — deterministic per-episode (reproducible), the null recommender. */
export function randomScorer(seed = 1): Scorer {
  return { name: "random", score: (i) => (hash(`${seed}:${i.id}`) % 10000) / 10000 };
}

/** Always trade — pure participation (score 1 for everything). */
export const alwaysTradeScorer: Scorer = { name: "always_trade", score: () => 1 };

/** Velocity ranking — score from a single momentum feature, squashed to [0,1]. */
export function velocityScorer(feature = "velocity"): Scorer {
  return { name: "velocity_rank", score: (i) => sigmoid((i.features[feature] ?? 0)) };
}

/** A basic hand rule: act when RVOL is high and velocity is positive. */
export function simpleRuleScorer(opts: { rvol?: string; vel?: string; rvolThr?: number } = {}): Scorer {
  const rvol = opts.rvol ?? "rvol", vel = opts.vel ?? "velocity", thr = opts.rvolThr ?? 2;
  return { name: "simple_rule", score: (i) => ((i.features[rvol] ?? 0) >= thr && (i.features[vel] ?? 0) > 0 ? 1 : 0) };
}

/**
 * A plain logistic baseline over a fixed feature list. Stateless variant uses supplied
 * weights; the trainable variant fits a simple logistic-regression by gradient descent on
 * the training episodes only — the "plain logistic model" baseline the engine must beat.
 */
export function logisticBaseline(featureNames: string[], opts: { epochs?: number; lr?: number } = {}): Scorer {
  let w = new Array(featureNames.length).fill(0);
  let b = 0;
  const x = (f: Record<string, number>) => featureNames.map((n) => f[n] ?? 0);
  return {
    name: "logistic",
    fit(train) {
      w = new Array(featureNames.length).fill(0); b = 0;
      const epochs = opts.epochs ?? 200, lr = opts.lr ?? 0.05;
      for (let e = 0; e < epochs; e++) {
        for (const t of train) {
          const xi = x(t.input.features);
          const z = xi.reduce((a, v, k) => a + v * w[k], b);
          const err = sigmoid(z) - (t.win ? 1 : 0);
          for (let k = 0; k < w.length; k++) w[k] -= lr * err * xi[k];
          b -= lr * err;
        }
      }
    },
    score: (i) => clamp01(sigmoid(x(i.features).reduce((a, v, k) => a + v * w[k], b))),
  };
}

/** Broker-visible baseline: the same rule form but restricted to what a Robinhood/Legend
 *  user could see (price/volume). Beating THIS is the "broker-missable" test. */
export function brokerVisibleScorer(brokerFeatures = ["price_change", "rvol"]): Scorer {
  return { name: "broker_visible", score: (i) => (brokerFeatures.every((f) => (i.features[f] ?? 0) > 0) ? 1 : 0) };
}

/** The standard suite the engine is benchmarked against. */
export function baselineSuite(featureNames: string[]): Scorer[] {
  return [randomScorer(), alwaysTradeScorer, velocityScorer(), simpleRuleScorer(), logisticBaseline(featureNames), brokerVisibleScorer()];
}
