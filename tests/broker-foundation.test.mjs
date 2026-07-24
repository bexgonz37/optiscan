import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BROKER_REQUIRED_TABLES,
  ensureBrokerSchemaOnDb,
  listMissingBrokerTables,
  paperBrokerV2Enabled,
  requirePaperBrokerV2,
  computeBalances,
  computePositions,
  createEvidenceChain,
  traceEvidenceForFill,
  openAccount,
  depositCash,
  submitOrder,
  fillOrder,
  applyMark,
  getAccountState,
  listLedgerEntries,
  listAuditEventsForEntity,
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

function sampleEvidence(db) {
  return createEvidenceChain(db, {
    marketObservationRef: "scanner:obs:1001",
    strategyEvaluationRef: "strategy:eval:2001",
    candidateRef: "candidate:3001",
    deliveryDecisionRef: "delivery:4001",
    alertId: 42,
    opportunityCaseId: "opp-abc",
    chainJson: {
      stage: "delivery_decision",
      ticker: "SPY",
      setup: "zero_dte_momentum",
    },
  });
}

test("PAPER_BROKER_V2_ENABLED defaults off", () => {
  assert.equal(paperBrokerV2Enabled({}), false);
  assert.equal(paperBrokerV2Enabled({ PAPER_BROKER_V2_ENABLED: "0" }), false);
  assert.equal(paperBrokerV2Enabled({ PAPER_BROKER_V2_ENABLED: "1" }), true);
  assert.throws(() => requirePaperBrokerV2({}), /disabled/);
});

test("ensureBrokerSchemaOnDb creates all broker tables", { skip: !Database }, () => {
  const db = new Database(":memory:");
  assert.deepEqual(listMissingBrokerTables(db), [...BROKER_REQUIRED_TABLES]);
  const repaired = ensureBrokerSchemaOnDb(db);
  assert.deepEqual(repaired, [...BROKER_REQUIRED_TABLES]);
  assert.deepEqual(listMissingBrokerTables(db), []);
  assert.deepEqual(ensureBrokerSchemaOnDb(db), []);
});

test("getDb migrate path includes broker schema repair", () => {
  const dbSrc = read("lib/db.ts");
  assert.match(dbSrc, /ensureBrokerSchemaOnDb\(db\)/);
});

test("ledger balances reconstruct from immutable entries only", () => {
  const entries = [
    { cash_delta: 10_000, reserved_delta: 0, sequence_num: 1, asset_class: "CASH", symbol: null, quantity_delta: 0, price: null, entry_kind: "DEPOSIT" },
    { cash_delta: 0, reserved_delta: 500, sequence_num: 2, asset_class: "CASH", symbol: null, quantity_delta: 0, price: null, entry_kind: "ORDER_RESERVE" },
    { cash_delta: -500, reserved_delta: -500, sequence_num: 3, asset_class: "CASH", symbol: null, quantity_delta: 0, price: null, entry_kind: "BUY_FILL" },
  ];
  const balances = computeBalances(entries);
  assert.equal(balances.cash, 9500);
  assert.equal(balances.reserved, 0);
  assert.equal(balances.buyingPower, 9500);
});

test("openAccount + deposit creates audit trail and equity snapshot", { skip: !Database }, () => {
  const db = brokerDb();
  const { accountId } = openAccount(db, {
    accountKey: "subscriber_paper",
    accountType: "SUBSCRIBER_PAPER",
    displayName: "Subscriber Paper",
    openingDeposit: 25_000,
  });
  const state = getAccountState(db, accountId);
  assert.equal(state.balances.cash, 25_000);
  assert.equal(state.balances.buyingPower, 25_000);
  const audits = listAuditEventsForEntity(db, "ACCOUNT", accountId);
  assert.ok(audits.some((a) => a.event_kind === "ACCOUNT_OPENED"));
  const equityCount = db.prepare(`SELECT COUNT(*) AS c FROM broker_equity_snapshots WHERE account_id = ?`).get(accountId).c;
  assert.ok(equityCount >= 1);
});

test("order reserves buying power then fill releases reserve and opens position", { skip: !Database }, () => {
  const db = brokerDb();
  const { accountId } = openAccount(db, {
    accountKey: "research_shadow",
    accountType: "RESEARCH_SHADOW",
    displayName: "Research Shadow",
    openingDeposit: 10_000,
  });
  const evidence = sampleEvidence(db);
  const { orderId } = submitOrder(db, {
    accountId,
    clientOrderKey: "ord-1",
    evidenceChainId: evidence.id,
    assetClass: "OPTION",
    symbol: "O:SPY250124C00590000",
    side: "BUY",
    quantity: 1,
    limitPrice: 2.5,
    contractMultiplier: 100,
  });
  const midReserve = getAccountState(db, accountId);
  assert.equal(midReserve.balances.cash, 10_000);
  assert.equal(midReserve.balances.reserved, 250);
  assert.equal(midReserve.balances.buyingPower, 9750);

  const { fillId, positionSnapshotId } = fillOrder(db, {
    orderId,
    fillKey: "fill-1",
    quantity: 1,
    price: 2.4,
    commission: 0.65,
    fees: 0.05,
  });
  const after = getAccountState(db, accountId);
  assert.equal(after.balances.reserved, 0);
  assert.equal(after.balances.cash, 9759.3);
  assert.equal(after.positions.length, 1);
  assert.equal(after.positions[0].symbol, "O:SPY250124C00590000");
  assert.equal(after.positions[0].quantity, 1);
  assert.equal(after.positions[0].evidenceChainId, evidence.id);
  assert.ok(positionSnapshotId);
  assert.equal(traceEvidenceForFill(db, fillId)?.id, evidence.id);

  const ledgerCount = listLedgerEntries(db, accountId).length;
  assert.ok(ledgerCount >= 5);
  const orderAudits = listAuditEventsForEntity(db, "ORDER", orderId);
  assert.ok(orderAudits.some((a) => a.event_kind === "ORDER_SUBMITTED"));
  const fillAudits = listAuditEventsForEntity(db, "FILL", fillId);
  assert.ok(fillAudits.some((a) => a.event_kind === "ORDER_FILLED"));
});

