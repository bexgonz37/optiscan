import test from "node:test";
import assert from "node:assert/strict";
import { explainSpeedPersistence, summarizePersistOkFailures } from "../lib/metrics/persist-ok-diagnostics.ts";
import { METRIC_DICTIONARY } from "../lib/metrics/dictionary.ts";
import { buildIndependentOptionsFunnelOnDb } from "../lib/metrics/funnel-attribution.ts";
import { buildQuantDashboard } from "../lib/ai/quant-dashboard.ts";
import { speedPersistentFromRing } from "../lib/zero-dte.js";

function report(periodKey, summary) {
  return {
    id: 1,
    reportType: "nightly",
    periodKey,
    periodStartMs: null,
    periodEndMs: null,
    summary,
    narrative: null,
    narrativeStatus: "OK",
    model: null,
    diagnostic: null,
    aiJobRunId: null,
    createdAtMs: Date.parse(`${periodKey}T22:00:00Z`),
    updatedAtMs: Date.parse(`${periodKey}T22:00:00Z`),
  };
}

test("metric dictionary entries are pipeline-labeled and explainable", () => {
  for (const m of Object.values(METRIC_DICTIONARY)) {
    assert.ok(m.pipeline);
    assert.ok(m.sql.length > 0);
    assert.ok(m.numerator.length > 0);
    assert.ok(m.denominator.length > 0);
    assert.ok(Array.isArray(m.assumptions));
    assert.ok(Array.isArray(m.limitations));
  }
  assert.equal(METRIC_DICTIONARY.supervisor_options_capture_rate.pipeline, "SUPERVISOR_OPTIONS");
  assert.equal(METRIC_DICTIONARY.independent_options_capture_rate.pipeline, "INDEPENDENT_OPTIONS");
  assert.equal(METRIC_DICTIONARY.stock_missed_fast_movers_count.pipeline, "STOCK_MOMENTUM");
});

test("explainSpeedPersistence matches speedPersistentFromRing and subtypes ring_too_short", () => {
  const ring = [
    { t: 1000, p: 10 },
    { t: 2000, p: 10.01 },
  ];
  const opts = { minRate: 0.2, direction: "bullish", minHits: 2, window: 5, subWindowMs: 4000 };
  assert.equal(speedPersistentFromRing(ring, opts), false);
  const e = explainSpeedPersistence({ ring, ...opts });
  assert.equal(e.ok, false);
  assert.equal(e.subReason, "ring_too_short");
});

test("explainSpeedPersistence subtypes insufficient_hits vs rate_below_threshold", () => {
  // Build a ring with some upward ticks but not enough hits.
  const ring = [];
  let p = 100;
  const t0 = 1_000_000;
  for (let i = 0; i < 8; i++) {
    p += i === 7 ? 0.5 : 0.01; // only last tick is fast
    ring.push({ t: t0 + i * 1000, p });
  }
  const opts = { minRate: 5, direction: "bullish", minHits: 2, window: 5, subWindowMs: 4000, nowMs: t0 + 7000 };
  const live = speedPersistentFromRing(ring, opts);
  const e = explainSpeedPersistence({ ring, ...opts });
  assert.equal(e.ok, live);
  assert.equal(e.ok, false);
  assert.ok(["insufficient_hits", "rate_below_threshold", "no_measurable_rate"].includes(e.subReason));
});

test("summarizePersistOkFailures percentages sum to ~100", () => {
  const rows = [
    { reason: "blocked: persistOk", gateDiagnostics: { persistOk: { subReason: "ring_too_short", anotherGateFirst: false, firstFailedGate: "persistOk" } } },
    { reason: "blocked: persistOk", gateDiagnostics: { persistOk: { subReason: "insufficient_hits", anotherGateFirst: false, firstFailedGate: "persistOk" } } },
    { reason: "blocked: persistOk", gateDiagnostics: { persistOk: { subReason: "insufficient_hits", anotherGateFirst: false, firstFailedGate: "persistOk" } } },
    { reason: "blocked: cooldown", gateDiagnostics: { persistOk: { subReason: "insufficient_hits", anotherGateFirst: true, firstFailedGate: "cooldown", cooldownActive: true } }, firstFailedGate: "cooldown" },
  ];
  const s = summarizePersistOkFailures(rows);
  assert.equal(s.total, 4);
  assert.ok(s.buckets.some((b) => b.subReason === "insufficient_hits" && b.count === 2));
  assert.ok(s.buckets.some((b) => b.subReason === "cooldown_first"));
});

