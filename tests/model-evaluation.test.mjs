import test from "node:test";
import assert from "node:assert/strict";
import {
  brierScore, logLoss, rocAuc, expectedCalibrationError, calibrationBins,
  confusionAtThreshold, evaluate, chronologicalSplit, walkForwardFolds, baseRate,
} from "../lib/model-evaluation.ts";

test("brier score of perfect predictions is 0", () => {
  assert.equal(brierScore([1, 0, 1], [1, 0, 1]), 0);
});

test("brier score of worst predictions is 1", () => {
  assert.equal(brierScore([1, 0], [0, 1]), 1);
});

test("log loss penalizes confident wrong predictions heavily", () => {
  const good = logLoss([1, 0], [0.9, 0.1]);
  const bad = logLoss([1, 0], [0.1, 0.9]);
  assert.ok(bad > good);
});

test("ROC-AUC is null unless both classes present", () => {
  assert.equal(rocAuc([1, 1, 1], [0.2, 0.5, 0.8]), null);
  assert.equal(rocAuc([0, 0, 0], [0.2, 0.5, 0.8]), null);
  assert.equal(rocAuc([0, 1], [0.2, 0.8]), 1); // perfectly ranked
});

test("ROC-AUC of a perfect ranker is 1, random-ish is ~0.5", () => {
  const yt = [0, 0, 1, 1];
  assert.equal(rocAuc(yt, [0.1, 0.2, 0.8, 0.9]), 1);
  const mid = rocAuc(yt, [0.5, 0.5, 0.5, 0.5]);
  assert.ok(mid >= 0.4 && mid <= 0.6);
});

test("calibration bins + ECE reward calibrated probabilities", () => {
  // 100 samples, predicted 0.5, actual ~0.5 → low ECE
  const yt = Array.from({ length: 100 }, (_, i) => (i % 2 ? 1 : 0));
  const yp = yt.map(() => 0.5);
  const ece = expectedCalibrationError(yt, yp);
  assert.ok(ece < 0.05, `ece ${ece}`);
  const bins = calibrationBins(yt, yp);
  assert.equal(bins.length, 10);
});

test("confusion at threshold computes tp/fp/tn/fn", () => {
  const c = confusionAtThreshold([1, 1, 0, 0], [0.9, 0.4, 0.6, 0.1], 0.5);
  assert.equal(c.tp, 1); assert.equal(c.fn, 1); assert.equal(c.fp, 1); assert.equal(c.tn, 1);
  assert.equal(c.accuracy, 0.5);
});

test("evaluate reports base-rate comparison and both-classes flag", () => {
  const yt = [0, 0, 1, 1];
  const m = evaluate(yt, [0.2, 0.3, 0.7, 0.8]);
  assert.equal(m.n, 4);
  assert.equal(m.baseRate, 0.5);
  assert.ok(m.brier < m.baseRateBrier, "model beats base rate");
  assert.equal(m.bothClassesPresent, true);
});

test("chronological split preserves order and proportions", () => {
  const rows = Array.from({ length: 10 }, (_, i) => i);
  const { train, val, test } = chronologicalSplit(rows, 0.6, 0.2);
  assert.deepEqual(train, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(val, [6, 7]);
  assert.deepEqual(test, [8, 9]);
});

test("walk-forward folds use expanding train windows, no future leakage", () => {
  const rows = Array.from({ length: 20 }, (_, i) => i);
  const folds = walkForwardFolds(rows, 4);
  assert.ok(folds.length >= 1);
  for (const f of folds) {
    const maxTrain = Math.max(...f.train);
    const minTest = Math.min(...f.test);
    assert.ok(minTest > maxTrain, "test always follows train chronologically");
  }
});

test("baseRate handles empty and computes proportion", () => {
  assert.equal(baseRate([]), 0);
  assert.equal(baseRate([1, 0, 0, 0]), 0.25);
});
