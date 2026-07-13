import test from "node:test";
import assert from "node:assert/strict";
import { shouldRetrain, defaultRetrainPolicy } from "../lib/learning/retrain-policy.ts";
import { classifyDrift, isDegraded, defaultDriftThresholds } from "../lib/learning/drift.ts";

const NOW = Date.parse("2026-07-11T15:00:00Z");
const DAY = 86_400_000;

const rstate = (over = {}) => ({
  currentWatermark: 100, lastTrainedWatermark: 50, lastAttemptMs: NOW - 2 * DAY,
  newGradedSinceWatermark: 30, wins: 20, losses: 15, coverage: 0.97, nowMs: NOW, ...over,
});

test("retrain allowed when all bounded conditions pass", () => {
  const d = shouldRetrain(rstate());
  assert.equal(d.retrain, true);
  assert.equal(d.reasons.length, 0);
});

test("retrain blocked below the new-outcome minimum", () => {
  const d = shouldRetrain(rstate({ newGradedSinceWatermark: 10 }));
  assert.equal(d.retrain, false);
  assert.ok(d.reasons.some((r) => /new graded outcomes/.test(r)));
});

test("retrain blocked within the min interval", () => {
  const d = shouldRetrain(rstate({ lastAttemptMs: NOW - 3600_000 }));
  assert.equal(d.retrain, false);
  assert.ok(d.reasons.some((r) => /since last attempt/.test(r)));
});

test("retrain blocked when only one class present", () => {
  assert.equal(shouldRetrain(rstate({ losses: 0 })).retrain, false);
  assert.equal(shouldRetrain(rstate({ wins: 0 })).retrain, false);
});

test("retrain blocked on the same watermark (no repeat training)", () => {
  const d = shouldRetrain(rstate({ currentWatermark: 50, lastTrainedWatermark: 50 }));
  assert.equal(d.retrain, false);
  assert.ok(d.reasons.some((r) => /watermark/.test(r)));
});

test("retrain blocked on low coverage", () => {
  assert.equal(shouldRetrain(rstate({ coverage: 0.5 })).retrain, false);
});

test("policy defaults are the conservative bounded values", () => {
  const p = defaultRetrainPolicy({});
  assert.equal(p.minNewOutcomes, 25);
  assert.equal(p.minHoursBetween, 24);
});

// ── Drift ────────────────────────────────────────────────────────────────────

const dinput = (over = {}) => ({
  gradedSample: 120, coverage: 0.97, staleDataFreq: 0.05, contractRejectFreq: 0.1,
  modelAgeMs: 2 * DAY, baseWinRate: 0.55, curWinRate: 0.54, baseBrier: 0.2, curBrier: 0.21,
  baseEce: 0.05, curEce: 0.06, ...over,
});

test("healthy when all signals within tolerance", () => {
  const d = classifyDrift(dinput());
  assert.equal(d.state, "HEALTHY");
});

test("insufficient data short-circuits", () => {
  assert.equal(classifyDrift(dinput({ gradedSample: 5 })).state, "INSUFFICIENT_DATA");
});

test("performance drift on a Brier jump", () => {
  const d = classifyDrift(dinput({ curBrier: 0.30 }));
  assert.equal(d.state, "PERFORMANCE_DRIFT");
  assert.ok(d.reasons.some((r) => /Brier worsened/.test(r)));
});

test("data drift on low coverage", () => {
  assert.equal(classifyDrift(dinput({ coverage: 0.5 })).state, "DATA_DRIFT");
});

test("model stale on age", () => {
  assert.equal(classifyDrift(dinput({ modelAgeMs: 30 * DAY })).state, "MODEL_STALE");
});

test("two flags ⇒ DEGRADED", () => {
  const d = classifyDrift(dinput({ curBrier: 0.30, coverage: 0.5 }));
  assert.equal(d.state, "DEGRADED");
  assert.equal(isDegraded(d.state), true);
});

test("win-rate drop counts as performance drift", () => {
  assert.equal(classifyDrift(dinput({ curWinRate: 0.30 })).state, "PERFORMANCE_DRIFT");
});

test("isDegraded is true for degraded/stale/perf, false for healthy/watch", () => {
  assert.equal(isDegraded("HEALTHY"), false);
  assert.equal(isDegraded("WATCH"), false);
  assert.equal(isDegraded("MODEL_STALE"), true);
  assert.ok(defaultDriftThresholds({}).minGraded >= 1);
});
