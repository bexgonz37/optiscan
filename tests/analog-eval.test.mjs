import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { expectancy, hitRate, profitFactor, brier, ece, reliabilityCurve, bootstrapLiftCI } from "../lib/research/eval/metrics.ts";
import { randomScorer, logisticBaseline, baselineSuite } from "../lib/research/eval/baselines.ts";
import { walkForwardSplits, purgeEmbargo, evaluate, compareToBaseline, persistComparisonOnDb } from "../lib/research/eval/harness.ts";

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
function mulberry32(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function genEdge(n, seed = 7) {
  const r = mulberry32(seed); const eps = [];
  for (let i = 0; i < n; i++) {
    const sig = r() * 4 - 2, noise = (r() * 2 - 1) * 0.4, outcome = sig + noise;
    eps.push({ input: { id: `e${i}`, t0Ms: 1000 + i * 1000, features: { sig } }, win: outcome > 0, outcome, labelStartMs: 1000 + i * 1000, labelEndMs: 1000 + i * 1000 + 500 });
  }
  return eps;
}
function genRandom(n, seed = 9) {
  const r = mulberry32(seed); const eps = [];
  for (let i = 0; i < n; i++) {
    const rnd = r() * 4 - 2, outcome = r() * 4 - 2; // outcome independent of features
    eps.push({ input: { id: `r${i}`, t0Ms: 1000 + i * 1000, features: { rnd } }, win: outcome > 0, outcome, labelStartMs: 1000 + i * 1000, labelEndMs: 1000 + i * 1000 + 500 });
  }
  return eps;
}
const signalScorer = { name: "signal", score: (i) => sigmoid(i.features.sig ?? 0) };
const rndFeatScorer = { name: "rnd_feat", score: (i) => sigmoid(i.features.rnd ?? 0) };

// ── metrics math ─────────────────────────────────────────────────────────────
test("core metrics compute correctly on fixtures", () => {
  const ps = [{ p: 0.9, win: true, outcome: 2 }, { p: 0.8, win: false, outcome: -1 }, { p: 0.2, win: false, outcome: -3 }];
  assert.equal(expectancy(ps), (2 + -1) / 2); // selected = p>=0.5 → first two
  assert.equal(hitRate(ps), 0.5);
  assert.equal(profitFactor(ps), 2); // gain 2 / loss 1
});

test("ECE is ~0 for calibrated predictions and large for miscalibrated ones", () => {
  const calibrated = []; for (let i = 0; i < 100; i++) calibrated.push({ p: 0.7, win: i < 70, outcome: i < 70 ? 1 : -1 });
  assert.ok(ece(calibrated) < 0.05, "70% bucket realizes 70% → low ECE");
  const mis = []; for (let i = 0; i < 100; i++) mis.push({ p: 0.9, win: i < 50, outcome: 1 });
  assert.ok(ece(mis) > 0.3, "claims 90% but realizes 50% → high ECE");
});

test("reliability curve buckets predictions by predicted probability", () => {
  const rc = reliabilityCurve([{ p: 0.05, win: false, outcome: 0 }, { p: 0.95, win: true, outcome: 0 }], 10);
  assert.equal(rc[0].n, 1); assert.equal(rc[9].n, 1);
});

// ── walk-forward + purge/embargo ─────────────────────────────────────────────
test("walk-forward splits are time-ordered: train strictly precedes test", () => {
  const splits = walkForwardSplits(genEdge(100), 4);
  assert.ok(splits.length >= 1);
  for (const s of splits) {
    const maxTrain = Math.max(...s.train.map((t) => t.input.t0Ms));
    const minTest = Math.min(...s.test.map((t) => t.input.t0Ms));
    assert.ok(maxTrain < minTest, "no future training episode leaks into the test block");
  }
});

test("purge/embargo removes training episodes whose label overlaps the test period", () => {
  const test0 = [{ input: { id: "t", t0Ms: 10_000, features: {} }, win: true, outcome: 1, labelStartMs: 10_000, labelEndMs: 10_500 }];
  const train = [
    { input: { id: "safe", t0Ms: 5_000, features: {} }, win: true, outcome: 1, labelStartMs: 5_000, labelEndMs: 5_500 }, // resolves well before test
    { input: { id: "overlap", t0Ms: 9_800, features: {} }, win: true, outcome: 1, labelStartMs: 9_800, labelEndMs: 10_300 }, // label reaches into test
  ];
  const kept = purgeEmbargo(train, test0, 0).map((t) => t.input.id);
  assert.deepEqual(kept, ["safe"], "the overlapping-label episode is purged");
});

// ── ACCEPTANCE: edge is found, noise is not ──────────────────────────────────
test("ACCEPTANCE: a true signal beats random out-of-sample with a significant lift CI", () => {
  const splits = walkForwardSplits(genEdge(400), 4);
  const r = compareToBaseline(signalScorer, randomScorer(), splits);
  assert.equal(r.lift.significant, true, "signal must beat random OOS");
  assert.ok(r.lift.lo > 0, "lift CI strictly above zero");
  assert.ok(r.candidate.expectancy > r.baseline.expectancy);
});

test("ACCEPTANCE: on a NO-SIGNAL dataset the harness reports NO significant lift (no false edge)", () => {
  const splits = walkForwardSplits(genRandom(400), 4);
  const r = compareToBaseline(rndFeatScorer, randomScorer(), splits);
  assert.equal(r.lift.significant, false, "a scorer on a random feature must NOT show edge over random");
});

test("ACCEPTANCE: a purely-linear signal does NOT beat a logistic baseline (no spurious lift)", () => {
  const splits = walkForwardSplits(genEdge(400), 4);
  const r = compareToBaseline(signalScorer, logisticBaseline(["sig"]), splits);
  assert.equal(r.lift.significant, false, "logistic captures a linear signal → candidate shows no lift over it");
});

test("bootstrap lift CI: identical inputs → zero lift, not significant", () => {
  const a = [1, -1, 2, -2, 0.5, -0.5];
  const ci = bootstrapLiftCI(a, a, 500);
  assert.equal(ci.point, 0); assert.equal(ci.significant, false);
});

// ── persistence ──────────────────────────────────────────────────────────────
test("comparison persists to eval ledger and is idempotent", () => {
  const d = new Database(":memory:");
  const ddl = `
    CREATE TABLE IF NOT EXISTS eval_runs (run_id TEXT PRIMARY KEY, kind TEXT NOT NULL, dataset TEXT NOT NULL, scorer TEXT NOT NULL, baseline TEXT, splits INTEGER NOT NULL, n_oos INTEGER NOT NULL, oos_expectancy REAL, oos_hit_rate REAL, oos_brier REAL, oos_ece REAL, lift_vs_baseline REAL, lift_ci_low REAL, lift_ci_high REAL, significant INTEGER, config_json TEXT, created_at_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS eval_results (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, scorer TEXT NOT NULL, split_idx INTEGER NOT NULL, n INTEGER NOT NULL, expectancy REAL, hit_rate REAL, brier REAL, ece REAL, coverage REAL, created_at_ms INTEGER NOT NULL, UNIQUE(run_id, scorer, split_idx));`;
  d.exec(ddl); d.exec(ddl);
  const splits = walkForwardSplits(genEdge(200), 4);
  const out = evaluate(signalScorer, splits);
  const r = compareToBaseline(signalScorer, randomScorer(), splits);
  persistComparisonOnDb(d, "run1", "edge", r, out.perSplit, 1);
  persistComparisonOnDb(d, "run1", "edge", r, out.perSplit, 2);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM eval_runs").get().n, 1);
  assert.equal(d.prepare("SELECT significant s FROM eval_runs WHERE run_id='run1'").get().s, 1);
  assert.ok(baselineSuite(["sig"]).length >= 6);
});
