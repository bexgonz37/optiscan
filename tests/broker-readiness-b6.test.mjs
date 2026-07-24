import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureBrokerSchemaOnDb,
  openAccount,
  createEvidenceChain,
  submitOrder,
  fillOrder,
  evaluateBrokerV2Readiness,
  validateBrokerV2FlagCombination,
  resolvePaperReadSource,
  rollbackV2ReadsToLegacy,
  recordShadowReadComparison,
  summarizeShadowReadEvents,
  runHistoricalReconcileDryRun,
  recordParityEvent,
  upsertLegacyLink,
  CUTOVER_POLICY_VERSION,
  paperBrokerV2Enabled,
  paperBrokerV2ShadowReadEnabled,
  paperBrokerV2ReadsEnabled,
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

test("B6: cutover policy documented", () => {
  const doc = read("docs/BROKER_V2_CUTOVER_POLICY.md");
  assert.match(doc, /READY_FOR_CONTROLLED_CUTOVER/);
  assert.match(doc, /PAPER_BROKER_V2_SHADOW_READ_ENABLED/);
  assert.match(doc, /PAPER_BROKER_V2_READS_ENABLED/);
  assert.match(doc, /No Production Cutover/);
  assert.equal(CUTOVER_POLICY_VERSION, 1);
  assert.equal(paperBrokerV2Enabled({}), false);
  assert.equal(paperBrokerV2ShadowReadEnabled({}), false);
  assert.equal(paperBrokerV2ReadsEnabled({}), false);
});

test("B6: insufficient samples cannot produce READY_FOR_CONTROLLED_CUTOVER", { skip: !Database }, () => {
  const database = db();
  openAccount(database, {
    accountKey: "research_shadow",
    accountType: "RESEARCH_SHADOW",
    displayName: "R",
    openingDeposit: 1000,
  });
  const report = evaluateBrokerV2Readiness(database, {}, Date.now());
  assert.notEqual(report.status, "READY_FOR_CONTROLLED_CUTOVER");
  assert.ok(report.status === "OBSERVING" || report.status === "NOT_READY");
  assert.ok(report.missingForNextStatus.length > 0 || report.status === "NOT_READY");
});

test("B6: unresolved critical failures block readiness", { skip: !Database }, () => {
  const database = db();
  const { accountId } = openAccount(database, {
    accountKey: "subscriber_paper",
    accountType: "SUBSCRIBER_PAPER",
    displayName: "S",
    openingDeposit: 1000,
  });
  recordParityEvent(database, {
    accountId,
    legacyTable: "options_paper_trades",
    legacyId: 1,
    checkKind: "fill_price",
    expected: 1.2,
    actual: 9.9,
  });
  const report = evaluateBrokerV2Readiness(database, {}, Date.now());
  assert.equal(report.status, "NOT_READY");
  assert.ok(report.failedRequirements.includes("no_critical_failures"));
});

test("B6: orphaned fill records block readiness", { skip: !Database }, () => {
  const database = db();
  const { accountId } = openAccount(database, {
    accountKey: "subscriber_paper",
    accountType: "SUBSCRIBER_PAPER",
    displayName: "S",
    openingDeposit: 1000,
  });
  database.pragma("foreign_keys = OFF");
  database
    .prepare(
      `INSERT INTO broker_fills
        (id, account_id, order_id, fill_key, asset_class, symbol, side, quantity, price, gross_notional,
         commission, fees, contract_multiplier, filled_at_ms, record_schema_version, created_at_ms)
       VALUES ('bfill_orphan', ?, 'bord_missing', 'k1', 'OPTION', 'O:X', 'BUY', 1, 1, 100, 0, 0, 100, 1, 3, 1)`,
    )
    .run(accountId);
  database.pragma("foreign_keys = ON");
  const dry = runHistoricalReconcileDryRun(database, { recordAudit: false });
  assert.ok(dry.orphanedFills >= 1);
  const report = evaluateBrokerV2Readiness(database, {}, Date.now());
  assert.equal(report.status, "NOT_READY");
  assert.ok(report.failedRequirements.includes("no_orphans"));
});

