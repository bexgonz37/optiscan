import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  createExperimentOnDb, setExperimentStatusOnDb, enrollCandidateOnDb, enrollmentEligibility,
  experimentSummaryOnDb, enrollRoutedCandidates, effectiveStatus,
} from "../lib/research/experiment-ledger.ts";
import {
  recordExecutableCounterfactualOnDb, recordMarketObservationOnDb, knownOutcomeOnDb,
  gateEffectivenessOnDb, strategyAnalyticsOnDb,
} from "../lib/research/counterfactual.ts";

function db() {
  const d = new Database(":memory:");
  const ddl = `
    CREATE TABLE IF NOT EXISTS research_experiments (
      id TEXT NOT NULL, version INTEGER NOT NULL, hypothesis TEXT, status TEXT NOT NULL, config_json TEXT,
      strategy_agents_json TEXT, min_sample_target INTEGER NOT NULL DEFAULT 0, missing_requirements_json TEXT,
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, PRIMARY KEY (id, version));
    CREATE TABLE IF NOT EXISTS research_enrollments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, experiment_id TEXT NOT NULL, experiment_version INTEGER NOT NULL, setup_id TEXT NOT NULL,
      lane TEXT, portfolio TEXT, strategy_agent TEXT, strategy_version INTEGER, strategy_family TEXT,
      setup_tier TEXT, ticker TEXT, asset_class TEXT, direction TEXT, horizon TEXT,
      option_symbol TEXT, expiration TEXT, strike REAL, call_put TEXT, market_session TEXT, regime TEXT,
      fill_status TEXT NOT NULL, non_fill_reason TEXT, paper_trade_id INTEGER,
      entry_quote_source TEXT, quote_ts_ms INTEGER, data_quality TEXT,
      gate_results_json TEXT, feature_snapshot_json TEXT, provider_limitations TEXT, created_at_ms INTEGER NOT NULL,
      UNIQUE(experiment_id, experiment_version, setup_id));
    CREATE TABLE IF NOT EXISTS counterfactual_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, setup_id TEXT NOT NULL, kind TEXT NOT NULL, setup_tier TEXT, strategy_agent TEXT,
      lane TEXT, ticker TEXT, horizon TEXT, session TEXT, regime TEXT, entry_price REAL, exit_price REAL, return_pct REAL,
      win INTEGER, reached_target INTEGER, underlying_move_pct REAL, contract_move_pct REAL, observation_note TEXT,
      defensible_entry INTEGER NOT NULL, gate_results_json TEXT, created_at_ms INTEGER NOT NULL, UNIQUE(setup_id, kind));
    CREATE TABLE IF NOT EXISTS paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, setup_id TEXT, status TEXT, entry_price REAL, exit_price REAL,
      option_symbol TEXT, option_type TEXT, strategy_agent TEXT, lane TEXT, mfe_pct REAL, mae_pct REAL);
    CREATE TABLE IF NOT EXISTS setup_gate_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT, setup_id TEXT, gate_name TEXT, passed INTEGER);`;
  d.exec(ddl); d.exec(ddl); // repeat-safe
  return d;
}

const cfg = { acceptedTiers: ["PRODUCTION_QUALITY", "EXPERIMENTAL_VALID", "NEAR_MISS_VALID", "REJECTED_INVALID"], acceptedLanes: ["RESEARCH", "CHALLENGE_PAPER"], symbols: null, horizons: null, sessions: null, researchMaxSpreadPct: 15 };
const experiment = { id: "exp1", version: 1, status: "ACTIVE", config: cfg };
function def(over = {}) {
  return { id: "exp1", version: 1, hypothesis: "h", status: "ACTIVE", config: cfg, strategyAgents: ["call_0DTE"], minSampleTarget: 30, missingRequirements: [], ...over };
}
function enrollInput(over = {}) {
  return {
    setupId: "s1", setupTier: "PRODUCTION_QUALITY", lane: "RESEARCH", portfolio: "RESEARCH",
    strategyAgent: "call_0DTE", strategyVersion: 3, strategyFamily: "0dte", ticker: "NVDA", assetClass: "option",
    direction: "bullish", horizon: "0DTE", optionSymbol: "O:NVDA260710C00210000", expiration: "2026-07-10", strike: 210,
    callPut: "call", session: "regular", regime: null, optionMid: 2.5, optionAsk: 2.6, freshnessOk: true, spreadPct: 4,
    quoteTsMs: 1000, dataQuality: "fresh", gateResults: { freshness: { passed: true } }, featureSnapshot: null, providerLimitations: null,
    ...over,
  };
}
function fillRec() {
  const calls = [];
  const fn = (i) => { calls.push(i); return { ok: true, id: calls.length }; };
  return { fn, calls };
}

