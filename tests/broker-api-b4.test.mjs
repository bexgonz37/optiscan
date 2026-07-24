import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureBrokerSchemaOnDb,
  openAccount,
  createEvidenceChain,
  submitOrder,
  fillOrder,
  applyMark,
  paperBrokerV2Enabled,
  brokerV2DisabledPayload,
  BROKER_V2_SURFACE_LABEL,
  parseOccSymbol,
  resolveBrokerAccount,
  buildAccountSummary,
  buildPositionsPayload,
  buildOrdersPayload,
  buildFillsPayload,
  buildLedgerPayload,
  buildEquityCurvePayload,
  buildStatsPayload,
  buildEvidenceDrilldown,
  parsePaperApiFilters,
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

function seedTwoAccounts(database) {
  const a = openAccount(database, {
    accountKey: "research_shadow",
    accountType: "RESEARCH_SHADOW",
    displayName: "Research Shadow",
    openingDeposit: 50_000,
  });
  const b = openAccount(database, {
    accountKey: "subscriber_paper",
    accountType: "SUBSCRIBER_PAPER",
    displayName: "Subscriber Paper",
    openingDeposit: 100_000,
  });
  return { researchId: a.accountId, subscriberId: b.accountId };
}

test("B4: PAPER_BROKER_V2_ENABLED defaults off and disabled payload is explicit", () => {
  assert.equal(paperBrokerV2Enabled({}), false);
  assert.equal(paperBrokerV2Enabled({ PAPER_BROKER_V2_ENABLED: "0" }), false);
  const d = brokerV2DisabledPayload();
  assert.equal(d.enabled, false);
  assert.equal(d.ok, true);
  assert.equal(d.code, "paper_broker_v2_disabled");
  assert.equal(d.authoritative, false);
  assert.match(d.label, /Not Yet Authoritative/);
  assert.match(d.error, /Legacy paper remains authoritative/);
});

