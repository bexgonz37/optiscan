import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCallout } from "../lib/callouts/callout.ts";
import { bridgeCalloutsToPaperOnDb } from "../lib/callouts/paper-bridge.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let Database = null;
try { Database = (await import("better-sqlite3")).default; new Database(":memory:").close(); } catch { Database = null; }

const DDL = `
CREATE TABLE IF NOT EXISTS paper_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key TEXT NOT NULL UNIQUE,
  setup_identity TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'SUPERVISOR', callout_key TEXT,
  ticker TEXT NOT NULL, direction TEXT NOT NULL, strategy TEXT, horizon TEXT,
  option_symbol TEXT, strike REAL, expiration TEXT, dte INTEGER, underlying_price REAL,
  option_bid REAL, option_ask REAL, option_mid REAL, estimated_entry REAL, quote_asof_ms INTEGER,
  entry_state TEXT, confidence_tier TEXT, setup_score REAL, contract_score REAL, risk_ok INTEGER,
  lifecycle_status TEXT, callout_ts_ms INTEGER, trigger_ts_ms INTEGER, model_state TEXT, evidence_state TEXT,
  status TEXT NOT NULL DEFAULT 'ELIGIBLE', reject_reason TEXT, paper_trade_id INTEGER, created_at_ms INTEGER NOT NULL
);`;

const NOW = Date.parse("2026-07-13T15:00:00Z");
const PAPER_ON = { PAPER_TRADING_ENABLED: "1", PAPER_AUTO_ENTRY: "1", PAPER_ALLOW_ZERO_DTE: "1" };
const EW_OK = { state: "ACTIONABLE", waitFor: "enter now", validEntry: "valid now", doNotEnter: "loses VWAP", currently: "confirmed", alreadyHappened: null };
const OCC = "O:NVDA260717C00185000";

function ar(over = {}) {
  return {
    agentId: "call_1_5", agentVersion: 1, strategy: "swing_momentum", strategyVersion: 1,
    ticker: "NVDA", direction: "bullish", horizon: "1-5", dteRange: [1, 5],
    candidateStatus: "ACTIONABLE_NOW", lifecycleStatus: null, score: 82,
    verifiedInputs: { spot: 182.4, entryWindow: EW_OK }, requiredConditions: ["hold VWAP"], selectorProfile: "swing_momentum",
    selectedContract: { optionSymbol: OCC, strike: 185, expiration: "2026-07-17", dte: 4, side: "call", bid: 2.10, ask: 2.18, mid: 2.14, spreadPct: 3, delta: 0.5, iv: 0.3, volume: 500, openInterest: 1000, breakevenPct: 0.5 },
    passedGates: ["spread"], failedGates: [], evidenceStatus: "NOT_TRACKED",
    statisticsSnapshot: { evidenceStatus: "NOT_TRACKED", evidenceSummary: "", gradedSampleSize: 0 },
    modelStatus: "INACTIVE_NO_TRAINABLE_DATA", probability: null,
    actionability: "ACTIONABLE", researchOnly: false, reasons: ["fresh momentum"],
    improvementConditions: [], invalidationConditions: ["loses VWAP"], freshness: { ok: true, reason: null },
    marketContext: null, riskVerdict: { allowed: true, failures: [], vetoed: false }, timestamp: NOW,
    ...over,
  };
}

if (Database) {
  test("exact OCC contract flows callout → candidate → paper-trade create input (no substitution)", () => {
    const db = new Database(":memory:"); db.exec(DDL);
    const captured = [];
    const capture = (input) => { captured.push(input); return { ok: true, id: 42, risk: { allowed: true, failures: [] } }; };
    const c = buildCallout(ar());
    bridgeCalloutsToPaperOnDb(db, [c], capture, NOW, PAPER_ON);
    // The candidate row, the callout contract, and the createTrade input must ALL carry the identical OCC symbol.
    assert.equal(captured.length, 1);
    assert.equal(captured[0].optionSymbol, OCC);
    assert.equal(captured[0].optionType, "call");
    assert.equal(captured[0].strike, 185);
    assert.equal(captured[0].expiration, "2026-07-17");
    const row = db.prepare("SELECT option_symbol FROM paper_candidates").get();
    assert.equal(row.option_symbol, OCC);
    assert.equal(c.contract.optionSymbol, OCC);
  });
}

// ── source-spec wiring (createPaperTrade path needs the DB alias, so assert on source) ──
test("createPaperTrade blocks option entries when the options market is not open", () => {
  const src = readFileSync(join(root, "lib/paper-engine.ts"), "utf8");
  assert.match(src, /options market not open/, "RTH guard reason present");
  assert.match(src, /PAPER_OPTIONS_REQUIRE_RTH/, "guard is env-escapable for backfills/tests");
  assert.match(src, /creationSession !== "regular"/, "guard checks the session");
});

test("createPaperTrade sizes through the deterministic risk-based sizer", () => {
  const src = readFileSync(join(root, "lib/paper-engine.ts"), "utf8");
  assert.match(src, /sizeOptionContracts/, "option contracts come from the sizer");
  assert.match(src, /riskConfigForProfile/, "risk caps scale with the profile, not the proposal");
  assert.match(src, /capitalConfigForProfile/, "capital caps scale with the profile");
  assert.match(src, /sizing_json/, "the sizing calc is persisted for the detail page");
});

test("puts remain research-only unless BEARISH_ACTIONABLE=1 (eligibility unchanged)", () => {
  const src = readFileSync(join(root, "lib/callouts/eligibility.ts"), "utf8");
  assert.match(src, /BEARISH_ACTIONABLE !== "1"/, "bearish gate intact");
  assert.match(src, /research-only/, "puts labelled research-only");
});
