import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { agentResultToSetupCandidate } from "../lib/research/adapter.ts";
import { captureSetupCandidateOnDb, captureSetupCandidates } from "../lib/research/capture.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

// Mirrors the exact composition wired into callouts/runtime.ts: adapt the canonical
// agent verdicts, then run the flag-gated capture wrapper — WITHOUT the router.
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
function memDb() {
  const d = new Database(":memory:");
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
      experiment_id TEXT, model_version INTEGER, outcome_json TEXT, originating_ts_ms INTEGER NOT NULL, created_at_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS setup_gate_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT, setup_id TEXT NOT NULL, gate_name TEXT NOT NULL, passed INTEGER NOT NULL,
      score REAL, reason TEXT, created_at_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS lane_routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, setup_id TEXT NOT NULL, lane TEXT NOT NULL, routed INTEGER NOT NULL,
      reason_code TEXT NOT NULL, reason TEXT, setup_tier TEXT, created_at_ms INTEGER NOT NULL, UNIQUE(setup_id, lane));`;
  d.exec(ddl); d.exec(ddl);
  return d;
}
const adapt = (results) => results.map((r) => agentResultToSetupCandidate(r, { tradingDay: "2026-07-10", session: "regular" }));

test("1. capture flag OFF is a hard no-op (no DB touched, never throws)", () => {
  const res = captureSetupCandidates(adapt([agentResult()]), 1, {}); // no flag
  assert.equal(res.captured, 0);
  assert.match(res.skippedReason, /SETUP_CANDIDATE_CAPTURE_ENABLED/);
});

test("2. capture (flag-ON path) writes setup_candidates AND setup_gate_results", () => {
  const d = memDb();
  const [c] = adapt([agentResult()]);
  assert.equal(captureSetupCandidateOnDb(d, c, 1), true);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM setup_candidates").get().n, 1);
  assert.ok(d.prepare("SELECT COUNT(*) n FROM setup_gate_results").get().n >= 4, "gate rows written");
  const row = d.prepare("SELECT strategy_agent, setup_tier, ticker FROM setup_candidates WHERE setup_id=?").get(c.setupId);
  assert.equal(row.strategy_agent, "call_0DTE");
  assert.equal(row.ticker, "NVDA");
  assert.ok(row.setup_tier, "tier attribution populated");
});

test("3. capture leaves lane_routes UNTOUCHED (router stays off)", () => {
  const d = memDb();
  for (const c of adapt([agentResult(), agentResult({ agentId: "call_1-5", horizon: "1-5" })])) captureSetupCandidateOnDb(d, c, 1);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM lane_routes").get().n, 0, "capture-only never writes lane_routes");
});

test("7. repeated capture does not create duplicates (idempotent)", () => {
  const d = memDb();
  const [c] = adapt([agentResult()]);
  assert.equal(captureSetupCandidateOnDb(d, c, 1), true);
  assert.equal(captureSetupCandidateOnDb(d, c, 2), false, "same setup_id ignored");
  assert.equal(d.prepare("SELECT COUNT(*) n FROM setup_candidates").get().n, 1);
});

test("6. capture wrapper never throws into the caller (failure isolation primitive)", () => {
  const src = read("lib/research/capture.ts");
  const body = src.slice(src.indexOf("export function captureSetupCandidates"));
  assert.match(body, /try\s*{/, "wrapper try/catch");
  assert.match(body, /catch\s*\(/, "wrapper catches");
  assert.match(body, /skippedReason:\s*`capture error/, "returns a safe skippedReason on error instead of throwing");
});

// ── source-level wiring guarantees (callouts/runtime.ts) ─────────────────────
test("wiring: capture runs in the authoritative cycle, flag-gated, and isolated", () => {
  const src = read("lib/callouts/runtime.ts");
  const block = src.slice(src.indexOf("if (opts.deliver) {"), src.indexOf("// SUPERVISOR→PAPER BRIDGE"));
  assert.match(block, /researchFlags\(\)\.setupCandidateCapture/, "gated by the capture flag");
  assert.match(block, /captureSetupCandidates\(/, "reuses the existing capture wrapper (no second path)");
  assert.match(block, /candidateCapture = captureSetupCandidates/, "captures the canonical allResults");
  // The capture call is wrapped in its own try/catch (isolated from Discord/paper).
  assert.match(block, /try\s*{[\s\S]*captureSetupCandidates\([\s\S]*}\s*catch/, "capture is try/catch-isolated");
});

test("4+5. capture does NOT enable the router and does NOT touch Discord/paper code", () => {
  const src = read("lib/callouts/runtime.ts");
  // capture uses captureSetupCandidates, NOT routeAgentResults — it never enables routing.
  const captureIdx = src.indexOf("candidateCapture = captureSetupCandidates");
  const routerIdx = src.indexOf("laneRouting = routeAgentResults");
  assert.ok(captureIdx > 0 && routerIdx > captureIdx, "capture is a distinct step before the (separately-flagged) router");
  // The Discord delivery loop and the paper bridge remain present and AFTER capture (unchanged).
  assert.ok(src.indexOf("deliverCalloutDiscord(") > captureIdx, "Discord delivery unchanged, after capture");
  assert.ok(src.indexOf("bridgeCalloutsToPaper(") > captureIdx, "paper bridge unchanged, after capture");
  // Router remains gated by its own flag (capture did not loosen it).
  assert.match(read("lib/research/router.ts"), /LANE_ROUTER_ENABLED!=1/, "router still gated by LANE_ROUTER_ENABLED");
});