// ── experiment lifecycle ─────────────────────────────────────────────────────
test("experiment creation is versioned and idempotent", () => {
  const d = db();
  assert.equal(createExperimentOnDb(d, def(), 1).created, true);
  assert.equal(createExperimentOnDb(d, def(), 2).created, false, "same id+version is idempotent");
  assert.equal(createExperimentOnDb(d, def({ version: 2 }), 3).created, true, "a new version is a new row");
});

test("missing requirements force INACTIVE_MISSING_DATA", () => {
  assert.equal(effectiveStatus({ status: "ACTIVE", missingRequirements: ["earnings_feed"] }), "INACTIVE_MISSING_DATA");
  assert.equal(effectiveStatus({ status: "ACTIVE", missingRequirements: [] }), "ACTIVE");
});

test("a non-ACTIVE experiment enrolls nothing", () => {
  const d = db();
  const rec = fillRec();
  const res = enrollCandidateOnDb(d, { ...experiment, status: "PAUSED" }, enrollInput(), rec.fn, 1);
  assert.equal(res.enrolled, false);
  assert.equal(rec.calls.length, 0);
});

// ── enrollment rules ─────────────────────────────────────────────────────────
test("enrollment preserves full attribution and fill provenance", () => {
  const d = db();
  const rec = fillRec();
  const res = enrollCandidateOnDb(d, experiment, enrollInput(), rec.fn, 1);
  assert.equal(res.enrolled, true);
  assert.equal(res.fillStatus, "FILLED");
  const row = d.prepare("SELECT * FROM research_enrollments WHERE setup_id='s1'").get();
  assert.equal(row.strategy_agent, "call_0DTE");
  assert.equal(row.strategy_version, 3);
  assert.equal(row.lane, "RESEARCH");
  assert.equal(row.setup_tier, "PRODUCTION_QUALITY");
  assert.equal(row.entry_quote_source, "captured_two_sided_quote");
  assert.equal(row.paper_trade_id, 1);
});

test("the same candidate is not enrolled twice (idempotent / restart-safe)", () => {
  const d = db();
  const rec = fillRec();
  enrollCandidateOnDb(d, experiment, enrollInput(), rec.fn, 1);
  const again = enrollCandidateOnDb(d, experiment, enrollInput(), rec.fn, 2);
  assert.equal(again.enrolled, false);
  assert.match(again.reason, /already enrolled/);
  assert.equal(rec.calls.length, 1, "no duplicate fill on retry");
  assert.equal(d.prepare("SELECT COUNT(*) n FROM research_enrollments").get().n, 1);
});

test("experiment policy: an out-of-scope lane/tier is not eligible", () => {
  const only = { ...cfg, acceptedLanes: ["RESEARCH"] };
  assert.equal(enrollmentEligibility(only, { setupTier: "PRODUCTION_QUALITY", lane: "PRIMARY_PAPER", ticker: "NVDA", horizon: "0DTE", session: "regular" }).ok, false);
  assert.equal(enrollmentEligibility(only, { setupTier: "PRODUCTION_QUALITY", lane: "RESEARCH", ticker: "NVDA", horizon: "0DTE", session: "regular" }).ok, true);
});

