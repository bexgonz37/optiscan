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
  applyMark,
  computeAccountEquity,
  snapshotAccountEquity,
  readEquityCurve,
  decideMark,
  reconcileAccountEquity,
  reconcileAccountOnDb,
  reconcileCloseTransfer,
  MARK_POLICY_VERSION,
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

function db() {
  const d = new Database(":memory:");
  ensureBrokerSchemaOnDb(d);
  return d;
}

test("mark policy is documented and versioned", () => {
  assert.match(read("docs/BROKER_MARK_POLICY.md"), /WORTHLESS/);
  assert.match(read("docs/BROKER_MARK_POLICY.md"), /totalEquity = cash/);
  assert.equal(MARK_POLICY_VERSION, 1);
  assert.equal(paperBrokerV2Enabled({}), false);
});

test("decideMark: missing and one-sided never invent prices", () => {
  assert.equal(decideMark(null).usable, false);
  assert.equal(decideMark(null).status, "MISSING");
  const one = decideMark({ bid: 1.2, ask: null });
  assert.equal(one.usable, false);
  assert.equal(one.status, "ONE_SIDED");
});

test("decideMark: worthless expiration marks to zero", () => {
  const d = decideMark({ bid: null, ask: null, expired: true });
  assert.equal(d.status, "WORTHLESS");
  assert.equal(d.markPrice, 0);
  assert.equal(d.usable, true);
});

test("decideMark: stale quote unusable by default", () => {
  const d = decideMark({ bid: 1, ask: 1.2, quoteAgeMs: 9_999_999 });
  assert.equal(d.status, "STALE");
  assert.equal(d.usable, false);
});

test("B3 dollar equity: cash + marked positions, HWM, drawdown, completeness", { skip: !Database }, () => {
  const database = db();
  const { accountId } = openAccount(database, {
    accountKey: "eq1",
    accountType: "SUBSCRIBER_PAPER",
    displayName: "Eq",
    openingDeposit: 10_000,
  });
  const ev = createEvidenceChain(database, { chainJson: {} });
  const { orderId } = submitOrder(database, {
    accountId,
    clientOrderKey: "o1",
    evidenceChainId: ev.id,
    assetClass: "OPTION",
    symbol: "O:SPY_C500",
    side: "BUY",
    quantity: 2,
    limitPrice: 1.5,
    contractMultiplier: 100,
  });
  fillOrder(database, { orderId, fillKey: "f1", quantity: 2, price: 1.5 });
  // Cost = 1.5 * 2 * 100 = 300; cash = 9700
  applyMark(database, {
    accountId,
    assetClass: "OPTION",
    symbol: "O:SPY_C500",
    markPrice: 2.0,
    markSource: "test",
    markStatus: "OK",
    idempotencyKey: "m1",
  });
  const { id, equity } = snapshotAccountEquity(database, accountId, { source: "test" });
  assert.ok(id);
  assert.equal(equity.cash, 9700);
  assert.equal(equity.grossPositionValue, 400); // 2 * 2.0 * 100
  assert.equal(equity.totalEquity, 10100);
  assert.equal(equity.unrealizedPnl, 100);
  assert.equal(equity.completeness, "COMPLETE");
  assert.ok(equity.highWaterMark >= equity.totalEquity);
  assert.equal(equity.markPolicyVersion, MARK_POLICY_VERSION);

  const checks = reconcileAccountEquity(equity);
  assert.ok(checks.every((c) => c.ok), JSON.stringify(checks.filter((c) => !c.ok)));

  const curve = readEquityCurve(database, accountId);
  assert.ok(curve.length >= 1);
  assert.equal(curve.at(-1)?.totalEquity, 10100);
});

test("B3 multiple concurrent option positions aggregate in one snapshot", { skip: !Database }, () => {
  const database = db();
  const { accountId } = openAccount(database, {
    accountKey: "multi",
    accountType: "RESEARCH_SHADOW",
    displayName: "Multi",
    openingDeposit: 20_000,
  });
  const ev = createEvidenceChain(database, { chainJson: {} });
  for (const [i, sym] of ["O:AAPL_C200", "O:MSFT_C400"].entries()) {
    const { orderId } = submitOrder(database, {
      accountId,
      clientOrderKey: `mo-${i}`,
      evidenceChainId: ev.id,
      assetClass: "OPTION",
      symbol: sym,
      side: "BUY",
      quantity: 1,
      limitPrice: 2,
      contractMultiplier: 100,
    });
    fillOrder(database, { orderId, fillKey: `mf-${i}`, quantity: 1, price: 2 });
    applyMark(database, {
      accountId,
      assetClass: "OPTION",
      symbol: sym,
      markPrice: 2.5,
      markSource: "test",
      markStatus: "OK",
      idempotencyKey: `mm-${i}`,
    });
  }
  const equity = computeAccountEquity(database, accountId);
  assert.equal(equity.openPositionCount, 2);
  assert.equal(equity.grossPositionValue, 500); // 2 positions * 2.5 * 100
  assert.ok(reconcileAccountOnDb(database, accountId).ok);
});

