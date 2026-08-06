/**
 * tests/strategy-performance-quarantine.test.mjs
 *
 * The audited population showed expectancy -7.2%, profit factor 0.49, 59.9% immediate
 * failure and 18.6% reaching +25% — across 181 sampled alerts spanning many strategies,
 * both directions, several DTE bands and more than one deployment. Treating that aggregate
 * as "the strategy" is what made it impossible to quarantine anything specific.
 *
 * These tests pin the segmentation, the classification thresholds, the readiness state
 * machine, and above all the authority boundary: automatic demotion is allowed, automatic
 * subscriber promotion is not.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  computeSegmentMetrics,
  classifySegment,
  segmentAndClassify,
  BY_STRATEGY_VERSION,
  evidenceQualityOf,
  dteBandOf,
  moneynessBandOf,
  premiumBandOf,
  isQuarantined,
  DEFAULT_CLASSIFICATION,
} from "../lib/research/options/strategy-performance.ts";
import {
  autoAssessOnDb,
  autoStateForClassification,
  effectiveReadinessState,
  maySendSubscriberOpening,
  readReadinessOnDb,
  recordHumanApproval,
  setReadinessOnDb,
  subscriberEligibility,
  DEFAULT_READINESS_STATE,
} from "../lib/research/options/strategy-readiness.ts";

const T0 = Date.parse("2026-08-06T14:00:00.000Z");

function db() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE strategy_readiness_state (
      strategy_key TEXT PRIMARY KEY, strategy TEXT NOT NULL, strategy_version TEXT NOT NULL,
      state TEXT NOT NULL, classification TEXT, reason TEXT NOT NULL, sample_size INTEGER,
      expectancy_pct REAL, profit_factor REAL, evidence_snapshot_json TEXT, actor TEXT NOT NULL,
      deployment_sha TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE strategy_readiness_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, strategy_key TEXT NOT NULL, strategy TEXT NOT NULL,
      strategy_version TEXT NOT NULL, prior_state TEXT, new_state TEXT NOT NULL, reason TEXT NOT NULL,
      classification TEXT, sample_size INTEGER, metrics_json TEXT, evidence_snapshot_json TEXT,
      actor TEXT NOT NULL, deployment_sha TEXT, at_ms INTEGER NOT NULL
    );
  `);
  return d;
}

/** n rows with a fixed return, priced the executable way. */
const rows = (n, returnPct, over = {}) => Array.from({ length: n }, (_, i) => ({
  tradeId: i + 1,
  lane: "DELIVERED_ALERT_PAPER",
  strategy: "vwap_rejection",
  strategyVersion: "1",
  selectionVersion: "contract-selection@3",
  rankingVersion: null,
  deploymentSha: "abc1234",
  direction: "put",
  symbol: "SPY",
  isIndexSymbol: true,
  dte: 1,
  delta: -0.45,
  spreadPct: 1.2,
  entryFill: 2.0,
  exitFill: 2.0 * (1 + returnPct / 100),
  returnPct,
  mfePct: returnPct > 0 ? returnPct : 1,
  maePct: -10,
  openInterest: 5000,
  volume: 1000,
  sessionDate: "2026-08-06",
  enteredAtMs: T0 + i * 60_000,
  exitAtMs: T0 + i * 60_000 + 3_600_000,
  alertLatencyMs: 5_000,
  premiumExpansionPct: 3,
  marketRegime: "trend_down",
  ...over,
}));

// ── Segmentation ────────────────────────────────────────────────────────────

test("banding is null-preserving: unknown never becomes a real band", () => {
  assert.equal(dteBandOf(null), "unknown");
  assert.equal(dteBandOf(0), "0dte");
  assert.equal(dteBandOf(1), "1-7dte");
  assert.equal(moneynessBandOf(null), "unknown");
  assert.equal(moneynessBandOf(-0.45), "atm");
  assert.equal(moneynessBandOf(0.2), "far_otm");
  assert.equal(premiumBandOf(null), "unknown");
  assert.equal(premiumBandOf(0.3), "under_50c");
});

test("evidence quality separates delivered, research and contaminated lanes", () => {
  const [r] = rows(1, 10);
  assert.equal(evidenceQualityOf(r), "EXECUTABLE_VERIFIED");
  assert.equal(evidenceQualityOf({ ...r, lane: "RESEARCH_ONLY_PAPER" }), "RESEARCH_EXECUTABLE");
  assert.equal(evidenceQualityOf({ ...r, lane: "LEGACY_UNCLASSIFIED" }), "CONTAMINATED");
  assert.equal(evidenceQualityOf({ ...r, entryFill: null }), "UNPRICEABLE");
});

