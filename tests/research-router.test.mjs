import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { agentResultToSetupCandidate } from "../lib/research/adapter.ts";
import { primaryDecision, challengeDecision, researchDecision, evaluateExecutableLanes, EXECUTABLE_LANES } from "../lib/research/lane-policy.ts";
import { routeCandidatesOnDb, routeAgentResults } from "../lib/research/router.ts";

const contract = { optionSymbol: "O:NVDA260710C00210000", strike: 210, expiration: "2026-07-10", dte: 0, side: "call", bid: 2.4, ask: 2.5, mid: 2.45, spreadPct: 4, delta: 0.5, iv: 0.55, volume: 1200, openInterest: 900, breakevenPct: 1.2 };

function agentResult(over = {}) {
  return {
    agentId: "call_0DTE", agentVersion: 1, strategy: "zero_dte_momentum", strategyVersion: 3,
    ticker: "nvda", direction: "bullish", horizon: "0DTE", dteRange: [0, 1],
    candidateStatus: "ACTIONABLE_NOW", lifecycleStatus: null, score: 88, verifiedInputs: {},
    requiredConditions: [], selectorProfile: "zero_dte_momentum", selectedContract: contract,
    passedGates: [], failedGates: [], evidenceStatus: "OK", statisticsSnapshot: null, modelStatus: "INACTIVE",
    probability: null, actionability: "ACTIONABLE", researchOnly: false, reasons: ["fast up move"],
    improvementConditions: [], invalidationConditions: ["loses VWAP"], freshness: { ok: true, reason: null },
    marketContext: null, riskVerdict: { allowed: true, failures: [], vetoed: false }, timestamp: 1_700_000_000_000,
    ...over,
  };
}
const toCand = (over, td = "2026-07-10") => agentResultToSetupCandidate(agentResult(over), { tradingDay: td, session: "regular" });

// Distinct tickers/contracts so each fixture has a distinct setupId (as real,
// independent setups do).
const production = () => toCand({});
const experimental = () => toCand({ ticker: "amd", actionability: "RESEARCH_ONLY", candidateStatus: "RESEARCH_ONLY", direction: "bearish", selectedContract: { ...contract, optionSymbol: "O:AMD260710P00150000", side: "put" } });
const nearMiss = () => toCand({ ticker: "aapl", actionability: "WATCH", candidateStatus: "WAIT_FOR_PULLBACK", selectedContract: { ...contract, optionSymbol: "O:AAPL260710C00230000" } });
const rejected = () => toCand({ ticker: "tsla", freshness: { ok: false, reason: "MARKET_CLOSED" }, selectedContract: { ...contract, optionSymbol: "O:TSLA260710C00250000" } });

// ── lane policy ──────────────────────────────────────────────────────────────
test("PRODUCTION_QUALITY routes to Primary, Challenge, and Research", () => {
  const c = production();
  assert.equal(primaryDecision(c).routed, true);
  assert.equal(challengeDecision(c).routed, true);
  assert.equal(researchDecision(c).routed, true);
});

test("EXPERIMENTAL_VALID cannot enter Primary; may enter Challenge + Research", () => {
  const c = experimental();
  assert.equal(c.setupTier, "EXPERIMENTAL_VALID");
  assert.equal(primaryDecision(c).routed, false);
  assert.equal(primaryDecision(c).reasonCode, "NOT_PRODUCTION_QUALITY");
  assert.equal(challengeDecision(c).routed, true);
  assert.equal(researchDecision(c).routed, true);
});

test("NEAR_MISS_VALID: research only, never Primary/Challenge", () => {
  const c = nearMiss();
  assert.equal(c.setupTier, "NEAR_MISS_VALID");
  assert.equal(primaryDecision(c).routed, false);
  assert.equal(challengeDecision(c).routed, false);
  assert.equal(researchDecision(c).routed, true);
});

test("REJECTED_INVALID never routes to ANY executable/fill lane", () => {
  const c = rejected();
  assert.equal(c.setupTier, "REJECTED_INVALID");
  for (const d of evaluateExecutableLanes(c)) {
    assert.equal(d.routed, false, `${d.lane} must not accept REJECTED_INVALID`);
    assert.equal(d.reasonCode, "REJECTED_INVALID");
  }
});

test("NEAR_MISS with no defensible quote is NOT simulated (defensive)", () => {
  const c = nearMiss();
  c.gateResults.freshness = { passed: false, score: null, reason: "stale" };
  const d = researchDecision(c);
  assert.equal(d.routed, false);
  assert.equal(d.reasonCode, "NO_DEFENSIBLE_QUOTE");
});

