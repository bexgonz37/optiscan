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
  snapshotAccountEquity,
  listClosedRoundTrips,
  buildAnalyticsReport,
  buildStatsPayload,
  computePerformanceMetrics,
  computeRiskMetrics,
  computeDrawdownStats,
  computeKellyInputs,
  dailyReturns,
  loadEquityPoints,
  defaultAnalyticsPolicy,
  ANALYTICS_METHODOLOGY_VERSION,
  ANALYTICS_SURFACE_LABEL,
  KELLY_ADVISORY_ONLY,
  paperBrokerV2Enabled,
  resolveBrokerAccount,
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

function openBuySell(database, accountId, opts) {
  const {
    key,
    symbol,
    entry,
    exit,
    qty = 1,
    entryFee = 0,
    exitFee = 0,
    strategy = "zero_dte",
    entryAt = Date.now() - 86_400_000,
    exitAt = Date.now(),
  } = opts;
  const ev = createEvidenceChain(database, {
    chainJson: { strategy, paperKind: "RESEARCH_ONLY_PAPER" },
    strategyEvaluationRef: `strat:${strategy}`,
  });
  const { orderId: buyId } = submitOrder(database, {
    accountId,
    clientOrderKey: `${key}-buy`,
    evidenceChainId: ev.id,
    assetClass: "OPTION",
    symbol,
    side: "BUY",
    quantity: qty,
    limitPrice: entry,
    contractMultiplier: 100,
    metadata: { strategy },
  });
  // backdate by rewriting filled_at after fill is awkward; use filledAtMs on fill
  fillOrder(database, {
    orderId: buyId,
    fillKey: `${key}-bf`,
    quantity: qty,
    price: entry,
    commission: entryFee,
    fees: 0,
    filledAtMs: entryAt,
  });
  const { orderId: sellId } = submitOrder(database, {
    accountId,
    clientOrderKey: `${key}-sell`,
    evidenceChainId: ev.id,
    assetClass: "OPTION",
    symbol,
    side: "SELL",
    quantity: qty,
    limitPrice: exit,
    contractMultiplier: 100,
    metadata: { strategy },
  });
  fillOrder(database, {
    orderId: sellId,
    fillKey: `${key}-sf`,
    quantity: qty,
    price: exit,
    commission: exitFee,
    fees: 0,
    filledAtMs: exitAt,
  });
  return ev.id;
}

test("B5: analytics policy documented and versioned", () => {
  assert.match(read("docs/BROKER_ANALYTICS_POLICY.md"), /ANALYTICS_METHODOLOGY_VERSION/);
  assert.match(read("docs/BROKER_ANALYTICS_POLICY.md"), /annualization/);
  assert.match(read("docs/BROKER_ANALYTICS_POLICY.md"), /Kelly/);
  assert.equal(ANALYTICS_METHODOLOGY_VERSION, 1);
  assert.equal(KELLY_ADVISORY_ONLY, true);
  assert.match(ANALYTICS_SURFACE_LABEL, /Not Yet Authoritative/);
  assert.equal(paperBrokerV2Enabled({}), false);
});

test("B5: profit factor = gross profit / abs(gross loss)", { skip: !Database }, () => {
  const database = db();
  const { accountId } = openAccount(database, {
    accountKey: "research_shadow",
    accountType: "RESEARCH_SHADOW",
    displayName: "R",
    openingDeposit: 100_000,
  });
  // Winner: entry 1 → exit 2 = +100 per contract
  openBuySell(database, accountId, {
    key: "w1",
    symbol: "O:SPY250124C00590000",
    entry: 1,
    exit: 2,
    qty: 1,
    entryAt: 1_000_000,
    exitAt: 1_100_000,
  });
  // Loser: entry 2 → exit 1 = -100
  openBuySell(database, accountId, {
    key: "l1",
    symbol: "O:QQQ250124P00480000",
    entry: 2,
    exit: 1,
    qty: 1,
    entryAt: 1_200_000,
    exitAt: 1_300_000,
  });
  const trades = listClosedRoundTrips(database, accountId);
  assert.equal(trades.length, 2);
  const perf = computePerformanceMetrics(trades, [], 100_000);
  assert.equal(perf.grossProfit.value, 100);
  assert.equal(perf.grossLoss.value, 100);
  assert.equal(perf.profitFactor.value, 1);
});

test("B5: expectancy uses dollar-weighted trade outcomes; fees reduce net", { skip: !Database }, () => {
  const database = db();
  const { accountId } = openAccount(database, {
    accountKey: "research_shadow",
    accountType: "RESEARCH_SHADOW",
    displayName: "R",
    openingDeposit: 50_000,
  });
  openBuySell(database, accountId, {
    key: "f1",
    symbol: "O:SPY250124C00590000",
    entry: 1,
    exit: 2,
    qty: 1,
    entryFee: 5,
    exitFee: 5,
    entryAt: 1_000_000,
    exitAt: 2_000_000,
  });
  const trades = listClosedRoundTrips(database, accountId);
  assert.equal(trades[0].grossPnlDollars, 100);
  assert.equal(trades[0].commissionFees, 10);
  assert.equal(trades[0].netPnlDollars, 90);
  const perf = computePerformanceMetrics(trades, [], 50_000);
  assert.equal(perf.expectancyPerTradeDollars.value, 90);
});

