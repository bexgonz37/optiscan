import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

const NOW = Date.parse("2026-07-16T15:00:00Z");
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

if (Database) {
  test("Primary paper REJECTION is recorded and never throws (delivery can proceed)", () => {
    const db = new Database(":memory:"); db.exec(DDL);
    const rejectingCreate = () => ({ ok: false, risk: { allowed: false, failures: ["capital cap reached"] } });
    const s = bridgeCalloutsToPaperOnDb(db, [buildCallout(ar())], rejectingCreate, NOW, PAPER_ON);
    assert.equal(s.eligible, 1);
    assert.equal(s.rejected, 1);
    assert.equal(s.created, 0);
    assert.equal(s.exceptions, 0);
  });

  test("Challenge rejection/disabled/FAILED is INDEPENDENT — Primary still created, no throw", () => {
    for (const challenge of [
      { ok: false, reason: "challenge sizing refused" },
      { ok: false, reason: "challenge disabled (PAPER_CHALLENGE_ENABLED!=1)" },
      { ok: false, reason: "challenge not accepting entries (status FAILED)" },
    ]) {
      const db = new Database(":memory:"); db.exec(DDL);
      const create = () => ({ ok: true, id: 42, risk: { allowed: true, failures: [] }, challenge });
      const s = bridgeCalloutsToPaperOnDb(db, [buildCallout(ar())], create, NOW, PAPER_ON);
      assert.equal(s.created, 1, "primary created regardless of challenge");
      assert.equal(s.challengeRejected, 1);
      assert.equal(s.challengeCreated, 0);
      assert.equal(s.exceptions, 0);
    }
  });

  test("Challenge success is counted independently of Primary", () => {
    const db = new Database(":memory:"); db.exec(DDL);
    const create = () => ({ ok: true, id: 7, risk: { allowed: true, failures: [] }, challenge: { ok: true, id: 8 } });
    const s = bridgeCalloutsToPaperOnDb(db, [buildCallout(ar())], create, NOW, PAPER_ON);
    assert.equal(s.created, 1);
    assert.equal(s.challengeCreated, 1);
    assert.equal(s.challengeRejected, 0);
  });

  test("a paper-create EXCEPTION is isolated (caught, counted) and never aborts the batch", () => {
    const db = new Database(":memory:"); db.exec(DDL);
    // First ticker throws (simulating a DB error / lock); second must still be created.
    const create = (input) => {
      if (input.ticker === "NVDA") throw new Error("database is locked");
      return { ok: true, id: 99, risk: { allowed: true, failures: [] } };
    };
    const callouts = [
      buildCallout(ar()),
      buildCallout(ar({ ticker: "TSLA", agentId: "call_1_5_tsla", selectedContract: { optionSymbol: "O:TSLA_C250", strike: 250, expiration: "2026-07-17", dte: 4, side: "call", bid: 3.1, ask: 3.2, mid: 3.15, spreadPct: 3, delta: 0.5, iv: 0.4, volume: 400, openInterest: 900, breakevenPct: 0.6 } })),
    ];
    const s = bridgeCalloutsToPaperOnDb(db, callouts, create, NOW, PAPER_ON);
    assert.equal(s.exceptions, 1, "the throwing ticker was isolated");
    assert.equal(s.created, 1, "the NEXT ticker still created a paper trade");
    const tsla = db.prepare("SELECT status FROM paper_candidates WHERE ticker='TSLA'").get();
    assert.equal(tsla.status, "CREATED");
    const nvda = db.prepare("SELECT status, reject_reason FROM paper_candidates WHERE ticker='NVDA'").get();
    assert.equal(nvda.status, "REJECTED");
    assert.match(nvda.reject_reason, /exception \(isolated\)/);
  });
}

// ── structural invariants (delivery ↔ paper isolation) ───────────────────────

test("the callout runtime bridges paper INSIDE try/catch and delivers AFTER (delivery not inside the bridge try)", () => {
  const src = read("lib/callouts/runtime.ts");
  assert.match(src, /try \{ paperBridge = bridgeCalloutsToPaper\(callouts, nowMs\); \}\s*catch/, "paper bridge is caught");
  // Delivery loop must be its own block, reached regardless of a bridge failure.
  const bridgeIdx = src.indexOf("bridgeCalloutsToPaper(callouts");
  const deliverIdx = src.indexOf("deliverCalloutDiscord({");
  assert.ok(deliverIdx > bridgeIdx, "delivery runs after the (isolated) bridge");
});

test("createPaperTrade isolates the Challenge mirror in try/catch (never affects Primary/caller)", () => {
  const src = read("lib/paper-engine.ts");
  const wrapper = src.slice(src.indexOf("export function createPaperTrade"), src.indexOf("function maybeMirrorToChallenge"));
  assert.match(wrapper, /try \{\s*challenge = maybeMirrorToChallenge/, "mirror is wrapped in try/catch");
  assert.match(wrapper, /challenge exception \(isolated\)/, "challenge exceptions are recorded, not thrown");
  assert.match(wrapper, /return \{ \.\.\.primary, challenge \}/, "primary result is returned unchanged");
});

test("stock notifications are independent of the options paper/challenge logic", () => {
  // The stock alert path (scanner-loop → captureStockAlert → notifyNewAlert) must not
  // depend on the options paper engine or the Challenge to deliver.
  const capture = read("lib/stock-capture.ts");
  assert.doesNotMatch(capture, /paper-engine|maybeMirrorToChallenge|createPaperTrade|paper-challenge/, "stock capture must not import the options paper engine");
});

test("safe test-delivery endpoint sends an EXPLICIT test message, never a fabricated trade", () => {
  const route = read("app/api/discord/test/route.ts");
  assert.match(route, /sendDiscordTest/);
  assert.match(route, /checkApiToken/, "authenticated");
  assert.match(route, /never a fabricated actionable\s*\n?\s*\*? ?trade callout|never a fabricated/, "documented as a test, not a real signal");
  const notif = read("lib/notifications.ts");
  assert.match(notif, /sendDiscordTest/);
});

test("REGRESSION: no live broker / real-money path introduced", () => {
  const blob = ["lib/paper-engine.ts", "lib/paper-challenge.ts", "lib/callouts/paper-bridge.ts"].map(read).join("\n");
  // camelCase identifiers only — the "no broker or real-money path" doc comments are
  // the negation and must not trip this (matches the repo's regression convention).
  assert.doesNotMatch(blob, /robinhood|realMoney|placeOrder|liveBroker|executeOrder/i);
});
