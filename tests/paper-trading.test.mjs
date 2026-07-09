import test from "node:test";
import assert from "node:assert/strict";
import { PaperBroker } from "../lib/execution/paper-broker.ts";
import {
  canTransition, evaluateEntry, markToMarket, applyExit,
  pnlDollars, pnlPct, dollarsAtRisk, lessonsLearned, ENTRY_WINDOW_MS,
} from "../lib/paper-trading.ts";
import { checkRisk, defaultRiskConfig } from "../lib/paper-risk.ts";
import {
  checkHardExits, checkSmartExit, checkExpiration, evaluateExit, defaultExitConfig, invalidationSignals,
} from "../lib/paper-exits.ts";
import { summarize, byConfidence, byExpirationLength } from "../lib/paper-analytics.ts";

const T = Date.parse("2026-07-09T15:00:00Z");
const q = (bid, ask, ms = T) => ({
  optionSymbol: "O:SPY260716C00500000", bid, ask,
  mid: bid != null && ask != null ? +((bid + ask) / 2).toFixed(4) : null,
  spreadPct: bid && ask ? +(((ask - bid) / ((ask + bid) / 2)) * 100).toFixed(2) : null,
  asOfMs: ms,
});

function trade(overrides = {}) {
  return {
    alertId: 1, ticker: "SPY", optionSymbol: "O:SPY260716C00500000", optionType: "call",
    strike: 500, expiration: "2026-07-16", dteAtEntry: 7, contracts: 1,
    status: "READY", thesis: "HOD break with 2x surge", confidence: 86,
    entryLimit: 1.2, entryPrice: null, entryAtMs: null,
    stopLossPct: 30, takeProfitPct: 50,
    exitPrice: null, exitAtMs: null, exitReason: null,
    mfePct: null, maePct: null, lastMark: null, lastMarkAtMs: null, createdAtMs: T,
    ...overrides,
  };
}

const ENTRY = { shortRateAtEntry: 0.4, aboveVwapAtEntry: true, relVolAtEntry: 2.5 };
const LIVE_OK = { shortRate: 0.35, aboveVwap: true, relVol: 2.2, spreadPct: 4, direction: "bullish" };

// ── Broker fills (conservative model) ──
test("buy fills at the ask only when ask <= limit", () => {
  const b = new PaperBroker();
  const order = { side: "buy_to_open", optionSymbol: "X", contracts: 1, limit: 1.2 };
  assert.equal(b.tryFill(order, q(1.1, 1.18)).filled, true);
  assert.equal(b.tryFill(order, q(1.1, 1.18)).price, 1.18, "pays the ask, not mid");
  assert.equal(b.tryFill(order, q(1.15, 1.25)).filled, false, "ask above limit = no fill");
  assert.equal(b.tryFill(order, q(null, 1.1)).filled, false, "one-sided quote = no fill");
});

test("sell fills at the bid only when bid >= limit", () => {
  const b = new PaperBroker();
  const order = { side: "sell_to_close", optionSymbol: "X", contracts: 1, limit: 1.5 };
  assert.equal(b.tryFill(order, q(1.55, 1.65)).price, 1.55);
  assert.equal(b.tryFill(order, q(1.45, 1.55)).filled, false);
});

// ── State machine ──
test("state machine allows only legal transitions", () => {
  assert.equal(canTransition("WATCHING", "READY"), true);
  assert.equal(canTransition("READY", "ENTERED"), true);
  assert.equal(canTransition("ENTERED", "STOPPED_OUT"), true);
  assert.equal(canTransition("ENTERED", "READY"), false);
  assert.equal(canTransition("EXITED", "ENTERED"), false, "terminal states are final");
  assert.equal(canTransition("WATCHING", "ENTERED"), false, "must go through READY");
});

// ── Entry ──
test("entry fills when ask reaches the limit; MFE/MAE initialize at 0", () => {
  const r = evaluateEntry(trade(), q(1.1, 1.15), T + 5000);
  assert.equal(r.event, "filled");
  assert.equal(r.trade.status, "ENTERED");
  assert.equal(r.trade.entryPrice, 1.15);
  assert.equal(r.trade.mfePct, 0);
  assert.equal(r.trade.maePct, 0);
});

test("entry order cancels after the entry window (momentum goes stale)", () => {
  const r = evaluateEntry(trade(), q(1.5, 1.6), T + ENTRY_WINDOW_MS + 1);
  assert.equal(r.event, "cancelled");
  assert.equal(r.trade.status, "CANCELLED");
  assert.match(r.trade.exitReason, /never filled/);
});

// ── Marks / excursions ──
test("markToMarket tracks MFE and MAE from mid", () => {
  let t = evaluateEntry(trade(), q(1.15, 1.2), T).trade; // entry 1.20
  t = markToMarket(t, q(1.4, 1.5, T + 60_000), T + 60_000);   // mid 1.45 → +20.8%
  t = markToMarket(t, q(0.95, 1.05, T + 120_000), T + 120_000); // mid 1.00 → -16.7%
  assert.ok(t.mfePct > 20 && t.mfePct < 22, `mfe ${t.mfePct}`);
  assert.ok(t.maePct < -16 && t.maePct > -18, `mae ${t.maePct}`);
});

