import test from "node:test";
import assert from "node:assert/strict";
import {
  trainLogistic,
  predictProba,
  standardizeParams,
  serializeModel,
  deserializeModel,
  defaultLogisticConfig,
} from "../lib/logistic-model.ts";

// A separable-ish 1-feature problem: feature > 0 → positive.
function dataset(n = 200) {
  const X = [], y = [];
  for (let i = 0; i < n; i++) {
    const f = (i % 2 === 0) ? 1 : -1;
    X.push([f, i % 3]); // second feature is noise
    y.push(f > 0 ? 1 : 0);
  }
  return { X, y };
}

test("standardize params floor constant-column std to 1", () => {
  const { means, stds } = standardizeParams([[5, 1], [5, 3], [5, 5]]);
  assert.equal(means[0], 5);
  assert.equal(stds[0], 1); // constant column
  assert.ok(stds[1] > 0);
});

test("training is deterministic for identical data", () => {
  const { X, y } = dataset();
  const names = ["f", "noise"];
  const a = trainLogistic(X, y, names, 1);
  const b = trainLogistic(X, y, names, 1);
  assert.deepEqual(a.weights, b.weights);
  assert.equal(a.bias, b.bias);
});

test("model learns the separating signal (higher proba for positive feature)", () => {
  const { X, y } = dataset();
  const m = trainLogistic(X, y, ["f", "noise"], 1);
  const pPos = predictProba(m, [1, 0]);
  const pNeg = predictProba(m, [-1, 0]);
  assert.ok(pPos > 0.5, `pPos ${pPos}`);
  assert.ok(pNeg < 0.5, `pNeg ${pNeg}`);
  assert.ok(pPos > pNeg);
});

test("probabilities are within [0,1]", () => {
  const { X, y } = dataset();
  const m = trainLogistic(X, y, ["f", "noise"], 1);
  for (const x of [[1, 0], [-1, 2], [0, 1]]) {
    const p = predictProba(m, x);
    assert.ok(p >= 0 && p <= 1);
  }
});

test("schema mismatch falls back to base rate (never guesses)", () => {
  const { X, y } = dataset();
  const m = trainLogistic(X, y, ["f", "noise"], 1);
  assert.equal(predictProba(m, [1]), m.baseRate); // wrong length
});

test("baseRate is captured from the training labels", () => {
  const m = trainLogistic([[1], [1], [1], [1]], [1, 1, 0, 0], ["f"], 1);
  assert.equal(m.baseRate, 0.5);
});

test("serialize/deserialize round-trips and predicts identically", () => {
  const { X, y } = dataset();
  const m = trainLogistic(X, y, ["f", "noise"], 1);
  const m2 = deserializeModel(serializeModel(m));
  assert.equal(predictProba(m, [1, 0]), predictProba(m2, [1, 0]));
});

test("empty training set yields a usable zero model", () => {
  const m = trainLogistic([], [], [], 1, defaultLogisticConfig());
  assert.equal(m.nTrain, 0);
  assert.equal(m.baseRate, 0);
});