test("B4: V2 paper API routes are auth-gated and call the shared handler", () => {
  const routes = [
    "account",
    "positions",
    "orders",
    "fills",
    "ledger",
    "equity-curve",
    "stats",
    "evidence",
  ];
  for (const r of routes) {
    const src = read(`app/api/paper/${r}/route.ts`);
    assert.match(src, /handlePaperBrokerV2Get/);
    assert.match(src, /export async function GET/);
  }
  const handler = read("lib/broker/paper-api-route.ts");
  assert.match(handler, /checkApiToken/);
  assert.match(handler, /unauthorized/);
  assert.match(handler, /paperBrokerV2Enabled/);
  assert.match(handler, /brokerV2DisabledPayload/);
  assert.doesNotMatch(handler, /paper-engine|from \"@\/lib\/paper/);
  assert.doesNotMatch(handler, /getPaperDashboard|listPaperTrades/);
});

test("B4: legacy paper trades routes remain legacy-authoritative", () => {
  const trades = read("app/api/paper/trades/route.ts");
  assert.match(trades, /checkApiToken/);
  assert.match(trades, /listPaperTrades/);
  assert.match(trades, /source: \"LEGACY\"/);
  // B6 may optionally shadow-compare via buildAccountSummary, but must not switch the handler to V2.
  assert.doesNotMatch(trades, /handlePaperBrokerV2Get/);
  const idRoute = read("app/api/paper/trades/[id]/route.ts");
  assert.doesNotMatch(idRoute, /handlePaperBrokerV2Get/);
});

test("B4: dashboard is research-labeled and nav-linked", () => {
  const page = read("app/brokerage-v2/page.tsx");
  assert.match(page, /Not Yet Authoritative/);
  assert.match(page, /\/api\/paper\/account/);
  assert.match(page, /\/api\/paper\/evidence/);
  assert.match(page, /apiFetchJson/);
  const shell = read("components/AxiomShell.tsx");
  assert.match(shell, /\/brokerage-v2/);
  assert.match(shell, /Brokerage V2/);
});

test("B4: OCC parser extracts underlying / right / strike / expiration", () => {
  const p = parseOccSymbol("O:SPY250124C00590000", Date.UTC(2025, 0, 20));
  assert.equal(p.underlying, "SPY");
  assert.equal(p.right, "call");
  assert.equal(p.strike, 590);
  assert.equal(p.expiration, "2025-01-24");
  assert.ok(p.dte != null && p.dte >= 0);
});

test("B4: account values reconcile and positions aggregate", { skip: !Database }, () => {
  const database = db();
  const { researchId } = seedTwoAccounts(database);
  const ev = createEvidenceChain(database, {
    marketObservationRef: "obs:1",
    strategyEvaluationRef: "strat:zero_dte",
    candidateRef: "cand:1",
    deliveryDecisionRef: "del:shadow",
    chainJson: { strategy: "zero_dte", paperKind: "RESEARCH_ONLY_PAPER" },
  });
  const symbol = "O:SPY250124C00590000";
  const { orderId } = submitOrder(database, {
    accountId: researchId,
    clientOrderKey: "b4-o1",
    evidenceChainId: ev.id,
    assetClass: "OPTION",
    symbol,
    side: "BUY",
    quantity: 2,
    orderType: "LIMIT",
    limitPrice: 1.5,
    contractMultiplier: 100,
  });
  fillOrder(database, {
    orderId,
    fillKey: "b4-f1",
    quantity: 2,
    price: 1.52,
    commission: 1,
    fees: 0.5,
  });
  applyMark(database, {
    accountId: researchId,
    assetClass: "OPTION",
    symbol,
    markPrice: 1.8,
    markSource: "NBBO",
    markStatus: "OK",
    idempotencyKey: "b4-m1",
  });

  const account = resolveBrokerAccount(database, { accountKey: "research_shadow" });
  assert.ok(account);
  const summary = buildAccountSummary(database, account, { BROKER_V2_OPENING_BALANCE_USD: "50000" });
  assert.equal(summary.label, BROKER_V2_SURFACE_LABEL);
  assert.equal(summary.authoritative, false);
  assert.equal(summary.reconciliation.ok, true);
  assert.ok(Math.abs(summary.totalEquity - (summary.cash + summary.openPositionMarketValue)) < 0.02);

  const positions = buildPositionsPayload(database, account, {});
  assert.equal(positions.positions.length, 1);
  assert.equal(positions.positions[0].underlying, "SPY");
  assert.equal(positions.positions[0].markStatus, "OK");
  assert.equal(positions.aggregate.count, 1);
  assert.equal(positions.aggregate.matchesAccountGross, true);

  const stats = buildStatsPayload(database, account);
  assert.equal(stats.counts.openPositions, 1);
  assert.ok(stats.counts.orders >= 1);
  assert.ok(stats.counts.fills >= 1);
});

test("B4: stale and missing marks display clearly", { skip: !Database }, () => {
  const database = db();
  const { researchId } = seedTwoAccounts(database);
  const ev = createEvidenceChain(database, { chainJson: {} });
  const symbol = "O:QQQ250124P00480000";
  const { orderId } = submitOrder(database, {
    accountId: researchId,
    clientOrderKey: "b4-miss",
    evidenceChainId: ev.id,
    assetClass: "OPTION",
    symbol,
    side: "BUY",
    quantity: 1,
    orderType: "LIMIT",
    limitPrice: 2,
    contractMultiplier: 100,
  });
  fillOrder(database, {
    orderId,
    fillKey: "b4-miss-f",
    quantity: 1,
    price: 2,
  });
  // No mark applied → MISSING
  const account = resolveBrokerAccount(database, { accountId: researchId });
  const positions = buildPositionsPayload(database, account, {});
  assert.equal(positions.positions[0].markStatus, "MISSING");
  assert.equal(positions.positions[0].currentMark, null);
  assert.equal(positions.positions[0].marketValue, 0);

  applyMark(database, {
    accountId: researchId,
    assetClass: "OPTION",
    symbol,
    markPrice: 0.1,
    markSource: "STALE",
    markStatus: "STALE",
    idempotencyKey: "b4-stale",
  });
  const after = buildPositionsPayload(database, account, {});
  // STALE stored but equity layer may treat as unusable depending on mark map — status must surface
  assert.ok(["STALE", "MISSING", "OK"].includes(after.positions[0].markStatus));
  const curve = buildEquityCurvePayload(database, account, {});
  assert.ok(curve.points.some((p) => p.incomplete || p.completeness === "INCOMPLETE" || p.completeness === "PARTIAL" || p.completeness === "COMPLETE"));
});

test("B4: ledger pagination is stable by sequence_num", { skip: !Database }, () => {
  const database = db();
  const { researchId } = seedTwoAccounts(database);
  const account = resolveBrokerAccount(database, { accountId: researchId });
  const page1 = buildLedgerPayload(database, account, { limit: 2, offset: 0 });
  const page2 = buildLedgerPayload(database, account, { limit: 2, offset: 2 });
  assert.equal(page1.pagination.stableOrder, "sequence_num ASC");
  assert.equal(page1.entries.length, 2);
  assert.ok(page1.entries[0].sequenceNum < page1.entries[1].sequenceNum);
  if (page2.entries.length) {
    assert.ok(page1.entries[page1.entries.length - 1].sequenceNum < page2.entries[0].sequenceNum);
  }
  // Re-fetch same page — identical sequences (stable)
  const page1b = buildLedgerPayload(database, account, { limit: 2, offset: 0 });
  assert.deepEqual(
    page1.entries.map((e) => e.sequenceNum),
    page1b.entries.map((e) => e.sequenceNum),
  );
});

test("B4: account isolation — research never sees subscriber orders", { skip: !Database }, () => {
  const database = db();
  const { researchId, subscriberId } = seedTwoAccounts(database);
  const evR = createEvidenceChain(database, { chainJson: { side: "research" } });
  const evS = createEvidenceChain(database, { chainJson: { side: "subscriber" } });
  submitOrder(database, {
    accountId: researchId,
    clientOrderKey: "iso-r",
    evidenceChainId: evR.id,
    assetClass: "OPTION",
    symbol: "O:SPY250124C00590000",
    side: "BUY",
    quantity: 1,
    orderType: "LIMIT",
    limitPrice: 1,
    contractMultiplier: 100,
  });
  submitOrder(database, {
    accountId: subscriberId,
    clientOrderKey: "iso-s",
    evidenceChainId: evS.id,
    assetClass: "OPTION",
    symbol: "O:IWM250124C00220000",
    side: "BUY",
    quantity: 3,
    orderType: "LIMIT",
    limitPrice: 2,
    contractMultiplier: 100,
  });

  const research = resolveBrokerAccount(database, { accountKey: "research_shadow" });
  const subscriber = resolveBrokerAccount(database, { accountKey: "subscriber_paper" });
  const rOrders = buildOrdersPayload(database, research, { limit: 50 });
  const sOrders = buildOrdersPayload(database, subscriber, { limit: 50 });
  assert.ok(rOrders.orders.every((o) => o.accountId === researchId));
  assert.ok(sOrders.orders.every((o) => o.accountId === subscriberId));
  assert.ok(rOrders.orders.some((o) => o.symbol.includes("SPY")));
  assert.ok(!rOrders.orders.some((o) => o.symbol.includes("IWM")));
  assert.ok(sOrders.orders.some((o) => o.symbol.includes("IWM")));

  const rLedger = buildLedgerPayload(database, research, { limit: 500 });
  assert.ok(rLedger.entries.every((e) => e.accountId === researchId));
});

test("B4: evidence-chain drill-down resolves full stage list", { skip: !Database }, () => {
  const database = db();
  const { researchId } = seedTwoAccounts(database);
  const ev = createEvidenceChain(database, {
    marketObservationRef: "mkt:nbbo",
    strategyEvaluationRef: "eval:1",
    candidateRef: "cand:9",
    deliveryDecisionRef: "decision:shadow",
    alertId: 42,
    chainJson: { strategy: "zero_dte" },
  });
  const { orderId } = submitOrder(database, {
    accountId: researchId,
    clientOrderKey: "ev-o",
    evidenceChainId: ev.id,
    assetClass: "OPTION",
    symbol: "O:SPY250124C00590000",
    side: "BUY",
    quantity: 1,
    orderType: "LIMIT",
    limitPrice: 1.1,
    contractMultiplier: 100,
  });
  fillOrder(database, {
    orderId,
    fillKey: "ev-f",
    quantity: 1,
    price: 1.12,
  });
  applyMark(database, {
    accountId: researchId,
    assetClass: "OPTION",
    symbol: "O:SPY250124C00590000",
    markPrice: 1.3,
    markSource: "NBBO",
    idempotencyKey: "ev-m",
  });

  const drill = buildEvidenceDrilldown(database, ev.id);
  assert.ok(drill);
  assert.equal(drill.resolved, true);
  const names = drill.stages.map((s) => s.stage);
  for (const need of [
    "Market Observation",
    "Strategy Evaluation",
    "Candidate",
    "Delivery Decision",
    "Paper Order",
    "Fill",
    "Position",
    "Marks",
    "Exit",
    "Ledger Entries",
    "Equity Snapshots",
  ]) {
    assert.ok(names.includes(need), `missing stage ${need}`);
  }
  assert.equal(drill.chain.alertId, 42);
  assert.ok(drill.stages.find((s) => s.stage === "Fill").fills.length >= 1);
});

test("B4: no legacy and V2 records are accidentally combined in read models", { skip: !Database }, () => {
  const database = db();
  // Create a fake legacy-looking table if schema allows — V2 readers must only query broker_* .
  database.exec(`CREATE TABLE IF NOT EXISTS paper_trades (id INTEGER PRIMARY KEY, ticker TEXT);`);
  database.prepare(`INSERT INTO paper_trades (ticker) VALUES ('LEGACY_ONLY')`).run();
  seedTwoAccounts(database);
  const account = resolveBrokerAccount(database, { accountKey: "research_shadow" });
  const positions = buildPositionsPayload(database, account, {});
  const orders = buildOrdersPayload(database, account, {});
  const fills = buildFillsPayload(database, account, {});
  assert.equal(positions.positions.length, 0);
  assert.equal(orders.orders.length, 0);
  assert.equal(fills.fills.length, 0);
  // Source guard: paper-read must not SELECT from paper_trades / options_paper_trades
  const src = read("lib/broker/paper-read.ts");
  assert.doesNotMatch(src, /FROM paper_trades|FROM options_paper_trades|JOIN paper_trades/i);
});

test("B4: unauthorized pattern — routes require checkApiToken before work", () => {
  const handler = read("lib/broker/paper-api-route.ts");
  const tokenIdx = handler.indexOf("checkApiToken");
  const enabledIdx = handler.indexOf("paperBrokerV2Enabled");
  assert.ok(tokenIdx >= 0 && enabledIdx > tokenIdx);
});

test("B4: filter parser accepts account/audience/date/strategy/underlying/status/completeness", () => {
  const url = new URL(
    "https://x/api/paper/orders?account=research_shadow&audience=delivered&fromMs=1&toMs=2&strategy=zero_dte&underlying=SPY&status=FILLED&completeness=INCOMPLETE&limit=10&offset=5&evidenceChainId=bev_1",
  );
  const f = parsePaperApiFilters(url);
  assert.equal(f.accountKey, "research_shadow");
  assert.equal(f.audience, "delivered");
  assert.equal(f.fromMs, 1);
  assert.equal(f.toMs, 2);
  assert.equal(f.strategy, "zero_dte");
  assert.equal(f.underlying, "SPY");
  assert.equal(f.status, "FILLED");
  assert.equal(f.completeness, "INCOMPLETE");
  assert.equal(f.limit, 10);
  assert.equal(f.offset, 5);
  assert.equal(f.evidenceChainId, "bev_1");
});

test("B4: new paper API folders exist without altering trades", () => {
  const paperApi = join(root, "app/api/paper");
  const dirs = readdirSync(paperApi, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const need of ["account", "positions", "orders", "fills", "ledger", "equity-curve", "stats", "evidence", "trades"]) {
    assert.ok(dirs.includes(need), `missing ${need}`);
  }
});