test("NEAR_MISS_VALID fills WITH a defensible quote, else OBSERVED_UNFILLED", () => {
  const d = db();
  const rec = fillRec();
  const ok = enrollCandidateOnDb(d, experiment, enrollInput({ setupId: "nm1", setupTier: "NEAR_MISS_VALID" }), rec.fn, 1);
  assert.equal(ok.fillStatus, "FILLED");
  const noq = enrollCandidateOnDb(d, experiment, enrollInput({ setupId: "nm2", setupTier: "NEAR_MISS_VALID", optionMid: null, optionAsk: null }), rec.fn, 1);
  assert.equal(noq.fillStatus, "OBSERVED_UNFILLED");
});

test("stale options never fill (OBSERVED_UNFILLED, fill fn never called)", () => {
  const d = db();
  const rec = fillRec();
  const res = enrollCandidateOnDb(d, experiment, enrollInput({ setupId: "st1", freshnessOk: false }), rec.fn, 1);
  assert.equal(res.fillStatus, "OBSERVED_UNFILLED");
  assert.match(d.prepare("SELECT non_fill_reason r FROM research_enrollments WHERE setup_id='st1'").get().r, /stale|no defensible/);
  assert.equal(rec.calls.length, 0, "no fabricated fill for stale data");
});

test("REJECTED_INVALID never fills and creates no executed P&L", () => {
  const d = db();
  const rec = fillRec();
  const res = enrollCandidateOnDb(d, experiment, enrollInput({ setupId: "rej1", setupTier: "REJECTED_INVALID" }), rec.fn, 1);
  assert.equal(res.fillStatus, "NOT_FILLABLE_REJECTED");
  assert.equal(res.paperTradeId ?? null, null);
  assert.equal(rec.calls.length, 0);
});

test("experiment summary tallies fill statuses", () => {
  const d = db();
  const rec = fillRec();
  createExperimentOnDb(d, def(), 1);
  enrollCandidateOnDb(d, experiment, enrollInput({ setupId: "a" }), rec.fn, 1);
  enrollCandidateOnDb(d, experiment, enrollInput({ setupId: "b", freshnessOk: false }), rec.fn, 1);
  enrollCandidateOnDb(d, experiment, enrollInput({ setupId: "c", setupTier: "REJECTED_INVALID" }), rec.fn, 1);
  const s = experimentSummaryOnDb(d, "exp1", 1);
  assert.deepEqual(s, { enrolled: 3, filled: 1, observedUnfilled: 1, rejectedNotFilled: 1 });
});

test("SAFETY: live enrollment is a hard no-op when RESEARCH_LANE_ENABLED is off", () => {
  const res = enrollRoutedCandidates("exp1", 1, {});
  assert.equal(res.ran, false);
  assert.match(res.skippedReason, /RESEARCH_LANE_ENABLED/);
});

// ── counterfactual honesty ───────────────────────────────────────────────────
test("executable counterfactual REQUIRES a defensible entry", () => {
  const d = db();
  assert.throws(() => recordExecutableCounterfactualOnDb(d, { setupId: "x", entryPrice: 0, exitPrice: 3, reachedTarget: true }), /defensible/);
  assert.equal(recordExecutableCounterfactualOnDb(d, { setupId: "x", entryPrice: 2, exitPrice: 3, reachedTarget: true }).recorded, true);
});

test("market observation is NOT trade P&L (win stays null); distinct from executed outcome", () => {
  const d = db();
  recordMarketObservationOnDb(d, { setupId: "obs1", underlyingMovePct: 5, reachedTarget: true, note: "underlying ran +5%" });
  const row = d.prepare("SELECT win, defensible_entry, reached_target FROM counterfactual_outcomes WHERE setup_id='obs1'").get();
  assert.equal(row.win, null, "observation has no P&L win/loss");
  assert.equal(row.defensible_entry, 0);
  assert.equal(row.reached_target, 1, "reaching a price level is a market fact");
  const o = knownOutcomeOnDb(d, "obs1");
  assert.equal(o.source, "market_observation");
  assert.equal(o.win, null);
  assert.equal(o.reachedTarget, true);
});

