import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCallout } from "../lib/callouts/callout.ts";
import { bridgeCalloutsToPaperOnDb } from "../lib/callouts/paper-bridge.ts";
import { nowOnlyActionable, paperCandidateEligibility } from "../lib/callouts/eligibility.ts";

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

const NOW = Date.parse("2026-07-13T15:00:00Z");
const PAPER_ON = { PAPER_TRADING_ENABLED: "1", PAPER_AUTO_ENTRY: "1", PAPER_ALLOW_ZERO_DTE: "1" };
const EW_OK = { state: "ACTIONABLE", waitFor: "enter now", validEntry: "valid now", doNotEnter: "loses VWAP", currently: "confirmed", alreadyHappened: null };

function ar(over = {}, ew = EW_OK) {
  return {
    agentId: "call_1_5", agentVersion: 1, strategy: "swing_momentum", strategyVersion: 1,
    ticker: "NVDA", direction: "bullish", horizon: "1-5", dteRange: [1, 5],
    candidateStatus: "ACTIONABLE_NOW", lifecycleStatus: null, score: 82,
    verifiedInputs: ew ? { spot: 182.4, entryWindow: ew } : { spot: 182.4 },
    requiredConditions: ["hold VWAP"], selectorProfile: "swing_momentum",
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

const NON_ACTIONABLE = [
  ["WAIT_FOR_PULLBACK", { candidateStatus: "WAIT_FOR_PULLBACK", actionability: "WATCH" }, { state: "WAIT_FOR_PULLBACK", waitFor: "", validEntry: "", doNotEnter: "", currently: "", alreadyHappened: null }],
  ["WATCH", { candidateStatus: "WATCH", actionability: "WATCH" }, null],
  ["NEAR_TRIGGER", { candidateStatus: "NEAR_TRIGGER", actionability: "WATCH" }, { state: "NEAR_TRIGGER", waitFor: "", validEntry: "", doNotEnter: "", currently: "", alreadyHappened: null }],
  ["MISSED", { candidateStatus: "MISSED", actionability: "WATCH" }, { state: "MISSED", waitFor: "", validEntry: "", doNotEnter: "", currently: "", alreadyHappened: null }],
  ["EXTENDED", { candidateStatus: "EXTENDED", actionability: "WATCH" }, { state: "EXTENDED", waitFor: "", validEntry: "", doNotEnter: "", currently: "", alreadyHappened: null }],
  ["RESEARCH_ONLY", { candidateStatus: "RESEARCH_ONLY", actionability: "RESEARCH_ONLY", researchOnly: true }, null],
];

// ── the Discord delivery boundary re-asserts the now-only rule ────────────────
test("runtime Discord delivery re-checks nowOnlyActionable at the boundary (defense-in-depth)", () => {
  const src = read("lib/callouts/runtime.ts");
  assert.ok(/import \{ nowOnlyActionable \} from "@\/lib\/callouts\/eligibility"/.test(src));
  assert.ok(/if \(!nowOnlyActionable\(b\.callout\)\.ok\)/.test(src), "guards each bundle before delivery");
  // The guard sits inside the deliver loop, before deliverCalloutDiscord is called.
  const loop = src.slice(src.indexOf("if (opts.deliver && autoSend)"));
  assert.ok(loop.indexOf("nowOnlyActionable(b.callout)") < loop.indexOf("deliverCalloutDiscord("));
});

// ── non-actionable states never paper-trade through the real bridge ──────────
test("non-actionable callouts create ZERO paper candidates through the live bridge", { skip: Database ? false : "better-sqlite3 unavailable" }, () => {
  const db = new Database(":memory:");
  db.exec(DDL);
  let createCalls = 0;
  const createTrade = () => { createCalls += 1; return { ok: true, id: createCalls, risk: { allowed: true, failures: [] } }; };

  for (const [label, over, ew] of NON_ACTIONABLE) {
    const c = buildCallout(ar(over, ew));
    assert.equal(nowOnlyActionable(c).ok, false, `${label} is not now-actionable`);
    assert.equal(paperCandidateEligibility(c, PAPER_ON).ok, false, `${label} is not paper-eligible`);
    const s = bridgeCalloutsToPaperOnDb(db, [c], createTrade, NOW, PAPER_ON);
    assert.equal(s.created, 0, `${label} must not create a paper candidate`);
    assert.equal(s.eligible, 0, `${label} must not be eligible`);
  }
  assert.equal(createCalls, 0, "no paper trade created for any non-actionable state");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM paper_candidates").get().n, 0);
  db.close();
});