test("metrics never coerce missing data to zero", () => {
  const m = computeSegmentMetrics(rows(5, 10, { mfePct: null, maePct: null, alertLatencyMs: null }));
  assert.equal(m.medianMfePct, null, "absent MFE is null, not 0");
  assert.equal(m.medianMaePct, null);
  assert.equal(m.reached25Pct, null, "attainment is unknowable without MFE");
  assert.equal(m.immediateFailureRate, null);
  assert.ok(m.unavailable.includes("mfePct"));
  assert.ok(m.unavailable.includes("maePct"));
});

test("profit factor is undefined, not infinite, when there are no losers", () => {
  const m = computeSegmentMetrics(rows(5, 20));
  assert.equal(m.profitFactor, null);
  assert.equal(m.winRate, 1);
});

test("expectancy, profit factor and adverse sequence are computed from priced rows", () => {
  const mixed = [...rows(6, 30), ...rows(4, -20).map((r, i) => ({ ...r, tradeId: 100 + i, enteredAtMs: T0 + 10 * 60_000 + i * 60_000 }))];
  const m = computeSegmentMetrics(mixed);
  assert.equal(m.pricedSampleSize, 10);
  assert.equal(m.winRate, 0.6);
  // (6*30 + 4*-20)/10 = 10
  assert.equal(m.expectancyPct, 10);
  // 180 / 80
  assert.equal(m.profitFactor, 2.25);
  assert.equal(m.averageWinnerPct, 30);
  assert.equal(m.averageLoserPct, -20);
  assert.equal(m.maxAdverseSequence, 4, "the four losers were consecutive in time");
});

// ── Classification ──────────────────────────────────────────────────────────

test("a materially negative version with enough sample is NEGATIVE_EXPECTANCY", () => {
  const mixed = [...rows(5, 20), ...rows(20, -15).map((r, i) => ({ ...r, tradeId: 200 + i }))];
  const m = computeSegmentMetrics(mixed);
  const { classification } = classifySegment(m);
  assert.equal(classification, "NEGATIVE_EXPECTANCY");
  assert.equal(isQuarantined(classification), true);
});

test("a thin sample is never condemned, however bad it looks", () => {
  const m = computeSegmentMetrics(rows(5, -40));
  const { classification, rationale } = classifySegment(m);
  assert.equal(classification, "INSUFFICIENT_EVIDENCE");
  assert.match(rationale, /n=5 < 20/);
  assert.equal(isQuarantined(classification), false);
});

test("positive but thin is PROMISING_INSUFFICIENT_SAMPLE, not validated", () => {
  const mixed = [...rows(15, 30), ...rows(7, -10).map((r, i) => ({ ...r, tradeId: 300 + i }))];
  const m = computeSegmentMetrics(mixed);
  const { classification } = classifySegment(m);
  assert.equal(classification, "PROMISING_INSUFFICIENT_SAMPLE");
});

test("positive with sample but high immediate failure is DEGRADED, not validated", () => {
  // Winners are large but most alerts never gained 5% -> immediate failure above 55%.
  const winners = rows(10, 120).map((r, i) => ({ ...r, tradeId: 400 + i, mfePct: 120 }));
  const duds = rows(25, -5).map((r, i) => ({ ...r, tradeId: 500 + i, mfePct: 1 }));
  const m = computeSegmentMetrics([...winners, ...duds]);
  assert.ok(m.expectancyPct > 0, "expectancy is positive");
  assert.ok(m.immediateFailureRate > 0.55, "but most alerts never gained 5%");
  assert.equal(classifySegment(m).classification, "DEGRADED");
  assert.equal(isQuarantined("DEGRADED"), true);
});

test("all-legacy rows are DATA_CONTAMINATED and quarantined", () => {
  const m = computeSegmentMetrics(rows(30, 10, { lane: "LEGACY_UNCLASSIFIED" }));
  assert.equal(m.evidenceQuality, "CONTAMINATED");
  assert.equal(classifySegment(m).classification, "DATA_CONTAMINATED");
  assert.equal(isQuarantined("DATA_CONTAMINATED"), true);
});

