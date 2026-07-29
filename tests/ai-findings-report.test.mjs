import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildCanonicalFindingsReport,
  latencyStatus,
  linkedReadyToSentOnDb,
  missedOpportunityFingerprint,
} from "../lib/ai/findings-report.ts";
import { listResearchQuestions } from "../lib/ai/research-question-registry.ts";

let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch {
  Database = null;
}
const skipSqlite = Database ? false : "better-sqlite3 unavailable";

const DAY = "2026-07-28";
const t0 = Date.parse(`${DAY}T14:00:00.000Z`);

function report(summary, over = {}) {
  return {
    id: 728,
    reportType: "nightly",
    periodKey: DAY,
    periodStartMs: Date.parse(`${DAY}T04:00:00.000Z`),
    periodEndMs: Date.parse(`${DAY}T23:59:00.000Z`),
    summary,
    narrative: null,
    narrativeStatus: "VALIDATION_FAILED",
    model: null,
    diagnostic: { validationStage: "anti_fabrication" },
    aiJobRunId: null,
    createdAtMs: Date.parse(`${DAY}T23:10:00.000Z`),
    updatedAtMs: Date.parse(`${DAY}T23:10:00.000Z`),
    ...over,
  };
}

const july28Summary = {
  tradingDay: DAY,
  counts: { outcomesGraded: 5, rejected: 2, candidates: 7 },
  overall: { n: 5, wins: 1, losses: 4, breakeven: 0, winRate: 20, avgReturnPct: -9.1, opportunityHitRate: 20 },
  callsVsPuts: {
    call: { n: 5, wins: 1, losses: 4, winRate: 20, avgReturnPct: -9.1 },
    put: { n: 0 },
  },
  byTimeOfDay: {
    morning_0930_1100: { n: 2, winRate: 50, avgReturnPct: 2.5 },
    midday_1100_1400: { n: 3, winRate: 0, avgReturnPct: -18.2 },
  },
  realizedGrade: { LOSS: 4, T1: 0 },
  momentum: { total: 9717, nearMisses: 9717, medianDiscoveryLatencyMs: -4931, medianDiscordLatencyMs: 19340257 },
  options: { cycles: 11, configBlockedCycles: 11, emittedButUndelivered: 11, topDeliveryGateReason: "options_delivery_disabled" },
  overallLegacy: { profitFactor: 0.315 },
  prioritizedIssue: "options_delivery_disabled",
};

const momentumRows = [
  {
    id: 1,
    ticker: "NVDA",
    tradingDay: DAY,
    evalAtMs: t0 + 1000,
    session: "regular",
    decision: "NEAR_MISS",
    reason: "blocked: persistOk",
    classification: "FRESH_ACCELERATION",
    movePct: 4.5,
    firstSeenMs: t0,
    firstRankedMs: t0 - 4931,
    discordDeliveredMs: t0 + 1000,
    createdAtMs: t0 + 1000,
  },
  {
    id: 2,
    ticker: "NVDA",
    tradingDay: DAY,
    evalAtMs: t0 + 30_000,
    session: "regular",
    decision: "NEAR_MISS",
    reason: "blocked: persistOk",
    classification: "FRESH_ACCELERATION",
    movePct: 4.7,
    firstSeenMs: t0,
    firstRankedMs: t0 + 30_000,
    discordDeliveredMs: t0 + 19_340_257,
    createdAtMs: t0 + 30_000,
  },
  {
    id: 3,
    ticker: "TSLA",
    tradingDay: DAY,
    evalAtMs: t0 + 600_000,
    session: "regular",
    decision: "REJECTED",
    reason: "late exhaustion",
    classification: "LATE_EXHAUSTION",
    movePct: 8.2,
    firstSeenMs: t0 + 500_000,
    firstRankedMs: t0 + 600_000,
    createdAtMs: t0 + 600_000,
  },
];