test("the router never decides Production Discord (Discord is not a router lane)", () => {
  assert.equal(EXECUTABLE_LANES.includes("PRODUCTION_DISCORD"), false);
  for (const d of evaluateExecutableLanes(production())) {
    assert.notEqual(d.lane, "PRODUCTION_DISCORD");
  }
});

// ── router persistence (real in-memory sqlite) ───────────────────────────────
function memDb() {
  const db = new Database(":memory:");
  const ddl = `
    CREATE TABLE IF NOT EXISTS setup_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, setup_id TEXT NOT NULL UNIQUE, trading_day TEXT NOT NULL,
      strategy_agent TEXT NOT NULL, strategy_family TEXT, strategy_version INTEGER, agent_version INTEGER,
      ticker TEXT NOT NULL, direction TEXT, asset_class TEXT, option_symbol TEXT, expiration TEXT, strike REAL,
      side TEXT, horizon TEXT, session TEXT, setup_tier TEXT NOT NULL, confidence REAL, candidate_status TEXT,
      actionability TEXT, freshness_state TEXT, liquidity REAL, spread_pct REAL, volume REAL, open_interest REAL,
      greeks_json TEXT, entry_thesis TEXT, invalidation_thesis TEXT, gate_results_json TEXT,
      rejection_reasons_json TEXT, feature_snapshot_json TEXT, market_regime_json TEXT, consumer_lanes_json TEXT,
      experiment_id TEXT, model_version INTEGER, outcome_json TEXT, originating_ts_ms INTEGER NOT NULL, created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS setup_gate_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT, setup_id TEXT NOT NULL, gate_name TEXT NOT NULL, passed INTEGER NOT NULL,
      score REAL, reason TEXT, created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lane_routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, setup_id TEXT NOT NULL, lane TEXT NOT NULL, routed INTEGER NOT NULL,
      reason_code TEXT NOT NULL, reason TEXT, setup_tier TEXT, created_at_ms INTEGER NOT NULL, UNIQUE(setup_id, lane)
    );`;
  db.exec(ddl); db.exec(ddl); // repeat-safe
  return db;
}

test("router persists candidates + explicit per-lane routes; idempotent", () => {
  const db = memDb();
  const cands = [production(), experimental(), nearMiss(), rejected()];
  const s1 = routeCandidatesOnDb(db, cands, 1);
  assert.equal(s1.evaluated, 4);
  assert.equal(s1.captured, 4);
  assert.equal(s1.routesWritten, 12, "4 candidates × 3 executable lanes");
  assert.equal(s1.routedByLane.RESEARCH, 3, "production+experimental+nearmiss route to research");
  assert.equal(s1.routedByLane.PRIMARY_PAPER ?? 0, 1, "only production reaches Primary");
  assert.equal(s1.routedByLane.CHALLENGE_PAPER ?? 0, 2, "production+experimental reach Challenge");

  // No Discord lane is ever persisted.
  assert.equal(db.prepare("SELECT COUNT(*) n FROM lane_routes WHERE lane='PRODUCTION_DISCORD'").get().n, 0);
  // rejected-invalid: routed=0 on every lane.
  const rej = rejected().setupId;
  assert.equal(db.prepare("SELECT COUNT(*) n FROM lane_routes WHERE setup_id=? AND routed=1").get(rej).n, 0);

  // Idempotent re-route: no new rows.
  const s2 = routeCandidatesOnDb(db, cands, 2);
  assert.equal(s2.routesWritten, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM lane_routes").get().n, 12);
});

test("SAFETY: routeAgentResults is a hard no-op when LANE_ROUTER_ENABLED!=1", () => {
  const res = routeAgentResults([agentResult()], 1, {}); // no flag → must not touch the DB at all
  assert.equal(res.evaluated, 0);
  assert.equal(res.routesWritten, 0);
  assert.equal(res.skippedReason, "LANE_ROUTER_ENABLED!=1");
});

test("router writes NO trade and NO discord — only diagnostics tables exist", () => {
  const db = memDb();
  routeCandidatesOnDb(db, [production()], 1);
  // The only tables the router touches are the two diagnostics tables + lane_routes.
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name).sort();
  assert.deepEqual(tables, ["lane_routes", "setup_candidates", "setup_gate_results"]);
});
