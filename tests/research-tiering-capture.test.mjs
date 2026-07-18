import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { classifySetupTier } from "../lib/research/tiering.ts";
import { agentResultToSetupCandidate } from "../lib/research/adapter.ts";
import { captureSetupCandidateOnDb, captureSetupCandidates } from "../lib/research/capture.ts";

// ── helpers ──────────────────────────────────────────────────────────────────
const freshOptionContract = { optionSymbol: "O:NVDA260710C00210000", strike: 210, expiration: "2026-07-10", dte: 0, side: "call", bid: 2.4, ask: 2.5, mid: 2.45, spreadPct: 4, delta: 0.5, iv: 0.55, volume: 1200, openInterest: 900, breakevenPct: 1.2 };

function tieringBase(over = {}) {
  return {
    assetClass: "option", candidateStatus: "ACTIONABLE_NOW", actionability: "ACTIONABLE",
    freshnessOk: true, freshnessReason: null, riskAllowed: true, riskVetoed: false, riskFailures: [],
    contract: freshOptionContract, price: null, ...over,
  };
}

// ── tiering ──────────────────────────────────────────────────────────────────
test("tiering: fresh + actionable + valid contract → PRODUCTION_QUALITY", () => {
  assert.equal(classifySetupTier(tieringBase()).tier, "PRODUCTION_QUALITY");
});

test("tiering: stale data → REJECTED_INVALID (never fillable)", () => {
  const out = classifySetupTier(tieringBase({ freshnessOk: false, freshnessReason: "MARKET_CLOSED" }));
  assert.equal(out.tier, "REJECTED_INVALID");
  assert.equal(out.gateResults.freshness.passed, false);
});

test("tiering: no valid contract → REJECTED_INVALID", () => {
  assert.equal(classifySetupTier(tieringBase({ contract: null })).tier, "REJECTED_INVALID");
});

test("tiering: crossed/one-sided quote → REJECTED_INVALID", () => {
  const bad = { ...freshOptionContract, bid: 3.0, ask: 2.0 };
  assert.equal(classifySetupTier(tieringBase({ contract: bad })).tier, "REJECTED_INVALID");
});

test("tiering: hard safety veto → REJECTED_INVALID", () => {
  assert.equal(classifySetupTier(tieringBase({ riskVetoed: true, riskAllowed: false, riskFailures: ["kill switch"] })).tier, "REJECTED_INVALID");
});

test("tiering: research-only put (fresh, valid) → EXPERIMENTAL_VALID", () => {
  const out = classifySetupTier(tieringBase({ actionability: "RESEARCH_ONLY", candidateStatus: "RESEARCH_ONLY", contract: { ...freshOptionContract, side: "put" } }));
  assert.equal(out.tier, "EXPERIMENTAL_VALID");
});

test("tiering: WAIT_FOR_PULLBACK (fresh, valid) → NEAR_MISS_VALID", () => {
  assert.equal(classifySetupTier(tieringBase({ actionability: "WATCH", candidateStatus: "WAIT_FOR_PULLBACK" })).tier, "NEAR_MISS_VALID");
});

test("tiering: stock with a price is a valid contract identity", () => {
  const out = classifySetupTier({ assetClass: "stock", candidateStatus: "ACTIONABLE_NOW", actionability: "ACTIONABLE", freshnessOk: true, freshnessReason: null, riskAllowed: true, riskVetoed: false, riskFailures: [], contract: null, price: 12.5 });
  assert.equal(out.tier, "PRODUCTION_QUALITY");
});

// ── adapter ──────────────────────────────────────────────────────────────────
function agentResult(over = {}) {
  return {
    agentId: "call_0DTE", agentVersion: 1, strategy: "zero_dte_momentum", strategyVersion: 3,
    ticker: "nvda", direction: "bullish", horizon: "0DTE", dteRange: [0, 1],
    candidateStatus: "ACTIONABLE_NOW", lifecycleStatus: null, score: 88, verifiedInputs: { a: 1 },
    requiredConditions: [], selectorProfile: "zero_dte_momentum", selectedContract: freshOptionContract,
    passedGates: [], failedGates: [], evidenceStatus: "OK", statisticsSnapshot: null, modelStatus: "INACTIVE",
    probability: null, actionability: "ACTIONABLE", researchOnly: false, reasons: ["fast up move"],
    improvementConditions: [], invalidationConditions: ["loses VWAP"], freshness: { ok: true, reason: null },
    marketContext: { regime: "trend" }, riskVerdict: { allowed: true, failures: [], vetoed: false }, timestamp: 1_700_000_000_000,
    ...over,
  };
}