// ── Hard exits ──
test("stop loss evaluates on the bid and fills at the bid", () => {
  const t = { ...trade(), status: "ENTERED", entryPrice: 1.0, entryAtMs: T };
  const d = checkHardExits(t, q(0.69, 0.8), defaultExitConfig());
  assert.equal(d?.kind, "stop_loss");
  assert.equal(d?.fillPrice, 0.69);
  assert.match(d?.reason, /-31%/);
});

test("take profit triggers at +target on the bid", () => {
  const t = { ...trade(), status: "ENTERED", entryPrice: 1.0, entryAtMs: T };
  const d = checkHardExits(t, q(1.55, 1.65), defaultExitConfig());
  assert.equal(d?.kind, "take_profit");
});

test("no hard exit inside the band", () => {
  const t = { ...trade(), status: "ENTERED", entryPrice: 1.0, entryAtMs: T };
  assert.equal(checkHardExits(t, q(1.1, 1.2), defaultExitConfig()), null);
});

// ── Smart exits ──
test("one soft invalidation is NOT enough; two independent ones exit", () => {
  const t = { ...trade(), status: "ENTERED", entryPrice: 1.0, entryAtMs: T };
  const cfg = defaultExitConfig();
  const oneSoft = { ...LIVE_OK, aboveVwap: false }; // VWAP break only
  assert.equal(checkSmartExit(t, q(0.95, 1.05), oneSoft, ENTRY, cfg), null);
  const twoSoft = { ...LIVE_OK, aboveVwap: false, relVol: 0.5 }; // + RVOL fade
  const d = checkSmartExit(t, q(0.95, 1.05), twoSoft, ENTRY, cfg);
  assert.equal(d?.kind, "smart");
  assert.match(d?.reason, /VWAP/);
  assert.match(d?.reason, /volume faded/);
});

test("hard reversal against the position is catastrophic — exits alone", () => {
  const t = { ...trade(), status: "ENTERED", entryPrice: 1.0, entryAtMs: T };
  const live = { ...LIVE_OK, shortRate: -0.3 };
  const d = checkSmartExit(t, q(0.95, 1.05), live, ENTRY, defaultExitConfig());
  assert.equal(d?.kind, "smart");
  assert.match(d?.reason, /AGAINST/);
});

test("momentum decay counts as an invalidation signal", () => {
  const t = { ...trade(), status: "ENTERED", entryPrice: 1.0 };
  const live = { ...LIVE_OK, shortRate: 0.05 }; // decayed from 0.40
  const sigs = invalidationSignals(t, live, ENTRY, defaultExitConfig());
  assert.ok(sigs.some((s) => /momentum decayed/.test(s.signal)));
});

test("exit priority: stop loss outranks smart exit; expiration outranks all", () => {
  const t = { ...trade(), status: "ENTERED", entryPrice: 1.0, entryAtMs: T, lastMark: 0.5 };
  const badLive = { ...LIVE_OK, shortRate: -0.5, aboveVwap: false, relVol: 0.2 };
  const d = evaluateExit(t, q(0.6, 0.7), badLive, ENTRY, T, defaultExitConfig());
  assert.equal(d?.kind, "stop_loss", "stop first even when thesis is dead");
  const expired = { ...t, expiration: "2026-07-01" };
  const d2 = evaluateExit(expired, q(0.6, 0.7), badLive, ENTRY, T, defaultExitConfig());
  assert.equal(d2?.kind, "expired");
});

test("applyExit sets terminal state + explains; P/L computes", () => {
  const t = { ...trade(), status: "ENTERED", entryPrice: 1.0, entryAtMs: T, contracts: 2 };
  const done = applyExit(t, { kind: "take_profit", reason: "target hit", fillPrice: 1.5 }, T + 300_000);
  assert.equal(done.status, "TAKE_PROFIT");
  assert.equal(pnlDollars(done), 100, "(1.5-1.0) x100 x2 contracts");
  assert.equal(pnlPct(done), 50);
  assert.match(done.exitReason, /take_profit: target hit/);
});

// ── Risk engine ──
const CFG = { ...defaultRiskConfig(), maxRiskPerTrade: 200, maxDailyLoss: 500, maxWeeklyLoss: 1500, maxOpenTrades: 3, maxExposurePerTicker: 400, allowAveragingDown: false, allowZeroDte: false };
const CTX = { openTrades: [], realizedTodayDollars: 0, realizedWeekDollars: 0 };
const PROP = { ticker: "SPY", optionType: "call", dte: 7, entryLimit: 1.2, contracts: 1, stopLossPct: 30 };

test("clean proposal passes", () => {
  assert.equal(checkRisk(PROP, CTX, CFG).allowed, true);
});