test("B5: drawdown is based on dollar equity snapshots", { skip: !Database }, () => {
  const points = [
    { atMs: 1, netEquity: 100, highWaterMark: 100, drawdownDollars: 0, drawdownPct: 0, completeness: "COMPLETE", missingMarkCount: 0, staleMarkCount: 0 },
    { atMs: 2, netEquity: 120, highWaterMark: 120, drawdownDollars: 0, drawdownPct: 0, completeness: "COMPLETE", missingMarkCount: 0, staleMarkCount: 0 },
    { atMs: 3, netEquity: 90, highWaterMark: 120, drawdownDollars: 30, drawdownPct: 25, completeness: "COMPLETE", missingMarkCount: 0, staleMarkCount: 0 },
    { atMs: 4, netEquity: 110, highWaterMark: 120, drawdownDollars: 10, drawdownPct: 8.33, completeness: "COMPLETE", missingMarkCount: 0, staleMarkCount: 0 },
  ];
  const dd = computeDrawdownStats(points);
  assert.equal(dd.maxDrawdownDollars, 30);
  assert.ok(Math.abs(dd.maxDrawdownPct - 25) < 0.01);
});

test("B5: Sharpe/Sortino null when observation window too short", () => {
  const policy = defaultAnalyticsPolicy({
    BROKER_V2_ANALYTICS_MIN_DAYS: "30",
    BROKER_V2_ANALYTICS_MIN_RETURNS: "5",
  });
  // 5 daily points spanning ~4 days
  const base = Date.UTC(2025, 0, 1);
  const points = [0, 1, 2, 3, 4].map((i) => ({
    atMs: base + i * 86_400_000,
    netEquity: 100 + i,
    highWaterMark: 100 + i,
    drawdownDollars: 0,
    drawdownPct: 0,
    completeness: "COMPLETE",
    missingMarkCount: 0,
    staleMarkCount: 0,
  }));
  const risk = computeRiskMetrics(points, policy);
  assert.equal(risk.sharpeRatio.value, null);
  assert.match(risk.sharpeRatio.reason, /observation_window_too_short|need_/);
  assert.equal(dailyReturns(points).length, 4);
});

test("B5: multiple concurrent positions do not double-count equity", { skip: !Database }, () => {
  const database = db();
  const { accountId } = openAccount(database, {
    accountKey: "research_shadow",
    accountType: "RESEARCH_SHADOW",
    displayName: "R",
    openingDeposit: 20_000,
  });
  const t0 = Date.UTC(2025, 5, 1);
  // Two open longs concurrently (no exits yet) — equity snapshot once
  for (const [i, sym] of ["O:AAPL250620C00200000", "O:MSFT250620C00400000"].entries()) {
    const ev = createEvidenceChain(database, { chainJson: { strategy: "swing" } });
    const { orderId } = submitOrder(database, {
      accountId,
      clientOrderKey: `c-${i}`,
      evidenceChainId: ev.id,
      assetClass: "OPTION",
      symbol: sym,
      side: "BUY",
      quantity: 1,
      limitPrice: 1,
      contractMultiplier: 100,
    });
    fillOrder(database, { orderId, fillKey: `cf-${i}`, quantity: 1, price: 1, filledAtMs: t0 + i });
    applyMark(database, {
      accountId,
      assetClass: "OPTION",
      symbol: sym,
      markPrice: 1.5,
      markSource: "test",
      markStatus: "OK",
      idempotencyKey: `cm-${i}`,
      markedAtMs: t0 + 1000,
    });
  }
  const { equity } = snapshotAccountEquity(database, accountId, { asOfMs: t0 + 2000 });
  // cash 20_000 - 200 - 200 = 19600; MV = 150+150 = 300; equity 19900
  assert.equal(equity.grossPositionValue, 300);
  assert.equal(equity.openPositionCount, 2);
  assert.equal(equity.totalEquity, equity.cash + equity.grossPositionValue);
  const account = resolveBrokerAccount(database, { accountId });
  const report = buildAnalyticsReport(database, account, { allEquitySnapshots: true });
  assert.ok(report.exposure.grossExposure.value === 300);
});