test("segmentAndClassify splits by strategy AND version, worst first", () => {
  // A realistic good strategy still loses sometimes: 24 winners at +40%, 8 losers at -15%.
  const good = [
    ...rows(24, 40).map((r, i) => ({ ...r, tradeId: 600 + i, strategy: "sr_reclaim", strategyVersion: "2" })),
    ...rows(8, -15).map((r, i) => ({ ...r, tradeId: 650 + i, strategy: "sr_reclaim", strategyVersion: "2", mfePct: 30 })),
  ];
  const bad = rows(30, -20).map((r, i) => ({ ...r, tradeId: 700 + i, strategy: "vwap_rejection", strategyVersion: "1" }));
  const reports = segmentAndClassify([...good, ...bad], BY_STRATEGY_VERSION);
  assert.equal(reports.length, 2, "two distinct strategy/version segments");
  assert.equal(reports[0].key.strategy, "vwap_rejection", "worst expectancy sorts first");
  assert.equal(reports[0].classification, "NEGATIVE_EXPECTANCY");
  assert.equal(reports[1].classification, "FORWARD_VALIDATED");
});

test("a flawless record is UNPROVEN, not validated: zero losers is a data smell", () => {
  const m = computeSegmentMetrics(rows(30, 25));
  assert.equal(m.profitFactor, null, "profit factor is undefined without losses");
  const { classification, rationale } = classifySegment(m);
  assert.equal(classification, "UNPROVEN");
  assert.match(rationale, /zero losing trades/);
});

// ── Readiness state machine and the authority boundary ──────────────────────

test("an unassessed strategy defaults to RESEARCH_ONLY and cannot send", () => {
  const d = db();
  assert.equal(effectiveReadinessState(readReadinessOnDb(d, "nope", "1")), DEFAULT_READINESS_STATE);
  assert.equal(DEFAULT_READINESS_STATE, "RESEARCH_ONLY");
  assert.equal(maySendSubscriberOpening(DEFAULT_READINESS_STATE), false);
  const e = subscriberEligibility(d, "nope", "1", {});
  assert.equal(e.allowed, false, "absence of a record is absence of permission");
  assert.match(e.reasonCode, /NOT_SUBSCRIBER_APPROVED/);
});

test("no classification maps to SUBSCRIBER_APPROVED automatically", () => {
  const all = [
    "FORWARD_VALIDATED", "PROMISING_INSUFFICIENT_SAMPLE", "UNPROVEN",
    "NEGATIVE_EXPECTANCY", "DEGRADED", "DATA_CONTAMINATED", "INSUFFICIENT_EVIDENCE",
  ];
  for (const c of all) {
    assert.notEqual(
      autoStateForClassification(c), "SUBSCRIBER_APPROVED",
      `${c} must not auto-promote to subscriber-approved`,
    );
  }
  assert.equal(autoStateForClassification("FORWARD_VALIDATED"), "SUBSCRIBER_CANDIDATE");
  assert.equal(autoStateForClassification("NEGATIVE_EXPECTANCY"), "DEMOTED");
});

test("auto-assessment demotes a negative version and journals the transition", () => {
  const d = db();
  const mixed = [...rows(5, 20), ...rows(25, -15).map((r, i) => ({ ...r, tradeId: 800 + i }))];
  const m = computeSegmentMetrics(mixed);
  const r = autoAssessOnDb(d, {
    strategy: "vwap_rejection", strategyVersion: "1",
    classification: "NEGATIVE_EXPECTANCY", rationale: "expectancy below floor",
    metrics: m, deploymentSha: "abc1234", nowMs: T0,
  });
  assert.equal(r.appliedState, "DEMOTED");
  assert.equal(r.quarantined, true);
  assert.equal(subscriberEligibility(d, "vwap_rejection", "1", {}).allowed, false);

  const t = d.prepare("SELECT * FROM strategy_readiness_transitions WHERE strategy=?").all("vwap_rejection");
  assert.equal(t.length, 1);
  assert.equal(t[0].new_state, "DEMOTED");
  assert.equal(t[0].actor, "system:auto-assess");
  assert.ok(t[0].metrics_json, "the evidence that motivated it is journalled");
  assert.equal(t[0].deployment_sha, "abc1234");
});