test("Opportunity Capture does not fall back to paper candidates and labels supervisor pipeline", () => {
  const summary = {
    counts: { outcomesGraded: 10, created: 3, candidates: 12 },
    overall: { n: 10, wins: 5, losses: 2, breakeven: 3, winRate: 50, opportunityHitRate: 70 },
    momentum: { total: 10, nearMisses: 2, avgLatencyMs: 1000, earliness: { pctEarly: 80 } },
    // No options digest → capture must be n/a, NOT created/candidates
    dataGaps: [],
  };
  const q = buildQuantDashboard({
    nightlyReports: [report("2026-07-14", summary)],
    weeklyReports: [],
    lessons: [],
    proposals: [],
    jobFailures: [],
    latestMomentumDiagnostics: [],
    env: {},
  });
  const capture = q.scannerHealth.components.find((c) => c.label.includes("Opportunity Capture"));
  assert.ok(capture);
  assert.equal(capture.available, false);
  assert.equal(capture.value, null);
  assert.equal(capture.pipeline, "SUPERVISOR_OPTIONS");

  const withOptions = buildQuantDashboard({
    nightlyReports: [report("2026-07-14", { ...summary, options: { delivered: 2, canonical: 4, cycles: 3 } })],
    weeklyReports: [],
    lessons: [],
    proposals: [],
    jobFailures: [],
    latestMomentumDiagnostics: [],
    env: {},
  });
  const c2 = withOptions.scannerHealth.components.find((c) => c.label.includes("Opportunity Capture"));
  assert.equal(c2.available, true);
  assert.equal(c2.value, 50);

  // Missed Fast Movers ignores counts.nearMisses (in-memory)
  assert.ok(q.reportCard.some((m) => m.label === "Missed Fast Movers" && m.value === 2));
});

test("gate breakdown does not double-count momentum diagnostic rows", () => {
  const summary = {
    counts: { outcomesGraded: 1 },
    overall: { n: 1, wins: 1, losses: 0, winRate: 100 },
    rejectionReasons: {},
    momentum: { total: 5, nearMisses: 2, extendedRejections: 2, staleRejected: 0 },
    dataGaps: [],
  };
  const rows = Array.from({ length: 10 }, (_, i) => ({
    id: i,
    ticker: "AAA",
    evalAtMs: 1,
    tradingDay: "2026-07-14",
    session: "regular",
    decision: "NEAR_MISS",
    reason: "blocked: persistOk",
    createdAtMs: 1,
  }));
  const q = buildQuantDashboard({
    nightlyReports: [report("2026-07-14", summary)],
    weeklyReports: [],
    lessons: [],
    proposals: [],
    jobFailures: [],
    latestMomentumDiagnostics: rows,
    env: {},
  });
  const vwap = q.gateBreakdown.find((g) => g.gate === "VWAP Extension");
  assert.ok(vwap);
  assert.equal(vwap.count, 2); // from extendedRejections only — not +10 from raw rows
});

let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
} catch {
  Database = null;
}

test("independent funnel stages are ordered and labeled", { skip: !Database }, () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE options_candidates (
      id INTEGER PRIMARY KEY, symbol TEXT, selected_strategy TEXT, side TEXT, state TEXT, why TEXT,
      score REAL, latency_json TEXT, created_at_ms INTEGER, option_symbol TEXT
    );
    CREATE TABLE options_delivery_decisions (
      id INTEGER PRIMARY KEY, symbol TEXT, strategy TEXT, side TEXT, outcome TEXT, reason TEXT, quality REAL,
      alert_id TEXT, delivery_attempted INTEGER, delivery_sent INTEGER, final_delivery_outcome TEXT,
      final_delivery_reason TEXT, delivery_attempted_at_ms INTEGER, delivery_completed_at_ms INTEGER, created_at_ms INTEGER
    );
    CREATE TABLE options_alerts (
      alert_id TEXT PRIMARY KEY, candidate_symbol TEXT, strategy TEXT, side TEXT, state TEXT, failure_reason TEXT,
      latency_ms INTEGER, attempted_at_ms INTEGER, sent_at_ms INTEGER, created_at_ms INTEGER
    );
  `);
  const t0 = 1_700_000_000_000;
  db.prepare(`INSERT INTO options_candidates (id, symbol, selected_strategy, side, state, why, score, created_at_ms, option_symbol)
    VALUES (1,'NVDA','momentum_acceleration','call','READY',null,0.8,?, 'O:NVDA')`).run(t0);
  db.prepare(`INSERT INTO options_delivery_decisions
    (symbol, strategy, side, outcome, reason, quality, alert_id, delivery_attempted, delivery_sent,
     final_delivery_outcome, final_delivery_reason, delivery_attempted_at_ms, delivery_completed_at_ms, created_at_ms)
    VALUES ('NVDA','momentum_acceleration','call','DELIVER_TO_DISCORD','ok',0.7,'a1',1,1,'DELIVERED','delivered',?,?,?)`)
    .run(t0 + 100, t0 + 200, t0 + 50);
  db.prepare(`INSERT INTO options_alerts (alert_id, candidate_symbol, strategy, side, state, latency_ms, attempted_at_ms, sent_at_ms, created_at_ms)
    VALUES ('a1','NVDA','momentum_acceleration','call','SENT',150,?,?,?)`).run(t0 + 100, t0 + 200, t0 + 50);

  const funnel = buildIndependentOptionsFunnelOnDb(db, t0 - 1000, t0 + 1000);
  assert.equal(funnel.pipeline, "INDEPENDENT_OPTIONS");
  assert.deepEqual(
    funnel.stages.map((s) => s.stage),
    ["observed", "qualified", "strategy_selected", "candidate_created", "delivery_decision", "delivery_attempted", "discord_sent"],
  );
  assert.equal(funnel.stages.find((s) => s.stage === "discord_sent")?.count, 1);
  assert.ok(funnel.opportunities[0].stages.every((s) => "latencyFromPrevMs" in s));
});