test("submit and fill are idempotent", { skip: !Database }, () => {
  const db = brokerDb();
  const { accountId } = openAccount(db, {
    accountKey: "replay_lab",
    accountType: "REPLAY_LAB",
    displayName: "Replay Lab",
    openingDeposit: 5_000,
  });
  const evidence = sampleEvidence(db);
  const first = submitOrder(db, {
    accountId,
    clientOrderKey: "dup-order",
    evidenceChainId: evidence.id,
    assetClass: "EQUITY",
    symbol: "AAPL",
    side: "BUY",
    quantity: 10,
    limitPrice: 100,
  });
  const second = submitOrder(db, {
    accountId,
    clientOrderKey: "dup-order",
    evidenceChainId: evidence.id,
    assetClass: "EQUITY",
    symbol: "AAPL",
    side: "BUY",
    quantity: 10,
    limitPrice: 100,
  });
  assert.equal(first.orderId, second.orderId);
  fillOrder(db, { orderId: first.orderId, fillKey: "dup-fill", quantity: 10, price: 99.5 });
  fillOrder(db, { orderId: first.orderId, fillKey: "dup-fill", quantity: 10, price: 99.5 });
  const fills = db.prepare(`SELECT COUNT(*) AS c FROM broker_fills WHERE account_id = ?`).get(accountId).c;
  assert.equal(fills, 1);
});

test("insufficient buying power rejects order before ledger mutation", { skip: !Database }, () => {
  const db = brokerDb();
  const { accountId } = openAccount(db, {
    accountKey: "small",
    accountType: "SUBSCRIBER_PAPER",
    displayName: "Small",
    openingDeposit: 100,
  });
  const evidence = sampleEvidence(db);
  assert.throws(
    () =>
      submitOrder(db, {
        accountId,
        clientOrderKey: "too-big",
        evidenceChainId: evidence.id,
        assetClass: "OPTION",
        symbol: "O:SPY_C600",
        side: "BUY",
        quantity: 10,
        limitPrice: 5,
        contractMultiplier: 100,
      }),
    /insufficient buying power/,
  );
  const orders = db.prepare(`SELECT COUNT(*) AS c FROM broker_orders WHERE account_id = ?`).get(accountId).c;
  assert.equal(orders, 0);
});

test("applyMark updates unrealized pnl without mutating cash ledger history", { skip: !Database }, () => {
  const db = brokerDb();
  const { accountId } = openAccount(db, {
    accountKey: "marks",
    accountType: "SUBSCRIBER_PAPER",
    displayName: "Marks",
    openingDeposit: 10_000,
  });
  const evidence = sampleEvidence(db);
  const { orderId } = submitOrder(db, {
    accountId,
    clientOrderKey: "mark-order",
    evidenceChainId: evidence.id,
    assetClass: "EQUITY",
    symbol: "MSFT",
    side: "BUY",
    quantity: 5,
    limitPrice: 400,
  });
  fillOrder(db, { orderId, fillKey: "mark-fill", quantity: 5, price: 400 });
  const beforeEntries = listLedgerEntries(db, accountId).length;
  applyMark(db, {
    accountId,
    assetClass: "EQUITY",
    symbol: "MSFT",
    markPrice: 410,
    markSource: "test_quote",
    idempotencyKey: "mark-msft-1",
  });
  const afterEntries = listLedgerEntries(db, accountId);
  assert.equal(afterEntries.length, beforeEntries + 1);
  assert.equal(afterEntries.at(-1)?.entry_kind, "MARK");
  const positions = computePositions(afterEntries, new Map([["EQUITY:MSFT", evidence.id]]), new Map([["EQUITY:MSFT", 410]]));
  assert.equal(positions[0].unrealizedPnl, 50);
});

test("schema supports future account types and asset classes without redesign", () => {
  const ddl = read("lib/broker/schema-ddl.ts");
  for (const token of ["SUBSCRIBER_PAPER", "RESEARCH_SHADOW", "REPLAY_LAB", "LIVE_BROKER", "OPTION", "FUTURE", "CRYPTO"]) {
    assert.ok(ddl.includes(token) || /account_type TEXT|asset_class TEXT/.test(ddl), `generic column for ${token}`);
  }
});

test("no live scanner imports broker engine write path", () => {
  for (const file of ["lib/scanner-loop.ts", "lib/paper-engine.ts", "lib/research/options/delivery.ts"]) {
    const src = read(file);
    assert.doesNotMatch(src, /from ["']@\/lib\/broker\/engine|openAccount\(|submitOrder\(|fillOrder\(/);
  }
});
