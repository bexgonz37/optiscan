import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { recordOptionsResearchObservation } from "../lib/research/options/prospective-evidence.ts";

function db() {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE options_research_observations (
    id INTEGER PRIMARY KEY, observation_key TEXT NOT NULL UNIQUE, observed_at_ms INTEGER, session_date TEXT, symbol TEXT,
    direction TEXT, thesis_fingerprint TEXT, opportunity_case_id TEXT, alert_id TEXT, strategy_family TEXT, candidate_state TEXT,
    readiness_state TEXT, authority_state TEXT, blockers_json TEXT, underlying_price REAL, vwap REAL, vwap_relationship TEXT,
    structure_state TEXT, momentum_state TEXT, relative_state TEXT, option_symbol TEXT, option_type TEXT, strike REAL, expiration TEXT,
    option_bid REAL, option_ask REAL, spread_pct REAL, quote_timestamp_ms INTEGER, quote_age_ms INTEGER, volume REAL,
    open_interest REAL, delta REAL, dte INTEGER, contract_quality_state TEXT, frozen_entry REAL, target_t1 REAL, target_t2 REAL,
    target_stop REAL, paper_trade_id INTEGER, discord_message_id TEXT, delivery_proof_state TEXT, source TEXT, freshness_state TEXT,
    created_at_ms INTEGER
  )`);
  return d;
}

test("prospective evidence is idempotent, millisecond keyed, and preserves null evidence", () => {
  const d = db();
  const x = { observedAtMs: Date.parse("2026-07-30T14:00:00Z"), symbol: "nvda", source: "test", thesisFingerprint: "t", candidateState: "READY" };
  assert.equal(recordOptionsResearchObservation(d, x), true);
  assert.equal(recordOptionsResearchObservation(d, x), true);
  assert.equal(d.prepare("SELECT * FROM options_research_observations").all().length, 1);
  const r = d.prepare("SELECT * FROM options_research_observations").get();
  assert.equal(r.vwap, null);
  assert.equal(r.discord_message_id, null);
  assert.equal(r.observed_at_ms, x.observedAtMs);
  assert.ok(r.observation_key);
});

test("distinct lifecycle states and millisecond buckets retain factual snapshots", () => {
  const d = db();
  const x = { observedAtMs: Date.parse("2026-07-30T14:00:00Z"), symbol: "NVDA", source: "test", thesisFingerprint: "t" };
  recordOptionsResearchObservation(d, { ...x, candidateState: "CANDIDATE_DETECTED" });
  recordOptionsResearchObservation(d, { ...x, candidateState: "READY", optionSymbol: "O:NVDA260731C00195000" });
  recordOptionsResearchObservation(d, { ...x, observedAtMs: x.observedAtMs + 1, candidateState: "READY", optionSymbol: "O:NVDA260731C00195000" });
  assert.equal(d.prepare("SELECT COUNT(*) n FROM options_research_observations").get().n, 3);
});

test("writer failures and invalid input stay contained", () => {
  assert.equal(recordOptionsResearchObservation({ prepare: () => { throw new Error("db unavailable"); } }, { observedAtMs: 1, symbol: "SPY", source: "test" }), false);
  assert.equal(recordOptionsResearchObservation(db(), { observedAtMs: 0, symbol: "SPY", source: "test" }), false);
});
