import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { realizedLastLossAtMs } from "../lib/research/cooldown.ts";
import { consumeRoutedCandidatesOnDb, enabledConsumerLanes, consumeRoutedCandidates } from "../lib/research/research-consumer.ts";
import { lanePortfolioSpec, portfolioForLane } from "../lib/research/lane-portfolio.ts";
import { sizePosition, paperSizingConfig } from "../lib/paper-position-sizer.ts";

// ── in-memory schema (only the columns these modules touch) ──────────────────
function db() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE setup_candidates (
      setup_id TEXT PRIMARY KEY, ticker TEXT, option_symbol TEXT, side TEXT, strike REAL, expiration TEXT, dte INTEGER,
      option_mid REAL, option_ask REAL, strategy_agent TEXT, setup_tier TEXT, direction TEXT, entry_thesis TEXT
    );
    CREATE TABLE lane_routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, setup_id TEXT, lane TEXT, routed INTEGER
    );
    CREATE TABLE paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, setup_id TEXT, portfolio TEXT, ticker TEXT,
      option_symbol TEXT, option_type TEXT, entry_price REAL, exit_price REAL, exit_at_ms INTEGER, contracts INTEGER
    );`);
  return d;
}

function addRouted(d, o) {
  const s = { tier: "PRODUCTION_QUALITY", side: "call", mid: 2.5, ask: 2.6, routed: 1, strategyAgent: "call_0DTE", ...o };
  d.prepare(`INSERT INTO setup_candidates (setup_id, ticker, option_symbol, side, strike, expiration, dte, option_mid, option_ask, strategy_agent, setup_tier, direction, entry_thesis)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(s.setupId, s.ticker, s.optionSymbol, s.side, 210, "2026-07-10", 0, s.mid, s.ask, s.strategyAgent, s.tier, "bullish", "thesis");
  d.prepare("INSERT INTO lane_routes (setup_id, lane, routed) VALUES (?,?,?)").run(s.setupId, s.lane, s.routed);
}

function recorder() {
  const calls = [];
  const fn = (input) => { calls.push(input); return { ok: true, id: calls.length }; };
  return { fn, calls };
}

// ── independent consumers ────────────────────────────────────────────────────
test("Challenge creates a trade with NO Primary trade required", () => {
  const d = db();
  addRouted(d, { setupId: "s1", ticker: "NVDA", optionSymbol: "O:NVDA260710C00210000", lane: "CHALLENGE_PAPER" });
  const rec = recorder();
  const s = consumeRoutedCandidatesOnDb(d, rec.fn, ["CHALLENGE_PAPER"], 1);
  assert.equal(s.created, 1);
  assert.equal(rec.calls[0].portfolio, "CHALLENGE");
  assert.equal(rec.calls.some((c) => c.portfolio === "PRIMARY"), false, "no Primary trade involved");
  assert.equal(d.prepare("SELECT COUNT(*) n FROM paper_trades WHERE portfolio='PRIMARY'").get().n, 0);
});

test("Research creates a trade with NO Primary trade required", () => {
  const d = db();
  addRouted(d, { setupId: "s1", ticker: "AMD", optionSymbol: "O:AMD260710C00150000", lane: "RESEARCH", tier: "EXPERIMENTAL_VALID" });
  const rec = recorder();
  const s = consumeRoutedCandidatesOnDb(d, rec.fn, ["RESEARCH"], 1);
  assert.equal(s.created, 1);
  assert.equal(rec.calls[0].portfolio, "RESEARCH");
});

test("Challenge and Research fill into SEPARATE portfolios", () => {
  assert.equal(portfolioForLane("CHALLENGE_PAPER"), "CHALLENGE");
  assert.equal(portfolioForLane("RESEARCH"), "RESEARCH");
  assert.notEqual(portfolioForLane("CHALLENGE_PAPER"), portfolioForLane("RESEARCH"));
  // Both isolate cooldown per ticker; Primary stays account-wide (stricter).
  assert.equal(lanePortfolioSpec("CHALLENGE_PAPER").cooldownScope, "ticker");
  assert.equal(lanePortfolioSpec("RESEARCH").cooldownScope, "ticker");
  assert.equal(lanePortfolioSpec("PRIMARY_PAPER").cooldownScope, "account");
});

test("REJECTED_INVALID is never filled, even if a route row says routed=1", () => {
  const d = db();
  addRouted(d, { setupId: "bad", ticker: "TSLA", optionSymbol: "O:TSLA260710C00250000", lane: "RESEARCH", tier: "REJECTED_INVALID" });
  const rec = recorder();
  const s = consumeRoutedCandidatesOnDb(d, rec.fn, ["RESEARCH"], 1);
  assert.equal(s.created, 0);
  assert.equal(rec.calls.length, 0, "createTrade must never be called for REJECTED_INVALID");
});

test("a candidate with no defensible quote is never filled (no fabrication)", () => {
  const d = db();
  addRouted(d, { setupId: "nq", ticker: "META", optionSymbol: "O:META260710C00500000", lane: "RESEARCH", tier: "NEAR_MISS_VALID", mid: null, ask: null });
  const rec = recorder();
  const s = consumeRoutedCandidatesOnDb(d, rec.fn, ["RESEARCH"], 1);
  assert.equal(s.created, 0);
  assert.equal(s.skippedNoQuote, 1);
  assert.equal(rec.calls.length, 0);
});