test("SUBSCRIBER_APPROVED requires a named human and is the only send authority", () => {
  const d = db();
  // System actors are refused outright.
  assert.equal(recordHumanApproval(d, { strategy: "s", strategyVersion: "1", actor: "system:auto", reason: "x", nowMs: T0 }).ok, false);
  assert.equal(recordHumanApproval(d, { strategy: "s", strategyVersion: "1", actor: "   ", reason: "x", nowMs: T0 }).ok, false);
  assert.equal(recordHumanApproval(d, { strategy: "s", strategyVersion: "1", actor: "owner", reason: "", nowMs: T0 }).ok, false);

  const ok = recordHumanApproval(d, {
    strategy: "s", strategyVersion: "1", actor: "owner",
    reason: "reviewed 40-trade forward sample", nowMs: T0,
  });
  assert.equal(ok.ok, true);
  const e = subscriberEligibility(d, "s", "1", {});
  assert.equal(e.allowed, true);
  assert.equal(e.state, "SUBSCRIBER_APPROVED");
});

test("evidence cannot overturn a human approval unless it is genuinely bad", () => {
  const d = db();
  recordHumanApproval(d, { strategy: "s", strategyVersion: "1", actor: "owner", reason: "approved", nowMs: T0 });

  // A thin sample must not silently revoke a deliberate human decision.
  const thin = autoAssessOnDb(d, {
    strategy: "s", strategyVersion: "1", classification: "INSUFFICIENT_EVIDENCE",
    rationale: "n too small", metrics: computeSegmentMetrics(rows(3, 5)), nowMs: T0 + 1000,
  });
  assert.equal(thin.applied, false);
  assert.equal(readReadinessOnDb(d, "s", "1").state, "SUBSCRIBER_APPROVED");

  // Proven-bad evidence DOES demote, automatically.
  const bad = autoAssessOnDb(d, {
    strategy: "s", strategyVersion: "1", classification: "NEGATIVE_EXPECTANCY",
    rationale: "materially negative", metrics: computeSegmentMetrics(rows(25, -15)), nowMs: T0 + 2000,
  });
  assert.equal(bad.appliedState, "DEMOTED");
  assert.equal(subscriberEligibility(d, "s", "1", {}).allowed, false);
});

test("the readiness gate fails closed without schema, and shadow mode reports without blocking", () => {
  const bare = new Database(":memory:");
  const closed = subscriberEligibility(bare, "s", "1", {});
  assert.equal(closed.allowed, false, "no schema must not mean permission");
  assert.equal(closed.reasonCode, "READINESS_SCHEMA_UNAVAILABLE");

  const shadow = subscriberEligibility(bare, "s", "1", { STRATEGY_READINESS_MODE: "shadow" });
  assert.equal(shadow.allowed, true);
  assert.equal(shadow.enforced, false);

  assert.equal(subscriberEligibility(null, "s", "1", {}).allowed, false, "no db must not mean permission");
});

test("setReadinessOnDb upserts state and appends one transition per change", () => {
  const d = db();
  setReadinessOnDb(d, { strategy: "a", strategyVersion: "1", state: "SHADOW", reason: "r1", actor: "system:test", nowMs: T0 });
  setReadinessOnDb(d, { strategy: "a", strategyVersion: "1", state: "PAPER_VALIDATION", reason: "r2", actor: "system:test", nowMs: T0 + 1 });
  assert.equal(readReadinessOnDb(d, "a", "1").state, "PAPER_VALIDATION");
  const t = d.prepare("SELECT prior_state, new_state FROM strategy_readiness_transitions ORDER BY id").all();
  assert.equal(t.length, 2);
  assert.equal(t[0].prior_state, null);
  assert.equal(t[1].prior_state, "SHADOW");
  assert.equal(t[1].new_state, "PAPER_VALIDATION");
});

test("classification thresholds are documented constants, not magic numbers", () => {
  assert.equal(DEFAULT_CLASSIFICATION.minClassifyN, 20);
  assert.equal(DEFAULT_CLASSIFICATION.minValidateN, 30);
  assert.equal(DEFAULT_CLASSIFICATION.negativeExpectancyPct, -2);
  assert.equal(DEFAULT_CLASSIFICATION.breakEvenProfitFactor, 1);
  // The measured baseline was 59.9%; the ceiling must be below it to be an improvement.
  assert.ok(DEFAULT_CLASSIFICATION.maxImmediateFailureRate < 0.599);
});