test("0DTE blocked by default, allowed when enabled", () => {
  const r = checkRisk({ ...PROP, dte: 0 }, CTX, CFG);
  assert.equal(r.allowed, false);
  assert.match(r.failures[0], /0DTE/);
  assert.equal(checkRisk({ ...PROP, dte: 0 }, CTX, { ...CFG, allowZeroDte: true }).allowed, true);
});

test("per-trade risk cap: risk = premium x stop fraction", () => {
  assert.equal(dollarsAtRisk(1.2, 1, 30), 36);
  assert.equal(dollarsAtRisk(1.2, 1, null), 120, "no stop = full premium at risk");
  const r = checkRisk({ ...PROP, entryLimit: 8, contracts: 1, stopLossPct: null }, CTX, CFG);
  assert.equal(r.allowed, false);
  assert.match(r.failures[0], /exceeds max/);
});

test("max open trades + per-ticker exposure + no averaging down", () => {
  const open = (over) => ({ ...trade(), status: "ENTERED", entryPrice: 1.2, lastMark: 1.0, ...over });
  const full = { ...CTX, openTrades: [open({}), open({ ticker: "TSLA" }), open({ ticker: "QQQ" })] };
  assert.match(checkRisk(PROP, full, CFG).failures.find((f) => /open trades/.test(f)), /max 3/);

  const exposure = { ...CTX, openTrades: [open({ entryPrice: 3.5, contracts: 1 })] };
  const rExp = checkRisk({ ...PROP, entryLimit: 1.0 }, exposure, CFG);
  assert.ok(rExp.failures.some((f) => /exposure/.test(f)), "350+100 > 400 cap");

  const losing = { ...CTX, openTrades: [open({})] }; // SPY call underwater (1.0 < 1.2)
  const rAvg = checkRisk(PROP, losing, CFG);
  assert.ok(rAvg.failures.some((f) => /averaging down/.test(f)));
});

test("daily and weekly loss circuit breakers", () => {
  assert.ok(checkRisk(PROP, { ...CTX, realizedTodayDollars: -500 }, CFG).failures.some((f) => /daily loss/.test(f)));
  assert.ok(checkRisk(PROP, { ...CTX, realizedWeekDollars: -1500 }, CFG).failures.some((f) => /weekly loss/.test(f)));
});

// ── Analytics ──
test("summarize: realized-only stats, drawdown, profit factor", () => {
  const closed = (entry, exit, at, over = {}) => ({
    ...trade(), status: "EXITED", entryPrice: entry, exitPrice: exit,
    entryAtMs: at, exitAtMs: at + 30 * 60_000, mfePct: 25, maePct: -10, ...over,
  });
  const trades = [
    closed(1.0, 1.5, T),            // +50
    closed(1.0, 0.7, T + 1_000_000), // -30
    closed(2.0, 2.4, T + 2_000_000), // +40
    { ...trade(), status: "ENTERED", entryPrice: 1.0, entryAtMs: T }, // open — excluded
    { ...trade(), status: "CANCELLED" }, // never filled — not graded
  ];
  const s = summarize(trades);
  assert.equal(s.gradedCount, 3);
  assert.equal(s.openCount, 1);
  assert.equal(s.wins, 2);
  assert.equal(s.winRatePct, 66.7);
  assert.equal(s.totalPnlDollars, 60);
  assert.equal(s.profitFactor, +(90 / 30).toFixed(2));
  assert.equal(s.expectancyDollars, 20);
  assert.equal(s.maxDrawdownDollars, 30);
  assert.equal(s.largestWinDollars, 50);
  assert.equal(s.largestLossDollars, -30);
  assert.equal(s.avgHoldMinutes, 30);
});

test("bucket cuts group correctly", () => {
  const mk = (confidence, dte, exit) => ({
    ...trade(), status: "EXITED", entryPrice: 1.0, exitPrice: exit,
    entryAtMs: T, exitAtMs: T + 60_000, confidence, dteAtEntry: dte,
  });
  const trades = [mk(92, 7, 1.2), mk(85, 7, 0.8), mk(85, 21, 1.4)];
  const conf = byConfidence(trades);
  assert.equal(conf.find((b) => b.bucket === "90+")?.count, 1);
  assert.equal(conf.find((b) => b.bucket === "80–89")?.count, 2);
  const exp = byExpirationLength(trades);
  assert.equal(exp.find((b) => b.bucket === "1–2 weeks")?.count, 2);
  assert.equal(exp.find((b) => b.bucket === "2–4 weeks")?.count, 1);
});

// ── Lessons ──
test("lessonsLearned flags giving back a big MFE on a loser", () => {
  const t = { ...trade(), status: "EXITED", entryPrice: 1.0, exitPrice: 0.8, mfePct: 35, maePct: -5 };
  assert.match(lessonsLearned(t), /gave it back/);
});

test("lessonsLearned praises capturing the move", () => {
  const t = { ...trade(), status: "TAKE_PROFIT", entryPrice: 1.0, exitPrice: 1.45, mfePct: 50, maePct: -4 };
  assert.match(lessonsLearned(t), /good management/);
});