test("knownOutcome prefers a real paper fill over a counterfactual", () => {
  const d = db();
  d.prepare("INSERT INTO paper_trades (setup_id, status, entry_price, exit_price, option_symbol, option_type) VALUES ('p1','EXITED',2.0,3.0,'O:X','call')").run();
  recordMarketObservationOnDb(d, { setupId: "p1", reachedTarget: false });
  const o = knownOutcomeOnDb(d, "p1");
  assert.equal(o.source, "paper_fill");
  assert.equal(o.win, true);
});

// ── gate effectiveness ───────────────────────────────────────────────────────
test("gate effectiveness: winners-rejected vs losers-blocked are distinct and correct", () => {
  const d = db();
  // freshness gate FAILED on 3 setups: one later reached target (winner rejected), two did not (correct blocks).
  const fail = (sid) => d.prepare("INSERT INTO setup_gate_results (setup_id, gate_name, passed) VALUES (?, 'freshness', 0)").run(sid);
  fail("w"); fail("l1"); fail("l2");
  recordMarketObservationOnDb(d, { setupId: "w", reachedTarget: true });
  recordMarketObservationOnDb(d, { setupId: "l1", reachedTarget: false });
  recordMarketObservationOnDb(d, { setupId: "l2", reachedTarget: false });
  const [g] = gateEffectivenessOnDb(d, { minSample: 2 });
  assert.equal(g.gate, "freshness");
  assert.equal(g.rejected, 3);
  assert.equal(g.rejectedWithKnownOutcome, 3);
  assert.equal(g.eventualWinnersRejected, 1);
  assert.equal(g.eventualLosersBlocked, 2);
  assert.equal(g.falseNegativeRatePct, 33.3);
  assert.equal(g.correctBlockRatePct, 66.7);
  assert.equal(g.insufficientSample, false);
});

test("gate effectiveness: unknown-outcome rejections are skipped, small samples flagged, no crash", () => {
  const d = db();
  d.prepare("INSERT INTO setup_gate_results (setup_id, gate_name, passed) VALUES ('u','spread',0)").run(); // no outcome recorded
  const [g] = gateEffectivenessOnDb(d, { minSample: 20 });
  assert.equal(g.rejectedWithKnownOutcome, 0);
  assert.equal(g.falseNegativeRatePct, null);
  assert.equal(g.insufficientSample, true, "0 known outcomes → flagged insufficient, not ranked");
});

// ── strategy analytics ───────────────────────────────────────────────────────
test("strategy analytics preserve version attribution and flag small samples", () => {
  const d = db();
  const rec = fillRec();
  // enroll + a couple graded fills for call_0DTE v3
  enrollCandidateOnDb(d, experiment, enrollInput({ setupId: "e1" }), rec.fn, 1);
  d.prepare("INSERT INTO paper_trades (setup_id, status, entry_price, exit_price, option_symbol, option_type, strategy_agent) VALUES ('e1','EXITED',2.0,3.0,'O:X','call','call_0DTE')").run();
  d.prepare("INSERT INTO paper_trades (setup_id, status, entry_price, exit_price, option_symbol, option_type, strategy_agent) VALUES ('e2','EXITED',2.0,1.0,'O:Y','call','call_0DTE')").run();
  const rows = strategyAnalyticsOnDb(d, { minSample: 20 });
  const r = rows.find((x) => x.strategyAgent === "call_0DTE");
  assert.equal(r.strategyVersion, 3, "version attribution preserved");
  assert.equal(r.graded, 2);
  assert.equal(r.wins, 1);
  assert.equal(r.losses, 1);
  assert.equal(r.winRatePct, 50);
  assert.equal(r.insufficientSample, true, "2 < 20 samples is flagged");
});
