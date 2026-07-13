import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCallout } from "../lib/callouts/callout.ts";
import { bridgeCalloutsToPaperOnDb, candidateIdempotencyKey } from "../lib/callouts/paper-bridge.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch { Database = null; }

// Mirrors the additive migration in lib/db.ts (repeat-safe CREATE IF NOT EXISTS).
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
    verifiedInputs: { spot: 182.4, entryWindow: ew }, requiredConditions: ["hold VWAP"], selectorProfile: "swing_momentum",
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

const okCreate = () => ({ ok: true, id: Math.floor(Math.random() * 1e6), risk: { allowed: true, failures: [] } });
const rows = (db) => db.prepare("SELECT * FROM paper_candidates ORDER BY id").all();

if (Database) {
  test("HIGH + ACTIONABLE_NOW callout creates exactly one paper candidate", () => {
    const db = new Database(":memory:"); db.exec(DDL);
    const s = bridgeCalloutsToPaperOnDb(db, [buildCallout(ar())], okCreate, NOW, PAPER_ON);
    assert.equal(s.eligible, 1);
    assert.equal(s.created, 1);
    const r = rows(db);
    assert.equal(r.length, 1);
    assert.equal(r[0].status, "CREATED");
    assert.ok(r[0].paper_trade_id != null, "linked to a paper trade");
    // Alert-time facts are frozen on the candidate.
    assert.equal(r[0].ticker, "NVDA");
    assert.equal(r[0].option_symbol, "O:NVDA_C185");
    assert.equal(r[0].strike, 185);
    assert.equal(r[0].underlying_price, 182.4);
    assert.equal(r[0].option_bid, 2.10);
    assert.equal(r[0].confidence_tier, "HIGH");
    assert.equal(r[0].entry_state, "ACTIONABLE");
  });

  test("a duplicate cycle does NOT create a second candidate", () => {
    const db = new Database(":memory:"); db.exec(DDL);
    const c = buildCallout(ar());
    bridgeCalloutsToPaperOnDb(db, [c], okCreate, NOW, PAPER_ON);
    const s2 = bridgeCalloutsToPaperOnDb(db, [c], okCreate, NOW, PAPER_ON);
    assert.equal(s2.duplicates, 1);
    assert.equal(s2.created, 0);
    assert.equal(rows(db).length, 1, "still exactly one candidate");
  });

  test("dedup survives a 'restart' (same key persisted) and Discord retries", () => {
    const db = new Database(":memory:"); db.exec(DDL);
    const c = buildCallout(ar());
    bridgeCalloutsToPaperOnDb(db, [c], okCreate, NOW, PAPER_ON);
    // Simulate a fresh process by making a new bridge call against the SAME db.
    const again = bridgeCalloutsToPaperOnDb(db, [c, c], okCreate, NOW, PAPER_ON);
    assert.equal(again.created, 0);
    assert.equal(rows(db).length, 1);
    assert.equal(candidateIdempotencyKey(c, NOW), `paper:NVDA|bullish|1-5:ACTIONABLE_NOW:2026-07-13`);
  });

  for (const [label, over, ew] of [
    ["WAIT_FOR_PULLBACK", { candidateStatus: "WAIT_FOR_PULLBACK", actionability: "WATCH" }, { ...EW_OK, state: "WAIT_FOR_PULLBACK" }],
    ["WATCH", { candidateStatus: "WATCH", actionability: "WATCH" }, null],
    ["NEAR_TRIGGER", { candidateStatus: "NEAR_TRIGGER", actionability: "WATCH" }, { ...EW_OK, state: "NEAR_TRIGGER" }],
    ["MISSED", { candidateStatus: "MISSED", actionability: "WATCH" }, { ...EW_OK, state: "MISSED" }],
    ["EXTENDED", { candidateStatus: "EXTENDED", actionability: "WATCH" }, { ...EW_OK, state: "EXTENDED" }],
    ["INVALIDATED", { candidateStatus: "INVALIDATED", actionability: "BLOCKED" }, { ...EW_OK, state: "INVALIDATED" }],
    ["stale-quote", { freshness: { ok: false, reason: "stale" } }, EW_OK],
    ["wide-spread", { selectedContract: { ...ar().selectedContract, spreadPct: 40 } }, EW_OK],
    ["no-contract", { candidateStatus: "NO_VALID_CONTRACT", actionability: "BLOCKED", selectedContract: null }, null],
  ]) {
    test(`${label} creates NO paper candidate`, () => {
      const db = new Database(":memory:"); db.exec(DDL);
      const s = bridgeCalloutsToPaperOnDb(db, [buildCallout(ar(over, ew))], okCreate, NOW, PAPER_ON);
      assert.equal(s.created, 0, `${label} must not create a candidate`);
      assert.equal(rows(db).length, 0);
    });
  }

  test("0DTE is blocked when PAPER_ALLOW_ZERO_DTE is off (surfaced, not silent)", () => {
    const db = new Database(":memory:"); db.exec(DDL);
    const zero = buildCallout(ar({ selectedContract: { ...ar().selectedContract, dte: 0 } }));
    const s = bridgeCalloutsToPaperOnDb(db, [zero], okCreate, NOW, { PAPER_TRADING_ENABLED: "1", PAPER_AUTO_ENTRY: "1" });
    assert.equal(s.created, 0);
    assert.equal(rows(db).length, 0);
  });

  test("a create-time refusal is stored as REJECTED with the reason, never CREATED", () => {
    const db = new Database(":memory:"); db.exec(DDL);
    const refuse = () => ({ ok: false, risk: { allowed: false, failures: ["capital: buying power exhausted"] } });
    const s = bridgeCalloutsToPaperOnDb(db, [buildCallout(ar())], refuse, NOW, PAPER_ON);
    assert.equal(s.rejected, 1);
    assert.equal(s.created, 0);
    const r = rows(db);
    assert.equal(r[0].status, "REJECTED");
    assert.match(r[0].reject_reason, /buying power/);
    assert.equal(r[0].paper_trade_id, null, "a rejected candidate never links a trade → never a graded outcome");
  });

  test("bearish paper candidate is blocked while bearish actionability is off", () => {
    const db = new Database(":memory:"); db.exec(DDL);
    const put = buildCallout(ar({ direction: "bearish", candidateStatus: "RESEARCH_ONLY", actionability: "RESEARCH_ONLY", researchOnly: true, selectedContract: { ...ar().selectedContract, side: "put" } }, null));
    const s = bridgeCalloutsToPaperOnDb(db, [put], okCreate, NOW, { ...PAPER_ON });
    assert.equal(s.created, 0);
    assert.equal(rows(db).length, 0);
  });
}

