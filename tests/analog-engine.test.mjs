import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { fitMetric, mdist } from "../lib/research/analog/similarity.ts";
import { AnalogScorer } from "../lib/research/analog/engine.ts";
import { buildPhaseDReport, persistPhaseDReportOnDb } from "../lib/research/analog/report.ts";
import { walkForwardSplits, compareToBaseline, beatsAllBaselines } from "../lib/research/eval/harness.ts";
import { baselineSuite, randomScorer } from "../lib/research/eval/baselines.ts";

function mulberry32(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// NONLINEAR edge: win iff x in a band around 1 → kNN can find it, a linear model cannot.
function genBand(n, seed = 3) {
  const r = mulberry32(seed); const eps = [];
  for (let i = 0; i < n; i++) {
    const x = r() * 6 - 3, win = Math.abs(x - 1) < 0.5, outcome = (win ? 1 : -1) + (r() * 0.2 - 0.1);
    eps.push({ input: { id: `e${i}`, t0Ms: 1000 + i * 1000, features: { x } }, win, outcome, labelStartMs: 1000 + i * 1000, labelEndMs: 1000 + i * 1000 + 100 });
  }
  return eps;
}
function genRandom(n, seed = 5) {
  const r = mulberry32(seed); const eps = [];
  for (let i = 0; i < n; i++) { const x = r() * 6 - 3, outcome = r() * 2 - 1; eps.push({ input: { id: `r${i}`, t0Ms: 1000 + i * 1000, features: { x } }, win: outcome > 0, outcome, labelStartMs: 1000 + i * 1000, labelEndMs: 1000 + i * 1000 + 100 }); }
  return eps;
}

// ── similarity metric (adversarial) ──────────────────────────────────────────
test("metric weights a predictive feature far above an irrelevant one", () => {
  const r = mulberry32(1); const rows = [], wins = [];
  for (let i = 0; i < 300; i++) { const sig = r() * 2 - 1, noise = r() * 2 - 1; rows.push([sig, noise]); wins.push(sig > 0); }
  const m = fitMetric(rows, wins, ["sig", "noise"], 0.1);
  assert.ok(m.weights[0] > m.weights[1] * 2, "predictive 'sig' outweighs irrelevant 'noise'");
});

test("duplicated (collinear) features do not blow up the metric (ridge + correlation-aware)", () => {
  const rows = [[1, 1], [2, 2], [-1, -1], [0.5, 0.5], [3, 3]]; const wins = [true, true, false, true, false];
  const m = fitMetric(rows, wins, ["a", "a2"], 0.1);
  const d = mdist(m, [1, 1], [2, 2]);
  assert.ok(Number.isFinite(d) && d >= 0, "distance is finite despite perfect collinearity");
});

// ── engine determinism + leakage ─────────────────────────────────────────────
test("engine is deterministic and reads only features (no outcome access)", () => {
  const eps = genBand(300);
  const s1 = new AnalogScorer(); s1.fit(eps);
  const s2 = new AnalogScorer(); s2.fit(eps);
  const q = { id: "q", t0Ms: 0, features: { x: 1.0 } };
  assert.equal(s1.score(q), s2.score(q), "same train+query → same score");
  // identical features (regardless of any outcome) → identical score.
  assert.equal(s1.score({ id: "a", t0Ms: 0, features: { x: 1.0 } }), s1.score({ id: "b", t0Ms: 999, features: { x: 1.0 } }));
});

// ── abstention ───────────────────────────────────────────────────────────────
test("abstains when the comparable pool is too small", () => {
  const s = new AnalogScorer({ minEffectiveSample: 15 });
  s.fit(genBand(10));
  const e = s.explain({ id: "q", t0Ms: 0, features: { x: 1 } });
  assert.equal(e.abstain, true);
  assert.match(e.reason, /pool|analogs/);
  assert.equal(s.score({ id: "q", t0Ms: 0, features: { x: 1 } }), 0, "abstain → score 0 (does not act)");
});

test("abstains when analogs contradict (~even win/loss)", () => {
  // 40 episodes all at x=0, half win half lose → any query near 0 sees a coin-flip.
  const eps = []; for (let i = 0; i < 40; i++) eps.push({ input: { id: `c${i}`, t0Ms: 1000 + i, features: { x: 0 } }, win: i % 2 === 0, outcome: i % 2 === 0 ? 1 : -1, labelStartMs: 1000 + i, labelEndMs: 1100 + i });
  const s = new AnalogScorer({ minEffectiveSample: 10, contradictionCeiling: 0.49 });
  s.fit(eps);
  const e = s.explain({ id: "q", t0Ms: 0, features: { x: 0 } });
  assert.equal(e.abstain, true);
  assert.match(e.reason, /contradict/);
});

test("abstains when the nearest analog is beyond the distance radius", () => {
  const s = new AnalogScorer({ minEffectiveSample: 5, maxRadius: 0.001 });
  s.fit(genBand(300));
  const e = s.explain({ id: "q", t0Ms: 0, features: { x: 1 } });
  assert.equal(e.abstain, true);
});

// ── SYNTHETIC acceptance (NOT real-market evidence) ──────────────────────────
test("SYNTHETIC ONLY: analog beats every baseline on a nonlinear-edge dataset", () => {
  const splits = walkForwardSplits(genBand(900), 4);
  const res = beatsAllBaselines(new AnalogScorer(), baselineSuite(["x"]), splits, { iters: 1500 });
  assert.equal(res.ok, true, "engine beats all baselines on synthetic edge (kNN captures the band a linear model cannot)");
});

test("SYNTHETIC ONLY: analog does NOT beat random on a no-signal dataset (no false edge)", () => {
  const splits = walkForwardSplits(genRandom(900), 4);
  const r = compareToBaseline(new AnalogScorer(), randomScorer(), splits, { iters: 1500 });
  assert.equal(r.lift.significant, false, "no edge on noise");
});

// ── report + verdict ─────────────────────────────────────────────────────────
const baseInput = (over = {}) => ({
  datasetKind: "real_seeded", provenance: { universeSource: "reference_pit", survivorshipBias: false, corporateActionAdjusted: true },
  dateFrom: "2021-01-01", dateTo: "2026-01-01", episodeCount: 200000, excludedCount: 100, rejectedCount: 5000,
  missingFeatureRates: { optionsContext: 1 }, trainTestWindows: 4, embargoMs: 0,
  candidate: { name: "analog_tier1", expectancy: 0.12, hitRate: 0.58, brier: 0.2, ece: 0.05, coverage: 0.1, abstentionRate: 0.9, nOos: 40000 },
  baselines: [{ baseline: "random", liftPoint: 0.1, liftLo: 0.05, liftHi: 0.15, significant: true }, { baseline: "logistic", liftPoint: 0.06, liftLo: 0.02, liftHi: 0.1, significant: true }],
  transactionCostAssumptions: "spread+slippage modeled", modeledOutcomeShare: 0, ...over,
});

test("verdict GO only on a real, survivorship-free, baseline-beating, calibrated result", () => {
  assert.equal(buildPhaseDReport(baseInput()).verdict, "GO");
});
test("survivorship bias forces EXPLORATORY_ONLY (never GO)", () => {
  const r = buildPhaseDReport(baseInput({ datasetKind: "survivorship_fallback", provenance: { universeSource: "today_tickers", survivorshipBias: true, corporateActionAdjusted: false } }));
  assert.equal(r.verdict, "EXPLORATORY_ONLY");
});
test("synthetic dataset can never GO", () => {
  assert.equal(buildPhaseDReport(baseInput({ datasetKind: "synthetic" })).verdict, "EXPLORATORY_ONLY");
});
test("no baseline lift → STOP", () => {
  const r = buildPhaseDReport(baseInput({ baselines: [{ baseline: "random", liftPoint: 0, liftLo: -0.1, liftHi: 0.1, significant: false }] }));
  assert.equal(r.verdict, "STOP");
});

test("report persists idempotently", () => {
  const d = new Database(":memory:");
  const ddl = `CREATE TABLE IF NOT EXISTS analog_eval_reports (report_id TEXT PRIMARY KEY, report_version INTEGER NOT NULL, dataset_kind TEXT NOT NULL, verdict TEXT NOT NULL, verdict_reason TEXT, universe_source TEXT, survivorship_bias INTEGER NOT NULL DEFAULT 1, date_from TEXT, date_to TEXT, episode_count INTEGER, report_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL);`;
  d.exec(ddl); d.exec(ddl);
  const rep = buildPhaseDReport(baseInput());
  persistPhaseDReportOnDb(d, "rep1", rep, 1); persistPhaseDReportOnDb(d, "rep1", rep, 2);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM analog_eval_reports").get().n, 1);
  assert.equal(d.prepare("SELECT verdict v FROM analog_eval_reports WHERE report_id='rep1'").get().v, "GO");
});