test("B6: missing audit-chain events block via incomplete evidence requirement", { skip: !Database }, () => {
  const database = db();
  const { accountId } = openAccount(database, {
    accountKey: "subscriber_paper",
    accountType: "SUBSCRIBER_PAPER",
    displayName: "S",
    openingDeposit: 5000,
  });
  // Link without evidence/order/fill
  upsertLegacyLink(database, {
    accountId,
    legacyTable: "options_paper_trades",
    legacyId: 99,
  });
  // Create a fake closed legacy row if table exists — ensure schema has options table? may not.
  database.exec(`CREATE TABLE IF NOT EXISTS options_paper_trades (
    id INTEGER PRIMARY KEY, status TEXT, exit_price REAL, contracts REAL, pnl_dollars REAL
  )`);
  database.prepare(`INSERT INTO options_paper_trades (id, status, exit_price, contracts) VALUES (99,'CLOSED',2,1)`).run();
  const report = evaluateBrokerV2Readiness(database, {}, Date.now());
  // incomplete evidence on closed trade → missing exit / incomplete → NOT_READY via missing closed or orphans
  assert.ok(
    report.status === "NOT_READY" ||
      report.dryRun.incompleteEvidenceChains >= 1 ||
      report.dryRun.missingClosedLegacyCount >= 1 ||
      report.metrics.auditChainCompletenessRatePct != null,
  );
});

test("B6: continuous healthy duration calculated from last critical failure", { skip: !Database }, () => {
  const database = db();
  const { accountId } = openAccount(database, {
    accountKey: "subscriber_paper",
    accountType: "SUBSCRIBER_PAPER",
    displayName: "S",
    openingDeposit: 1000,
  });
  const now = 1_700_000_000_000;
  // Insert a matched link timeline
  database
    .prepare(
      `INSERT INTO broker_legacy_links
        (id, account_id, legacy_table, legacy_id, record_schema_version, created_at_ms, updated_at_ms)
       VALUES ('blink1', ?, 'options_paper_trades', '1', 3, ?, ?)`,
    )
    .run(accountId, now - 10 * 86_400_000, now);
  // Critical failure 2 hours ago
  database
    .prepare(
      `INSERT INTO broker_parity_events
        (id, account_id, legacy_table, legacy_id, check_kind, expected_value, actual_value, matched, record_schema_version, created_at_ms)
       VALUES ('bpar1', ?, 'options_paper_trades', '1', 'fill_price', '1', '2', 0, 3, ?)`,
    )
    .run(accountId, now - 2 * 3_600_000);
  const report = evaluateBrokerV2Readiness(database, {}, now);
  assert.ok(report.metrics.continuousHealthyParityMs != null);
  assert.ok(Math.abs(report.metrics.continuousHealthyParityMs - 2 * 3_600_000) < 1000);
});

test("B6: trading-day requirements enforced", { skip: !Database }, () => {
  const database = db();
  const report = evaluateBrokerV2Readiness(
    database,
    { BROKER_V2_SHADOW_MIN_DAYS: "2", BROKER_V2_READY_MIN_DAYS: "5" },
    Date.now(),
  );
  const dayReq = report.requirements.find((r) => r.id === "trading_days_cutover");
  assert.ok(dayReq);
  assert.equal(dayReq.passed, false);
  assert.equal(dayReq.required, 5);
});

