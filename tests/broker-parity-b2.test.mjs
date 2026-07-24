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
  sizeFromBuyingPower,
  getAccountState,
  buildParityDashboardReport,
  dualWriteAfterOptionsPaperEntry,
  paperBrokerV2Enabled,
} from "../lib/broker/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
} catch {
  Database = null;
}

function brokerDb() {
  const db = new Database(":memory:");
  ensureBrokerSchemaOnDb(db);
  return db;
}

function optionsDb() {
  const db = brokerDb();
  db.exec(`
    CREATE TABLE options_paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      option_symbol TEXT NOT NULL,
      side TEXT, strike REAL, expiration TEXT, dte INTEGER, result_class TEXT,
      bid REAL, ask REAL, mid REAL, spread_pct REAL, entry_fill REAL,
      volume INTEGER, open_interest INTEGER, iv REAL, delta REAL, underlying_price REAL,
      strategy TEXT, target REAL, invalidation REAL, provenance TEXT, status TEXT NOT NULL,
      session TEXT, core_broad TEXT, feature_snapshot_json TEXT, paper_kind TEXT, alert_id TEXT,
      entry_source TEXT, experiment_id TEXT, experiment_variant TEXT,
      entered_at_ms INTEGER, exit_fill REAL, pnl REAL, return_pct REAL, exit_reason TEXT,
      exit_at_ms INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER
    );
  `);
  return db;
}

test("parity dashboard API is auth-gated and page is research-only", () => {
  const api = read("app/api/research/brokerage-parity/route.ts");
  assert.match(api, /checkApiToken/);
  assert.match(api, /buildParityDashboardReport/);
  const page = read("app/brokerage-parity/page.tsx");
  assert.match(page, /Brokerage Parity/);
  assert.match(page, /\/api\/research\/brokerage-parity/);
  const shell = read("components/AxiomShell.tsx");
  assert.match(shell, /\/brokerage-parity/);
});

test("parity report aggregates 24h / 7d / lifetime and surfaces failures with evidence", { skip: !Database }, () => {
  const env = { PAPER_BROKER_V2_ENABLED: "1", BROKER_V2_OPENING_BALANCE_USD: "100000" };
  assert.equal(paperBrokerV2Enabled(env), true);
  const db = optionsDb();
  const now = Date.now();
  const ins = db
    .prepare(
      `INSERT INTO options_paper_trades
        (option_symbol, status, paper_kind, entry_fill, entered_at_ms, created_at_ms, updated_at_ms, result_class, provenance, entry_source)
       VALUES ('O:SPY_C600','ENTERED','RESEARCH_ONLY_PAPER',2.5,?,?,?,'REAL_OPTION_PAPER','x','monitor_shadow')`,
    )
    .run(now, now, now);
  dualWriteAfterOptionsPaperEntry(db, Number(ins.lastInsertRowid), env);
  const report = buildParityDashboardReport(db, env, now);
  assert.equal(report.dualWriteEnabled, true);
  assert.ok(report.windows.h24.parityChecks >= 1);
  assert.ok(report.windows.d7.parityChecks >= 1);
  assert.ok(report.windows.lifetime.parityChecks >= 1);
  assert.equal(report.windows.lifetime.parityFailures, 0);
  assert.ok(report.windows.lifetime.mirroredTrades >= 1);
  assert.equal(report.recentFailures.length, 0);
});

test("B2 sizeFromBuyingPower caps quantity to ledger buying power", { skip: !Database }, () => {
  const db = brokerDb();
  const { accountId } = openAccount(db, {
    accountKey: "bp_test",
    accountType: "SUBSCRIBER_PAPER",
    displayName: "BP Test",
    openingDeposit: 1_000,
  });
  const sized = sizeFromBuyingPower(
    db,
    {
      accountId,
      assetClass: "OPTION",
      symbol: "O:SPY_C500",
      limitPrice: 2.5,
      contractMultiplier: 100,
      desiredQuantity: 10,
      blockDuplicateSymbol: false,
    },
    { maxPositionUtilization: 1, maxPositionDollars: 50_000, maxConcurrentPositions: 20 },
  );
  // $1000 / ($2.5 * 100) = 4 contracts max
  assert.equal(sized.quantity, 4);
  assert.equal(sized.allowed, true);
  assert.equal(sized.buyingPower, 1000);
});

test("B2 supports multiple concurrent positions with append-only reserves", { skip: !Database }, () => {
  const db = brokerDb();
  const { accountId } = openAccount(db, {
    accountKey: "concurrent",
    accountType: "RESEARCH_SHADOW",
    displayName: "Concurrent",
    openingDeposit: 10_000,
  });
  const ev = createEvidenceChain(db, { chainJson: { test: true } });
  const symbols = ["AAPL", "MSFT", "NVDA"];
  for (const [i, symbol] of symbols.entries()) {
    const sized = sizeFromBuyingPower(
      db,
      {
        accountId,
        assetClass: "EQUITY",
        symbol,
        limitPrice: 100,
        desiredQuantity: 10,
        blockDuplicateSymbol: true,
      },
      { maxPositionUtilization: 0.5, maxPositionDollars: 5_000, maxConcurrentPositions: 5 },
    );
    assert.ok(sized.allowed, `${symbol} should fit: ${sized.reasons.join(",")}`);
    const { orderId } = submitOrder(db, {
      accountId,
      clientOrderKey: `c-${i}`,
      evidenceChainId: ev.id,
      assetClass: "EQUITY",
      symbol,
      side: "BUY",
      quantity: sized.quantity,
      limitPrice: 100,
      contractMultiplier: 1,
    });
    fillOrder(db, {
      orderId,
      fillKey: `f-${i}`,
      quantity: sized.quantity,
      price: 100,
    });
  }
  const state = getAccountState(db, accountId);
  assert.equal(state.positions.length, 3);
  assert.ok(state.balances.cash < 10_000);
  assert.equal(state.balances.reserved, 0);
  const ledgerLen = db.prepare(`SELECT COUNT(*) AS c FROM broker_ledger_entries WHERE account_id=?`).get(accountId).c;
  assert.ok(ledgerLen >= 1 + 3 * 2); // open + reserve/fill pairs (release may add more)
});

test("B2 rejects sizing when concurrent cap is hit", { skip: !Database }, () => {
  const db = brokerDb();
  const { accountId } = openAccount(db, {
    accountKey: "cap",
    accountType: "SUBSCRIBER_PAPER",
    displayName: "Cap",
    openingDeposit: 50_000,
  });
  const ev = createEvidenceChain(db, { chainJson: {} });
  for (let i = 0; i < 2; i++) {
    const { orderId } = submitOrder(db, {
      accountId,
      clientOrderKey: `cap-${i}`,
      evidenceChainId: ev.id,
      assetClass: "EQUITY",
      symbol: `T${i}`,
      side: "BUY",
      quantity: 1,
      limitPrice: 10,
    });
    fillOrder(db, { orderId, fillKey: `capf-${i}`, quantity: 1, price: 10 });
  }
  const blocked = sizeFromBuyingPower(
    db,
    {
      accountId,
      assetClass: "EQUITY",
      symbol: "T2",
      limitPrice: 10,
      desiredQuantity: 1,
    },
    { maxPositionUtilization: 1, maxPositionDollars: 50_000, maxConcurrentPositions: 2 },
  );
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.reasons.some((r) => /concurrent/i.test(r)));
});

test("PAPER_BROKER_V2_ENABLED remains off by default", () => {
  assert.equal(paperBrokerV2Enabled({}), false);
});