if (Database) {
  test("the paper_candidates migration is additive and repeat-safe", () => {
    const db = new Database(":memory:");
    db.exec(DDL); db.exec(DDL); db.exec(DDL); // applying it repeatedly must never throw
    const cols = new Set(db.prepare("PRAGMA table_info(paper_candidates)").all().map((c) => c.name));
    for (const c of ["idempotency_key", "setup_identity", "option_symbol", "confidence_tier", "paper_trade_id", "status"]) {
      assert.ok(cols.has(c), `column ${c} exists`);
    }
  });

  test("the UNIQUE idempotency key is enforced at the DB level", () => {
    const db = new Database(":memory:"); db.exec(DDL);
    const ins = () => db.prepare("INSERT INTO paper_candidates (idempotency_key, setup_identity, ticker, direction, status, created_at_ms) VALUES ('k','SPY|bullish|0DTE','SPY','bullish','ELIGIBLE',1)").run();
    ins();
    assert.throws(ins, /UNIQUE/, "a second insert with the same key is rejected");
  });
}

// ── wiring (source-spec) ─────────────────────────────────────────────────────
test("the callout runtime wires the paper bridge only in the authoritative cycle", () => {
  const src = readFileSync(join(root, "lib/callouts/runtime.ts"), "utf8");
  assert.match(src, /bridgeCalloutsToPaper\(callouts, nowMs\)/, "bridge runs on the reconciled callouts");
  assert.match(src, /if \(opts\.deliver\)/, "bridge is gated to the delivery cycle (never on read-only GETs)");
});

test("the bridge creates trades through the shared createPaperTrade path (revalidation preserved)", () => {
  const src = readFileSync(join(root, "lib/callouts/paper-bridge.ts"), "utf8");
  assert.match(src, /createPaperTrade/, "reuses the shared paper-entry path");
  const engine = readFileSync(join(root, "lib/paper-engine.ts"), "utf8");
  assert.match(engine, /revalidateContract/, "the sweep still revalidates before any fill");
});
