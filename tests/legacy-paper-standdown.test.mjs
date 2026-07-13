import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { legacyPaperAutoEntrySuppressed } from "../lib/callouts/routing.ts";
import { buildCallout } from "../lib/callouts/callout.ts";
import { bridgeCalloutsToPaperOnDb } from "../lib/callouts/paper-bridge.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch { Database = null; }

const DDL = `
CREATE TABLE IF NOT EXISTS paper_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  setup_identity TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'SUPERVISOR', callout_key TEXT,
  ticker TEXT NOT NULL, direction TEXT NOT NULL, strategy TEXT, horizon TEXT,
  option_symbol TEXT, strike REAL, expiration TEXT, dte INTEGER, underlying_price REAL,
  option_bid REAL, option_ask REAL, option_mid REAL, estimated_entry REAL, quote_asof_ms INTEGER,
  entry_state TEXT, confidence_tier TEXT, setup_score REAL, contract_score REAL, risk_ok INTEGER,
  lifecycle_status TEXT, callout_ts_ms INTEGER, trigger_ts_ms INTEGER, model_state TEXT, evidence_state TEXT,
  status TEXT NOT NULL DEFAULT 'ELIGIBLE', reject_reason TEXT, paper_trade_id INTEGER, created_at_ms INTEGER NOT NULL
);`;

const NOW = Date.parse("2026-07-13T15:00:00Z"); // 11:00 ET, regular session
const PAPER_ON = { PAPER_TRADING_ENABLED: "1", PAPER_AUTO_ENTRY: "1", PAPER_ALLOW_ZERO_DTE: "1" };
const EW_OK = { state: "ACTIONABLE", waitFor: "enter now", validEntry: "valid now", doNotEnter: "loses VWAP", currently: "confirmed", alreadyHappened: null };

function ar(over = {}) {
  return {
    agentId: "call_1_5", agentVersion: 1, strategy: "swing_momentum", strategyVersion: 1,
    ticker: "NVDA", direction: "bullish", horizon: "1-5", dteRange: [1, 5],
    candidateStatus: "ACTIONABLE_NOW", lifecycleStatus: null, score: 82,
    verifiedInputs: { spot: 182.4, entryWindow: EW_OK }, requiredConditions: ["hold VWAP"], selectorProfile: "swing_momentum",
    selectedContract: { optionSymbol: "O:NVDA_C185", strike: 185, expiration: "2026-07-17", dte: 4, side: "call", bid: 2.10, ask: 2.18, mid: 2.14, spreadPct: 3, delta: 0.5, iv: 0.3, volume: 500, openInterest: 1000, breakevenPct: 0.5 },
    passedGates: ["spread"], failedGates: [], evidenceStatus: "NOT_TRACKED",
    statisticsSnapshot: { evidenceStatus: "NOT_TRACKED", evidenceSummary: "", gradedSampleSize: 0 },
    modelStatus: "INACTIVE_NO_TRAINABLE_DATA", probability: null,
    actionability: "ACTIONABLE", researchOnly: false, reasons: ["fresh momentum"],
    improvementConditions: [], invalidationConditions: ["loses VWAP"], freshness: { ok: true, reason: null },
    marketContext: null, riskVerdict: { allowed: true, failures: [], vetoed: false }, timestamp: NOW,
    ...over,
  };
}

// ── the pure gate ─────────────────────────────────────────────────────────────
test("legacy paper auto-entry stands down exactly when supervisor is canonical", () => {
  assert.equal(legacyPaperAutoEntrySuppressed({}), false);
  assert.equal(legacyPaperAutoEntrySuppressed({ CALLOUT_CANONICAL_PATH: "legacy" }), false);
  assert.equal(legacyPaperAutoEntrySuppressed({ CALLOUT_CANONICAL_PATH: "supervisor" }), true);
});

// ── the wiring: autoEnterFromAlerts early-returns under the gate ──────────────
test("autoEnterFromAlerts refuses to create alert-derived trades under the supervisor path", () => {
  const src = read("lib/paper-engine.ts");
  const fn = src.slice(src.indexOf("export function autoEnterFromAlerts"));
  const head = fn.slice(0, fn.indexOf("const db = getDb();"));
  assert.ok(/if \(legacyPaperAutoEntrySuppressed\(\)\) return 0;/.test(head),
    "legacy alert auto-entry stands down before touching the DB when supervisor is canonical");
  // And it is gated after the auto-entry enable check, so both must pass to proceed.
  assert.ok(head.indexOf("AUTO_ENTRY_ENABLED()") < head.indexOf("legacyPaperAutoEntrySuppressed()"));
});

// ── the authoritative bridge cannot double-create for one setup/day ──────────
test("the supervisor bridge creates exactly ONE trade for the same actionable setup (dedup)", { skip: Database ? false : "better-sqlite3 unavailable" }, () => {
  const db = new Database(":memory:");
  db.exec(DDL);
  const c = buildCallout(ar());

  let createCalls = 0;
  const createTrade = () => { createCalls += 1; return { ok: true, id: createCalls, risk: { allowed: true, failures: [] } }; };

  // First cycle: eligible → one candidate + one createTrade.
  const s1 = bridgeCalloutsToPaperOnDb(db, [c], createTrade, NOW, PAPER_ON);
  assert.equal(s1.created, 1);
  assert.equal(createCalls, 1);

  // A duplicate scanner cycle later the SAME trading day: no second candidate, no
  // second createTrade — the same real setup cannot become two paper trades.
  const s2 = bridgeCalloutsToPaperOnDb(db, [c], createTrade, NOW + 90_000, PAPER_ON);
  assert.equal(s2.duplicates, 1);
  assert.equal(s2.created, 0);
  assert.equal(createCalls, 1, "no second paper trade for the same setup identity that day");

  const rows = db.prepare("SELECT COUNT(*) n FROM paper_candidates").get();
  assert.equal(rows.n, 1);
  db.close();
});