test("adapter: maps AgentResult → SetupCandidate with tier + attribution", () => {
  const c = agentResultToSetupCandidate(agentResult(), { tradingDay: "2026-07-10", session: "regular" });
  assert.equal(c.setupTier, "PRODUCTION_QUALITY");
  assert.equal(c.setupId, "call_0DTE|NVDA|O:NVDA260710C00210000|2026-07-10");
  assert.equal(c.strategyAgent, "call_0DTE");
  assert.equal(c.assetClass, "option");
  assert.equal(c.greeks.available, true);
  assert.equal(c.greeks.delta, 0.5);
  assert.equal(c.greeks.gamma, null, "gamma is not available at this layer — not fabricated");
  assert.equal(c.consumerLanes.length, 0, "router assigns lanes later");
  assert.equal(c.entryThesis, "fast up move");
});

// ── capture (real in-memory sqlite) ─────────────────────────────────────────
function memDb() {
  const db = new Database(":memory:");
  const ddl = `
    CREATE TABLE IF NOT EXISTS setup_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, setup_id TEXT NOT NULL UNIQUE, trading_day TEXT NOT NULL,
      strategy_agent TEXT NOT NULL, strategy_family TEXT, strategy_version INTEGER, agent_version INTEGER,
      ticker TEXT NOT NULL, direction TEXT, asset_class TEXT, option_symbol TEXT, expiration TEXT, strike REAL,
      side TEXT, horizon TEXT, session TEXT, setup_tier TEXT NOT NULL, confidence REAL, candidate_status TEXT,
      actionability TEXT, freshness_state TEXT, liquidity REAL, spread_pct REAL, volume REAL, open_interest REAL,
      option_bid REAL, option_ask REAL, option_mid REAL,
      greeks_json TEXT, entry_thesis TEXT, invalidation_thesis TEXT, gate_results_json TEXT,
      rejection_reasons_json TEXT, feature_snapshot_json TEXT, market_regime_json TEXT, consumer_lanes_json TEXT,
      experiment_id TEXT, model_version INTEGER, outcome_json TEXT, originating_ts_ms INTEGER NOT NULL, created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS setup_gate_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT, setup_id TEXT NOT NULL, gate_name TEXT NOT NULL, passed INTEGER NOT NULL,
      score REAL, reason TEXT, created_at_ms INTEGER NOT NULL
    );`;
  db.exec(ddl); db.exec(ddl); // run twice → proves CREATE TABLE IF NOT EXISTS is repeat-safe
  return db;
}

test("capture: inserts a candidate + its gate rows; re-capture is idempotent", () => {
  const db = memDb();
  const c = agentResultToSetupCandidate(agentResult(), { tradingDay: "2026-07-10", session: "regular" });
  assert.equal(captureSetupCandidateOnDb(db, c, 1), true, "first capture inserts");
  assert.equal(captureSetupCandidateOnDb(db, c, 2), false, "duplicate setup_id ignored");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM setup_candidates").get().n, 1);
  const gates = db.prepare("SELECT COUNT(*) n FROM setup_gate_results").get().n;
  assert.ok(gates >= 4, "gate rows persisted once");
  const row = db.prepare("SELECT setup_tier, trading_day FROM setup_candidates WHERE setup_id=?").get(c.setupId);
  assert.equal(row.setup_tier, "PRODUCTION_QUALITY");
  assert.equal(row.trading_day, "2026-07-10");
});

test("SAFETY: live capture is a hard no-op when the flag is off", () => {
  const c = agentResultToSetupCandidate(agentResult(), { tradingDay: "2026-07-10", session: "regular" });
  const res = captureSetupCandidates([c], 1, {}); // no flag → must not even touch the DB
  assert.equal(res.captured, 0);
  assert.equal(res.skippedReason, "SETUP_CANDIDATE_CAPTURE_ENABLED!=1");
});