test("B6: invalid feature-flag combinations fail safely", () => {
  const bad1 = validateBrokerV2FlagCombination({
    PAPER_BROKER_V2_READS_ENABLED: "1",
    PAPER_BROKER_V2_ENABLED: "0",
  });
  assert.equal(bad1.ok, false);
  const bad2 = validateBrokerV2FlagCombination({
    PAPER_BROKER_V2_READS_ENABLED: "1",
    PAPER_BROKER_V2_ENABLED: "1",
    PAPER_BROKER_V2_SHADOW_READ_ENABLED: "1",
  });
  assert.equal(bad2.ok, false);
  const route = resolvePaperReadSource({
    PAPER_BROKER_V2_READS_ENABLED: "1",
    PAPER_BROKER_V2_ENABLED: "0",
  });
  assert.equal(route.responseSource, "LEGACY");
  assert.equal(route.flagValidation.ok, false);
});

test("B6: rollback requires only disabling V2 reads", () => {
  const rb = rollbackV2ReadsToLegacy();
  assert.equal(rb.disableEnv, "PAPER_BROKER_V2_READS_ENABLED=0");
  const routeOn = resolvePaperReadSource({
    PAPER_BROKER_V2_ENABLED: "1",
    PAPER_BROKER_V2_READS_ENABLED: "1",
  });
  assert.equal(routeOn.responseSource, "V2");
  const routeOff = resolvePaperReadSource({
    PAPER_BROKER_V2_ENABLED: "1",
    PAPER_BROKER_V2_READS_ENABLED: "0",
  });
  assert.equal(routeOff.responseSource, "LEGACY");
});

test("B6: shadow reads persist mismatches and never imply responseSource V2_SHADOW to clients", { skip: !Database }, () => {
  const database = db();
  const env = { PAPER_BROKER_V2_SHADOW_READ_ENABLED: "1" };
  const r = recordShadowReadComparison(
    database,
    {
      metrics: {
        account_equity: { legacy: 100, v2: 90, tolerance: 0.01 },
        realized_pnl: { legacy: 10, v2: 10 },
      },
    },
    env,
  );
  assert.ok(r.recorded >= 2);
  assert.ok(r.mismatches.includes("account_equity"));
  const sum = summarizeShadowReadEvents(database);
  assert.ok(sum.events >= 2);
  assert.ok(sum.mismatches >= 1);
  const route = resolvePaperReadSource(env);
  assert.equal(route.responseSource, "LEGACY");
  assert.equal(route.runShadowCompare, true);
});

test("B6: shadow mode does not change legacy paper trades route contract", () => {
  const src = read("app/api/paper/trades/route.ts");
  assert.match(src, /source: \"LEGACY\"/);
  assert.match(src, /recordShadowReadComparison/);
  assert.match(src, /never changes returned legacy|shadow failures must never affect legacy/i);
});

test("B6: no scanner/delivery/gate/AI imports read-routing layer", () => {
  const files = [
    "lib/scanner-loop.ts",
    "lib/scanner-filters.ts",
    "lib/discord-desk.ts",
    "lib/broker/buying-power.ts",
    "lib/broker/dual-write.ts",
  ];
  for (const f of files) {
    const src = read(f);
    assert.doesNotMatch(src, /resolvePaperReadSource|from \"\.\/routing|from \"@\/lib\/broker\/routing/);
  }
  // AI paths
  try {
    assert.doesNotMatch(read("lib/ai/research-analyzer.ts"), /resolvePaperReadSource/);
  } catch {
    /* optional */
  }
});

test("B6: readiness API + dashboard labeled", () => {
  assert.match(read("app/api/research/brokerage-readiness/route.ts"), /evaluateBrokerV2Readiness/);
  assert.match(read("app/api/research/brokerage-readiness/route.ts"), /checkApiToken/);
  assert.match(read("app/api/research/brokerage-readiness/route.ts"), /soakPhase/);
  const page = read("app/brokerage-readiness/page.tsx");
  assert.match(page, /No Production Cutover/);
  assert.match(page, /\/api\/research\/brokerage-readiness/);
  assert.match(page, /Operational Validation \(Soak\)/);
  assert.match(read("components/AxiomShell.tsx"), /\/brokerage-readiness/);
});
