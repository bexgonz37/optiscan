import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureBrokerSchemaOnDb,
  openAccount,
  generateDailyReadinessReportIfDue,
  buildDailyReadinessSummary,
  buildSoakPeriodSummary,
  listDailyReadinessReports,
  SOAK_REPORT_VERSION,
  paperBrokerV2Enabled,
  paperBrokerV2ShadowReadEnabled,
  paperBrokerV2ReadsEnabled,
  runHistoricalReconcileDryRun,
  evaluateBrokerV2Readiness,
} from "../lib/broker/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
} catch {
  Database = null;
}

function db() {
  const d = new Database(":memory:");
  ensureBrokerSchemaOnDb(d);
  return d;
}

function stubReport(overrides = {}) {
  return {
    label: "test",
    policyVersion: 1,
    generatedAtMs: Date.now(),
    status: "OBSERVING",
    metrics: {
      eligibleLegacyTrades: 0,
      mirroredTrades: 12,
      mirrorCoveragePct: 100,
      successfullyReconciledTrades: 12,
      tradeParitySuccessRatePct: 100,
      fillPriceParityRatePct: 100,
      realizedPnlParityRatePct: 100,
      returnParityRatePct: 100,
      lifecycleParityRatePct: 100,
      auditChainCompletenessRatePct: 100,
      equityReconciliationRatePct: 100,
      unresolvedParityFailures: 0,
      unresolvedCriticalFailures: 0,
      missingV2Trades: 0,
      duplicateV2Mirrors: 0,
      orphanedOrders: 0,
      orphanedFills: 0,
      orphanedPositions: 0,
      orphanedLedgerEntries: 0,
      orphanedSnapshots: 0,
      staleMarkCount: 0,
      missingMarkCount: 0,
      incompleteEquitySnapshotCount: 0,
      oldestUnresolvedFailureMs: null,
      continuousHealthyParityMs: 86_400_000,
      distinctTradingDaysObserved: 3,
      completedMirroredRoundTrips: 5,
    },
    requirements: [],
    passedRequirements: [],
    failedRequirements: [],
    missingForNextStatus: ["more_days"],
    recommendedNextAction: "continue soak",
    flags: { dualWrite: false, shadowRead: false, v2Reads: false },
    routing: { responseSource: "LEGACY", note: "legacy", runShadowCompare: false },
    dryRun: { findings: [], dryRun: true },
    shadowReadSummary: { events: 0, mismatches: 0 },
    dataQualityWarnings: [],
    productionCutoverEnabled: false,
    ...overrides,
  };
}

test("soak: docs + flags remain default OFF", () => {
  assert.match(read("docs/BROKER_V2_SOAK.md"), /Operational Validation/);
  assert.match(read("docs/BROKER_V2_SOAK.md"), /PAPER_BROKER_V2_READS_ENABLED/);
  assert.match(read("docs/BROKER_V2_SOAK.md"), /No automatic cutover/);
  assert.equal(paperBrokerV2Enabled({}), false);
  assert.equal(paperBrokerV2ShadowReadEnabled({}), false);
  assert.equal(paperBrokerV2ReadsEnabled({}), false);
  assert.equal(SOAK_REPORT_VERSION, 1);
  assert.match(read("lib/broker/schema-ddl.ts"), /broker_readiness_daily_reports/);
});

test("soak: daily report is idempotent per ET day", { skip: !Database }, () => {
  const database = db();
  openAccount(database, {
    accountKey: "subscriber_paper",
    accountType: "SUBSCRIBER_PAPER",
    displayName: "S",
    openingDeposit: 1000,
  });
  const now = Date.parse("2026-07-24T18:00:00Z");
  const first = generateDailyReadinessReportIfDue(database, {}, now);
  assert.equal(first.created, true);
  assert.ok(first.summary);
  assert.equal(first.reportDay, "2026-07-24");
  assert.equal(first.summary.flags.v2Reads, false);
  assert.equal(first.readyForControlledCutoverEvidence, false);

  const second = generateDailyReadinessReportIfDue(database, {}, now);
  assert.equal(second.created, false);
  assert.equal(second.reportDay, first.reportDay);
  assert.equal(listDailyReadinessReports(database, 10).length, 1);

  const nextDay = generateDailyReadinessReportIfDue(
    database,
    {},
    Date.parse("2026-07-25T18:00:00Z"),
  );
  assert.equal(nextDay.created, true);
  assert.equal(nextDay.reportDay, "2026-07-25");
  assert.equal(listDailyReadinessReports(database, 10).length, 2);
});

test("soak: regressions are detected day-over-day", () => {
  const prev = buildDailyReadinessSummary(stubReport({ status: "READY_FOR_SHADOW_READS" }), "2026-07-23", null);
  const worse = stubReport({
    status: "OBSERVING",
    metrics: {
      ...stubReport().metrics,
      unresolvedCriticalFailures: 2,
      duplicateV2Mirrors: 1,
      tradeParitySuccessRatePct: 90,
      orphanedOrders: 1,
    },
    shadowReadSummary: { events: 3, mismatches: 2 },
  });
  const cur = buildDailyReadinessSummary(worse, "2026-07-24", prev);
  assert.ok(cur.regressions.some((r) => r.startsWith("status_regressed")));
  assert.ok(cur.regressions.some((r) => r.startsWith("critical_failures_up")));
  assert.ok(cur.regressions.some((r) => r.startsWith("parity_rate_down")));
  assert.ok(cur.regressions.some((r) => r.startsWith("orphans_up")));
  assert.ok(cur.regressions.some((r) => r.startsWith("duplicates_up")));
  assert.ok(cur.regressions.some((r) => r.startsWith("shadow_mismatches_up")));
  assert.ok(cur.warnings.some((w) => w.startsWith("regression:")));
});