test("latencyStatus excludes negative, mixed-unit, and cross-session values", () => {
  assert.equal(latencyStatus(t0, t0 + 1000).status, "VALID");
  assert.equal(latencyStatus(t0, t0 - 1).status, "CLOCK_SKEW");
  assert.equal(latencyStatus(1700, t0).status, "LEGACY_UNIT_UNKNOWN");
  assert.equal(latencyStatus(t0, t0 + 9 * 60 * 60_000).status, "CROSS_SESSION");
});

test("canonical findings dedupe missed observations and exclude invalid latency from top-line", () => {
  const reportOut = buildCanonicalFindingsReport({
    nightlyReports: [report(july28Summary)],
    latestMomentumDiagnostics: momentumRows,
    linkedReadyToSent: { ready: 606, sent: 4, ratePct: 0.7, source: "linked fixture", available: true },
    nowMs: t0,
  });
  const metric = (id) => reportOut.metrics.find((m) => m.id === id);
  assert.equal(metric("missed.raw_observations").value, 3);
  assert.equal(metric("missed.unique_opportunities").value, 2);
  assert.equal(metric("missed.repeated_scans").value, 1);
  assert.equal(metric("timing.discovery_delay_ms").value, 65_000);
  assert.equal(metric("timing.discovery_delay_ms").qualityStatus, "TIMESTAMP_ERROR");
  assert.equal(metric("timing.discovery_delay_ms").safeForTopLine, false);
  assert.equal(metric("timing.discovery_to_alert_ms").qualityStatus, "TIMESTAMP_ERROR");
  assert.ok(reportOut.dataQualityFindings.some((f) => f.id === "invalid-latency-values"));
});

test("inactive supervisor does not control independent health diagnosis", () => {
  const reportOut = buildCanonicalFindingsReport({
    nightlyReports: [report(july28Summary)],
    latestMomentumDiagnostics: momentumRows,
    linkedReadyToSent: { ready: 606, sent: 4, ratePct: 0.7, source: "linked fixture", available: true },
    nowMs: t0,
  });
  assert.equal(reportOut.activeProductionPipeline, "INDEPENDENT_OPTIONS");
  assert.notEqual(reportOut.overallState, "options_delivery_disabled");
  assert.ok(reportOut.dataQualityFindings.some((f) => f.id === "inactive-supervisor-contamination"));
  assert.ok(!reportOut.topFindings[0].title.includes("options_delivery_disabled"));
});

test("profit factor has one canonical source and missing put sample remains NO DATA", () => {
  const reportOut = buildCanonicalFindingsReport({
    nightlyReports: [report(july28Summary)],
    latestMomentumDiagnostics: momentumRows,
    nowMs: t0,
  });
  const pf = reportOut.metrics.find((m) => m.id === "paper.profit_factor");
  assert.equal(pf.value, null);
  assert.equal(pf.qualityStatus, "MISSING_DATA");
  assert.equal(pf.source.field, "overall.profitFactor");
  assert.equal(reportOut.callsVsPuts.put.status, "NO_DATA");
  assert.equal(reportOut.callsVsPuts.put.winRate, null);
  assert.equal(reportOut.callsVsPuts.comparison, "NO_VALID_COMPARISON");
});

test("low sample lowers confidence and AI failure preserves deterministic findings", () => {
  const reportOut = buildCanonicalFindingsReport({
    nightlyReports: [report(july28Summary)],
    latestMomentumDiagnostics: momentumRows,
    jobFailures: [
      { status: "VALIDATION_FAILED", errorCategory: "schema_validation" },
      { status: "ERROR", message: "anti_fabrication validation failed" },
    ],
    nowMs: t0,
  });
  assert.equal(reportOut.overallConfidence, "LOW");
  assert.match(reportOut.narrative.message, /AI NARRATIVE UNAVAILABLE/);
  assert.ok(reportOut.topFindings.length > 0);
  assert.ok(reportOut.fixQueue.every((f) => f.humanApprovalStatus === "NOT_APPROVED_FOR_LIVE_LOGIC_CHANGE"));
  assert.ok(reportOut.dataQualityFindings.some((f) => f.id === "ai-validation-failures"));
  assert.ok(reportOut.failingFindings.some((f) => f.id === "session-underperformance" && /midday/.test(f.title)));
});