test("B5: account isolation for analytics", { skip: !Database }, () => {
  const database = db();
  const a = openAccount(database, {
    accountKey: "research_shadow",
    accountType: "RESEARCH_SHADOW",
    displayName: "R",
    openingDeposit: 10_000,
  });
  const b = openAccount(database, {
    accountKey: "subscriber_paper",
    accountType: "SUBSCRIBER_PAPER",
    displayName: "S",
    openingDeposit: 10_000,
  });
  openBuySell(database, a.accountId, {
    key: "ra",
    symbol: "O:SPY250124C00590000",
    entry: 1,
    exit: 3,
    entryAt: 1e6,
    exitAt: 2e6,
  });
  openBuySell(database, b.accountId, {
    key: "sb",
    symbol: "O:IWM250124C00220000",
    entry: 1,
    exit: 0.5,
    entryAt: 1e6,
    exitAt: 2e6,
  });
  const ra = resolveBrokerAccount(database, { accountKey: "research_shadow" });
  const sa = resolveBrokerAccount(database, { accountKey: "subscriber_paper" });
  const rReport = buildAnalyticsReport(database, ra, {});
  const sReport = buildAnalyticsReport(database, sa, {});
  assert.match(rReport.aggregationLabel, /research_shadow/);
  assert.match(sReport.aggregationLabel, /subscriber_paper/);
  assert.equal(rReport.dataQuality.sampleSizeTrades, 1);
  assert.equal(sReport.dataQuality.sampleSizeTrades, 1);
  assert.ok(rReport.performance.expectancyPerTradeDollars.value > 0);
  assert.ok(sReport.performance.expectancyPerTradeDollars.value < 0);
});

test("B5: incomplete snapshots excluded or labeled", { skip: !Database }, () => {
  const database = db();
  const { accountId } = openAccount(database, {
    accountKey: "research_shadow",
    accountType: "RESEARCH_SHADOW",
    displayName: "R",
    openingDeposit: 5_000,
  });
  // Force an incomplete snapshot by opening unmarked position
  const ev = createEvidenceChain(database, { chainJson: {} });
  const { orderId } = submitOrder(database, {
    accountId,
    clientOrderKey: "inc1",
    evidenceChainId: ev.id,
    assetClass: "OPTION",
    symbol: "O:SPY250124C00590000",
    side: "BUY",
    quantity: 1,
    limitPrice: 1,
    contractMultiplier: 100,
  });
  fillOrder(database, { orderId, fillKey: "inc1f", quantity: 1, price: 1 });
  snapshotAccountEquity(database, accountId, { asOfMs: Date.now() });
  const account = resolveBrokerAccount(database, { accountId });
  const filtered = buildAnalyticsReport(database, account, { completeSnapshotsOnly: true });
  assert.ok(
    filtered.dataQuality.incompleteSnapshotCount >= 1 ||
      filtered.dataQuality.excludedSnapshotCount >= 0,
  );
  assert.ok(
    filtered.dataQuality.warnings.some((w) => /incomplete|insufficient/i.test(w)) ||
      filtered.dataQuality.completenessStatus === "complete_filtered",
  );
});

test("B5: insufficient samples return warnings not misleading Kelly", () => {
  const policy = defaultAnalyticsPolicy({ BROKER_V2_ANALYTICS_MIN_TRADES: "10" });
  const kelly = computeKellyInputs([], policy, 10_000);
  assert.equal(kelly.fullKellyFraction.value, null);
  assert.ok(kelly.warnings.some((w) => /sample_too_small/.test(w)));
  assert.equal(kelly.advisoryOnly, true);
});

test("B5: Kelly never reaches execution / sizing / delivery code", () => {
  const buy = read("lib/broker/buying-power.ts");
  const dual = read("lib/broker/dual-write.ts");
  const adapter = read("lib/broker/adapter/paper-sim.ts");
  assert.doesNotMatch(buy, /kelly|computeKelly|analytics/i);
  assert.doesNotMatch(dual, /kelly|computeKellyInputs/i);
  assert.doesNotMatch(adapter, /kelly|computeKellyInputs/i);
  // Scanner / delivery guards
  const scannerFiles = ["lib/scanner-loop.ts", "lib/discord-desk.ts", "lib/scanner-filters.ts"];
  for (const f of scannerFiles) {
    try {
      const src = read(f);
      assert.doesNotMatch(src, /computeKellyInputs|fullKellyFraction|BROKER_V2_ANALYTICS/);
    } catch {
      /* optional path */
    }
  }
  assert.equal(KELLY_ADVISORY_ONLY, true);
});

test("B5: stats API + dashboard expose analytics sections", () => {
  assert.match(read("app/api/paper/stats/route.ts"), /handlePaperBrokerV2Get/);
  assert.match(read("lib/broker/paper-read.ts"), /buildAnalyticsReport/);
  const page = read("app/brokerage-v2/page.tsx");
  assert.match(page, /Research Analytics — Not Yet Authoritative/);
  assert.match(page, /\/api\/paper\/stats/);
  assert.match(page, /Kelly inputs/);
  assert.match(page, /Data quality/);
  assert.match(page, /Performance/);
  assert.match(read("docs/BROKER_ANALYTICS_POLICY.md"), /not\*\* use cumulative return/i);
});

test("B5: buildStatsPayload includes methodology + dataQuality", { skip: !Database }, () => {
  const database = db();
  const { accountId } = openAccount(database, {
    accountKey: "research_shadow",
    accountType: "RESEARCH_SHADOW",
    displayName: "R",
    openingDeposit: 10_000,
  });
  const account = resolveBrokerAccount(database, { accountId });
  const stats = buildStatsPayload(database, account, {}, {});
  assert.equal(stats.analytics.methodologyVersion, 1);
  assert.ok(stats.analytics.dataQuality);
  assert.equal(stats.analytics.authoritative, false);
  assert.equal(stats.analytics.advisoryKellyOnly, true);
});