test("soak: gate met records evidence without cutover", { skip: !Database }, () => {
  const database = db();
  const id = "brdr_gate_test";
  const summary = buildDailyReadinessSummary(
    stubReport({ status: "READY_FOR_CONTROLLED_CUTOVER", missingForNextStatus: [] }),
    "2026-07-24",
    null,
  );
  assert.equal(summary.reachedControlledCutoverGate, true);
  database
    .prepare(
      `INSERT INTO broker_readiness_daily_reports
        (id, report_day, status, summary_json, report_json, record_schema_version, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      summary.reportDay,
      summary.status,
      JSON.stringify(summary),
      JSON.stringify(stubReport({ status: "READY_FOR_CONTROLLED_CUTOVER" })),
      3,
      Date.now(),
    );

  // Simulate the audit payload shape used when gate is met (no financial cutover).
  database
    .prepare(
      `INSERT INTO broker_audit_events
        (id, event_kind, entity_kind, entity_id, actor, payload_json, created_at_ms, record_schema_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "baud_gate",
      "READINESS_CUTOVER_GATE_MET",
      "ACCOUNT",
      id,
      "SYSTEM",
      JSON.stringify({
        reportDay: summary.reportDay,
        cutoverPerformed: false,
        message: "Gate met — human approval required before any V2 read cutover",
      }),
      Date.now(),
      3,
    );

  const soak = buildSoakPeriodSummary(database);
  assert.equal(soak.everReachedControlledCutoverGate, true);
  assert.equal(soak.latestStatus, "READY_FOR_CONTROLLED_CUTOVER");
  const audit = database
    .prepare(`SELECT payload_json FROM broker_audit_events WHERE event_kind=?`)
    .get("READINESS_CUTOVER_GATE_MET");
  const payload = JSON.parse(audit.payload_json);
  assert.equal(payload.cutoverPerformed, false);

  // Flags in stored summary remain OFF
  assert.equal(summary.flags.dualWrite, false);
  assert.equal(summary.flags.shadowRead, false);
  assert.equal(summary.flags.v2Reads, false);
});

test("soak: pre-window closed legacy trades do not block no_missing_v2_closed", { skip: !Database }, () => {
  const database = db();
  openAccount(database, {
    accountKey: "subscriber_paper",
    accountType: "SUBSCRIBER_PAPER",
    displayName: "S",
    openingDeposit: 1000,
  });
  database.exec(`CREATE TABLE IF NOT EXISTS options_paper_trades (
    id INTEGER PRIMARY KEY, status TEXT, exit_price REAL, contracts REAL, entered_at_ms INTEGER
  )`);
  database
    .prepare(
      `INSERT INTO options_paper_trades (id, status, exit_price, contracts, entered_at_ms) VALUES (1,'CLOSED',2,1,1000)`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO options_paper_trades (id, status, exit_price, contracts, entered_at_ms) VALUES (2,'CLOSED',2,1,5_000_000)`,
    )
    .run();

  const withoutWindow = runHistoricalReconcileDryRun(database, {
    recordAudit: false,
    eligibleAfterMs: null,
  });
  assert.equal(withoutWindow.missingClosedLegacyCount, 2);

  const withWindow = runHistoricalReconcileDryRun(database, {
    recordAudit: false,
    eligibleAfterMs: 2_000_000,
  });
  assert.equal(withWindow.missingClosedLegacyCount, 1);
  assert.equal(withWindow.preWindowUnmirroredClosed, 1);
  assert.equal(withWindow.eligibleLegacyTrades, 1);
  assert.ok(withWindow.warnings.some((w) => w.startsWith("pre_window_unmirrored_closed=")));

  const report = evaluateBrokerV2Readiness(
    database,
    { BROKER_V2_READINESS_ELIGIBLE_AFTER_MS: "5000000" },
    Date.now(),
  );
  // Only trade 2 is eligible and missing — still fails missing gate, but trade 1 excluded
  assert.equal(report.dryRun.missingClosedLegacyCount, 1);
  assert.equal(report.dryRun.preWindowUnmirroredClosed, 1);

  const clear = evaluateBrokerV2Readiness(
    database,
    { BROKER_V2_READINESS_ELIGIBLE_AFTER_MS: "9000000" },
    Date.now(),
  );
  assert.equal(clear.dryRun.missingClosedLegacyCount, 0);
  assert.equal(clear.dryRun.preWindowUnmirroredClosed, 2);
  assert.ok(!clear.failedRequirements.includes("no_missing_v2_closed"));
});

test("soak: API + UI expose soak history; scheduler never flips reads", () => {
  const api = read("app/api/research/brokerage-readiness/route.ts");
  assert.match(api, /generateDailyReadinessReportIfDue/);
  assert.match(api, /buildSoakPeriodSummary/);
  assert.match(api, /productionCutoverEnabled:\s*false/);
  assert.match(api, /cutoverPerformed:\s*false/);
  const page = read("app/brokerage-readiness/page.tsx");
  assert.match(page, /Soak period/);
  assert.match(page, /Today's daily report/);
  assert.doesNotMatch(read("lib/scheduler.ts"), /PAPER_BROKER_V2_READS_ENABLED\s*=/);
});