test("research questions map to explicit rules, not array-index placeholders", () => {
  const rows = listResearchQuestions();
  const spread = rows.find((r) => r.id === "option-spread-strictness");
  assert.ok(spread);
  assert.equal(spread.pipeline, "INDEPENDENT_OPTIONS");
  assert.match(spread.exactRule, /ENTRY_MAX_SPREAD_PCT/);
  assert.match(spread.ownerFile, /entry-quality-gate/);
  const puts = rows.find((r) => r.id === "puts-outperforming-calls");
  assert.equal(puts.pipeline, "DELIVERED_ALERT_PAPER");
  assert.match(puts.exactRule, /PUT side versus CALL side/);
});

test("missed opportunity fingerprint collapses repeat scans", () => {
  assert.equal(missedOpportunityFingerprint(momentumRows[0]), missedOpportunityFingerprint(momentumRows[1]));
  assert.notEqual(missedOpportunityFingerprint(momentumRows[0]), missedOpportunityFingerprint(momentumRows[2]));
});

test("READY -> SENT uses linked opportunity identity", { skip: skipSqlite }, () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE options_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, selected_strategy TEXT, side TEXT,
      state TEXT NOT NULL, created_at_ms INTEGER
    );
    CREATE TABLE options_alerts (
      alert_id TEXT PRIMARY KEY, candidate_symbol TEXT NOT NULL, strategy TEXT, side TEXT,
      state TEXT NOT NULL, created_at_ms INTEGER, sent_at_ms INTEGER
    );
    CREATE TABLE options_delivery_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, alert_id TEXT, symbol TEXT, strategy TEXT, side TEXT,
      delivery_sent INTEGER, final_delivery_outcome TEXT, created_at_ms INTEGER
    );
  `);
  db.prepare("INSERT INTO options_candidates (symbol, selected_strategy, side, state, created_at_ms) VALUES (?,?,?,?,?)")
    .run("NVDA", "bearish_breakdown", "put", "READY", t0);
  db.prepare("INSERT INTO options_candidates (symbol, selected_strategy, side, state, created_at_ms) VALUES (?,?,?,?,?)")
    .run("TSLA", "bullish_momentum", "call", "READY", t0);
  db.prepare("INSERT INTO options_alerts (alert_id, candidate_symbol, strategy, side, state, created_at_ms, sent_at_ms) VALUES (?,?,?,?,?,?,?)")
    .run("a1", "NVDA", "bearish_breakdown", "put", "SENT", t0 + 1000, t0 + 1200);
  db.prepare("INSERT INTO options_delivery_decisions (alert_id, symbol, strategy, side, delivery_sent, final_delivery_outcome, created_at_ms) VALUES (?,?,?,?,?,?,?)")
    .run("a1", "NVDA", "bearish_breakdown", "put", 1, "DELIVERED", t0 + 1000);
  db.prepare("INSERT INTO options_alerts (alert_id, candidate_symbol, strategy, side, state, created_at_ms, sent_at_ms) VALUES (?,?,?,?,?,?,?)")
    .run("wrong", "AMZN", "bullish_momentum", "call", "SENT", t0 + 1000, t0 + 1200);
  const linked = linkedReadyToSentOnDb(db, t0 - 1000, t0 + 10_000);
  assert.equal(linked.ready, 2);
  assert.equal(linked.sent, 1);
  assert.equal(linked.ratePct, 50);
  db.close();
});

test("AI page uses canonical findings route and simplified sections", () => {
  const src = readFileSync(join(process.cwd(), "app/ai/page.tsx"), "utf8");
  assert.match(src, /\/api\/ai\/findings\/latest/);
  for (const label of ["OVERVIEW", "FINDINGS", "EXPERIMENTS", "REPORTS", "ADVANCED"]) {
    assert.match(src, new RegExp(label));
  }
  assert.doesNotMatch(src, /Today's Scanner Report Card/);
  assert.doesNotMatch(src, /runScanner|placeOrder|BEARISH_SUBSCRIBER_DELIVERY_ENABLED/);
});