test("lane / strategy / tier / setup attribution passes into trade creation", () => {
  const d = db();
  addRouted(d, { setupId: "attr1", ticker: "NVDA", optionSymbol: "O:NVDA260710C00210000", lane: "RESEARCH", tier: "EXPERIMENTAL_VALID", strategyAgent: "put_research_0DTE" });
  const rec = recorder();
  consumeRoutedCandidatesOnDb(d, rec.fn, ["RESEARCH"], 1);
  const c = rec.calls[0];
  assert.equal(c.setupId, "attr1");
  assert.equal(c.strategyAgent, "put_research_0DTE");
  assert.equal(c.setupTier, "EXPERIMENTAL_VALID");
  assert.equal(c.lane, "RESEARCH");
});

test("consumer dedups per (setup, portfolio) — restart/retry safe", () => {
  const d = db();
  addRouted(d, { setupId: "dup1", ticker: "NVDA", optionSymbol: "O:NVDA260710C00210000", lane: "RESEARCH" });
  d.prepare("INSERT INTO paper_trades (setup_id, portfolio, ticker) VALUES (?,?,?)").run("dup1", "RESEARCH", "NVDA");
  const rec = recorder();
  const s = consumeRoutedCandidatesOnDb(d, rec.fn, ["RESEARCH"], 1);
  assert.equal(s.duplicates, 1);
  assert.equal(s.created, 0);
});

test("SAFETY: consumers are a hard no-op when both lane flags are OFF", () => {
  assert.deepEqual(enabledConsumerLanes({}), []);
  const res = consumeRoutedCandidates(1, {});
  assert.equal(res.evaluated, 0);
  assert.match(res.skippedReason, /no lane flag enabled/);
});

test("flags select exactly the enabled lanes", () => {
  assert.deepEqual(enabledConsumerLanes({ RESEARCH_LANE_ENABLED: "1" }), ["RESEARCH"]);
  assert.deepEqual(enabledConsumerLanes({ CHALLENGE_INDEPENDENT_ENABLED: "1" }), ["CHALLENGE_PAPER"]);
  assert.deepEqual(enabledConsumerLanes({ RESEARCH_LANE_ENABLED: "1", CHALLENGE_INDEPENDENT_ENABLED: "1" }), ["CHALLENGE_PAPER", "RESEARCH"]);
});

// ── cooldown isolation ───────────────────────────────────────────────────────
test("cooldown is isolated per lane AND per ticker", () => {
  const d = db();
  // A losing CHALLENGE trade on AAA (option: exit < entry).
  d.prepare(`INSERT INTO paper_trades (setup_id, portfolio, ticker, option_symbol, option_type, entry_price, exit_price, exit_at_ms, contracts)
             VALUES (?,?,?,?,?,?,?,?,?)`).run("l1", "CHALLENGE", "AAA", "O:AAA260710C1", "call", 2.0, 1.0, 5000, 1);

  assert.equal(realizedLastLossAtMs(d, "CHALLENGE", "AAA"), 5000, "same lane+ticker sees the loss");
  assert.equal(realizedLastLossAtMs(d, "CHALLENGE", "BBB"), null, "one ticker's loss does not freeze another ticker");
  assert.equal(realizedLastLossAtMs(d, "RESEARCH", "AAA"), null, "a Challenge loss does not freeze Research");
  assert.equal(realizedLastLossAtMs(d, "RESEARCH"), null, "a Challenge loss does not freeze Research (account-wide)");
  assert.equal(realizedLastLossAtMs(d, "PRIMARY"), null, "a Challenge loss does not freeze Primary");
  assert.equal(realizedLastLossAtMs(d, "CHALLENGE"), 5000, "account-wide within the same lane still sees it");
});

// ── Primary min-1 sizing fix ─────────────────────────────────────────────────
test("Primary accepts ONE contract when exactly one fits every hard cap", () => {
  // aggressive profile (min was 2, now 1). Position cap: 20% of 5000 = $1000; a $2.50
  // premium = $250/contract → 4 fit by position; risk 2% × 5000 = $100, 30% stop →
  // risk/contract $75 → 1 fits by risk. Binding: per-trade risk → exactly 1 contract.
  const cfg = paperSizingConfig({ PAPER_RISK_PROFILE: "aggressive" });
  const r = sizePosition({
    equityDollars: 5000, entryPrice: 2.5, multiplier: 100, stopLossPct: 30,
    openExposureDollars: 0, openTickerExposureDollars: 0, availableBuyingPowerDollars: 5000,
    realizedDailyLossDollars: 0, isZeroDte: false,
  }, cfg);
  assert.equal(r.rejected, false);
  assert.equal(r.contracts, 1, "one honest contract is allowed (no accidental 2-contract floor)");
});

test("Primary still REJECTS when not even one contract fits a hard cap", () => {
  const cfg = paperSizingConfig({ PAPER_RISK_PROFILE: "aggressive" });
  const r = sizePosition({
    equityDollars: 5000, entryPrice: 50, multiplier: 100, stopLossPct: 1, // $5000/contract vs $1000 position cap → 0
    openExposureDollars: 0, openTickerExposureDollars: 0, availableBuyingPowerDollars: 5000,
    realizedDailyLossDollars: 0, isZeroDte: false,
  }, cfg);
  assert.equal(r.rejected, true);
  assert.match(r.reason, /minimum 1 contract/);
});