test("B3 missing mark makes snapshot incomplete and excludes false value", { skip: !Database }, () => {
  const database = db();
  const { accountId } = openAccount(database, {
    accountKey: "miss",
    accountType: "SUBSCRIBER_PAPER",
    displayName: "Miss",
    openingDeposit: 5_000,
  });
  const ev = createEvidenceChain(database, { chainJson: {} });
  const { orderId } = submitOrder(database, {
    accountId,
    clientOrderKey: "miss-o",
    evidenceChainId: ev.id,
    assetClass: "OPTION",
    symbol: "O:QQQ_C400",
    side: "BUY",
    quantity: 1,
    limitPrice: 3,
    contractMultiplier: 100,
  });
  fillOrder(database, { orderId, fillKey: "miss-f", quantity: 1, price: 3 });
  // No mark applied
  const equity = computeAccountEquity(database, accountId);
  assert.equal(equity.missingMarkCount, 1);
  assert.equal(equity.grossPositionValue, 0);
  assert.equal(equity.completeness, "INCOMPLETE");
  assert.equal(equity.totalEquity, equity.cash);
  const checks = reconcileAccountEquity(equity);
  assert.ok(checks.find((c) => c.name === "missing_marks_never_silently_complete")?.ok);
});

test("B3 worthless expiration marks to zero", { skip: !Database }, () => {
  const database = db();
  const { accountId } = openAccount(database, {
    accountKey: "exp",
    accountType: "SUBSCRIBER_PAPER",
    displayName: "Exp",
    openingDeposit: 5_000,
  });
  const ev = createEvidenceChain(database, { chainJson: {} });
  const { orderId } = submitOrder(database, {
    accountId,
    clientOrderKey: "exp-o",
    evidenceChainId: ev.id,
    assetClass: "OPTION",
    symbol: "O:IWM_C200",
    side: "BUY",
    quantity: 1,
    limitPrice: 0.5,
    contractMultiplier: 100,
  });
  fillOrder(database, { orderId, fillKey: "exp-f", quantity: 1, price: 0.5 });
  applyMark(database, {
    accountId,
    assetClass: "OPTION",
    symbol: "O:IWM_C200",
    markPrice: 0,
    markSource: "WORTHLESS",
    markStatus: "WORTHLESS",
    idempotencyKey: "exp-m",
  });
  const equity = computeAccountEquity(database, accountId);
  assert.equal(equity.positions[0].marketPrice, 0);
  assert.equal(equity.grossPositionValue, 0);
  assert.equal(equity.unrealizedPnl, -50); // lost full premium
});

test("B3 close transfers unrealized into realized; equity only moves by fees/slippage", { skip: !Database }, () => {
  const database = db();
  const { accountId } = openAccount(database, {
    accountKey: "close",
    accountType: "SUBSCRIBER_PAPER",
    displayName: "Close",
    openingDeposit: 10_000,
  });
  const ev = createEvidenceChain(database, { chainJson: {} });
  const { orderId } = submitOrder(database, {
    accountId,
    clientOrderKey: "c-o",
    evidenceChainId: ev.id,
    assetClass: "OPTION",
    symbol: "O:SPY_C510",
    side: "BUY",
    quantity: 1,
    limitPrice: 2,
    contractMultiplier: 100,
  });
  fillOrder(database, { orderId, fillKey: "c-f", quantity: 1, price: 2 });
  applyMark(database, {
    accountId,
    assetClass: "OPTION",
    symbol: "O:SPY_C510",
    markPrice: 3,
    markSource: "test",
    markStatus: "OK",
    idempotencyKey: "c-m",
  });
  const before = computeAccountEquity(database, accountId);
  assert.equal(before.unrealizedPnl, 100);
  assert.equal(before.totalEquity, 10100);

  // Close at the mark (no slippage)
  const sell = submitOrder(database, {
    accountId,
    clientOrderKey: "c-x",
    evidenceChainId: ev.id,
    assetClass: "OPTION",
    symbol: "O:SPY_C510",
    side: "SELL",
    quantity: 1,
    limitPrice: 3,
    contractMultiplier: 100,
  });
  fillOrder(database, { orderId: sell.orderId, fillKey: "c-xf", quantity: 1, price: 3 });
  const after = computeAccountEquity(database, accountId);
  assert.equal(after.openPositionCount, 0);
  assert.equal(after.realizedPnl, 100);
  assert.equal(after.unrealizedPnl, 0);
  assert.equal(after.totalEquity, 10100); // unchanged when closing at mark

  const xfer = reconcileCloseTransfer({
    equityBefore: before.totalEquity,
    equityAfter: after.totalEquity,
    unrealizedBefore: before.unrealizedPnl,
    realizedBefore: before.realizedPnl,
    realizedAfter: after.realizedPnl,
    fillSlippageDollars: 0,
    feesDollars: 0,
  });
  assert.ok(xfer.every((c) => c.ok), JSON.stringify(xfer));
});

test("equity snapshots are append-only (no mutation of prior rows)", { skip: !Database }, () => {
  const database = db();
  const { accountId } = openAccount(database, {
    accountKey: "append",
    accountType: "SUBSCRIBER_PAPER",
    displayName: "Append",
    openingDeposit: 1_000,
  });
  const a = snapshotAccountEquity(database, accountId);
  const b = snapshotAccountEquity(database, accountId);
  assert.notEqual(a.id, b.id);
  const count = database.prepare(`SELECT COUNT(*) AS c FROM broker_equity_snapshots WHERE account_id=?`).get(accountId).c;
  assert.ok(count >= 2);
  const first = database.prepare(`SELECT net_equity FROM broker_equity_snapshots WHERE id=?`).get(a.id);
  assert.equal(first.net_equity, a.equity.totalEquity);
});
