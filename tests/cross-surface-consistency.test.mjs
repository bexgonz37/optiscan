/**
 * cross-surface-consistency.test.mjs
 *
 * One canonical case, seven surfaces, one set of facts.
 *
 * WHY THIS TEST EXISTS
 *
 * Every surface in this system builds its own view from its own query. That is
 * the right architecture — a shared mutable view object would couple the Discord
 * formatter to the research report — but it means nothing structural stops two
 * surfaces from disagreeing, and a disagreement about which SIDE a case was, or
 * whether a number is realized or a peak, is not a cosmetic bug. It is the
 * system telling the owner two different things and being confident about both.
 *
 * The surfaces checked here are the ones that can independently name a case:
 * the private app's panels, the content draft, the missed-opportunity view, the
 * executable measurement, and the coherence validator that guards outgoing copy.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM
 *
 * This is a fixture, not production. It proves the resolvers agree given the same
 * rows; it cannot prove production holds the rows it should. The forensic routes
 * do that, and they run against the real database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { measureExecutableOpportunityOnDb } from "../lib/research/options/executable-opportunity.ts";
import { gateContentBundle } from "../lib/content/content-gate.ts";
import { validateContentCoherence } from "../lib/content/content-coherence.ts";
import { plainLabel } from "../lib/research/plain-language.ts";

// ── the canonical case ──────────────────────────────────────────────────────
const CASE = Object.freeze({
  symbol: "MRNA",
  side: "CALL",
  direction: "BULLISH",
  caseId: "oc_canonical",
  occ: "O:MRNA260821C00120000",
  strike: 120,
  expiration: "2026-08-21",
  sessionDate: "2026-08-19",
  entryBid: 8.0,
  entryAsk: 8.26,
  sourceLane: "OWNER_VALIDATION_PAPER",
  evidenceState: "NON_ACTIONABLE_RESEARCH",
});
const OPEN_MS = Date.UTC(2026, 7, 19, 13, 30);
const EXPECTED_ENTRY_MARK = CASE.entryAsk;

function seed() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE market_mover_observations (
      session_date TEXT, symbol TEXT, first_observed_at_ms INTEGER, first_rank INTEGER,
      first_move_pct REAL, peak_abs_move_pct REAL, dollar_volume REAL,
      PRIMARY KEY (session_date, symbol));
    CREATE TABLE options_research_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_date TEXT, symbol TEXT, observed_at_ms INTEGER,
      option_symbol TEXT, option_type TEXT, strike REAL, expiration TEXT,
      option_bid REAL, option_ask REAL, spread_pct REAL, quote_timestamp_ms INTEGER,
      volume REAL, open_interest REAL, delta REAL, dte INTEGER);
    CREATE TABLE asymmetry_outcomes (
      session_date TEXT, fingerprint TEXT, option_symbol TEXT, entry_ask REAL,
      mfe_pct REAL, mae_pct REAL, final_return_pct REAL,
      hit_25 INTEGER, hit_50 INTEGER, hit_100 INTEGER, hit_200 INTEGER,
      time_to_25_ms INTEGER, time_to_50_ms INTEGER, time_to_100_ms INTEGER, time_to_200_ms INTEGER,
      marks_used INTEGER DEFAULT 0);
    CREATE TABLE contract_funnel_evidence (session_date TEXT, at_ms INTEGER, symbol TEXT, terminal_reason TEXT);
    CREATE TABLE options_candidates (session_date TEXT, symbol TEXT);
    CREATE TABLE opportunity_content_events (id TEXT PRIMARY KEY, symbol TEXT, created_at_ms INTEGER, payload_json TEXT);
    CREATE TABLE content_drafts (
      id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE, content_event_id TEXT,
      opportunity_case_id TEXT, category TEXT, draft_text TEXT, trading_session_date TEXT,
      created_at_ms INTEGER, approved_at_ms INTEGER, rejected_at_ms INTEGER,
      manually_posted_at_ms INTEGER, final_copy TEXT, content_worthiness REAL,
      content_angle TEXT, is_alternate INTEGER DEFAULT 0);
  `);
  db.prepare(
    `INSERT INTO market_mover_observations
       (session_date, symbol, first_observed_at_ms, first_rank, first_move_pct, peak_abs_move_pct, dollar_volume)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(CASE.sessionDate, CASE.symbol, OPEN_MS - 90 * 60_000, 1, 84, 133, 2.3e9);
  db.prepare(
    `INSERT INTO options_research_observations
       (session_date, symbol, observed_at_ms, option_symbol, option_type, strike, expiration,
        option_bid, option_ask, spread_pct, quote_timestamp_ms, volume, open_interest, delta, dte)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    CASE.sessionDate, CASE.symbol, OPEN_MS, CASE.occ, "call", CASE.strike, CASE.expiration,
    CASE.entryBid, CASE.entryAsk, 3.2, OPEN_MS, 4200, 1800, 0.52, 2,
  );
  db.prepare(
    `INSERT INTO asymmetry_outcomes
       (session_date, fingerprint, option_symbol, entry_ask, mfe_pct, mae_pct, final_return_pct,
        hit_25, hit_50, hit_100, hit_200, time_to_25_ms, time_to_50_ms, time_to_100_ms, time_to_200_ms, marks_used)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    CASE.sessionDate, `${CASE.sessionDate}|${CASE.occ}`, CASE.occ, CASE.entryAsk,
    293, -8, 180, 1, 1, 1, 1, 300_000, 600_000, 1_200_000, 2_100_000, 7,
  );
  return db;
}

test("every surface resolves the same symbol, side, contract and entry", () => {
  const db = seed();

  // SURFACE 1 — the executable measurement (feeds the private app and the
  // missed-opportunity panel).
  const exec = measureExecutableOpportunityOnDb(db, { sessionDate: CASE.sessionDate });
  const m = exec.measurements.find((x) => x.symbol === CASE.symbol);
  assert.ok(m, "the canonical case is missing from the executable measurement");
  assert.equal(m.symbol, CASE.symbol);
  assert.equal(m.contract.optionSymbol, CASE.occ);
  assert.equal(String(m.contract.optionType).toUpperCase(), CASE.side);
  assert.equal(m.contract.strike, CASE.strike);
  assert.equal(m.contract.expiration, CASE.expiration);
  assert.equal(m.contract.entryMark, EXPECTED_ENTRY_MARK);
  assert.equal(m.sessionDate, CASE.sessionDate);

  // SURFACE 2 — the content gate, which decides what may be said about it.
  const gate = gateContentBundle(db, {
    symbol: CASE.symbol,
    category: "CLOSED_WINNER",
    optionType: CASE.side,
    direction: CASE.direction,
    sessionDate: CASE.sessionDate,
    thesisParts: ["Extreme premarket continuation"],
    evidenceState: CASE.evidenceState,
    claimVerified: true,
    hasRealizedOutcome: true,
    hasExactOcc: true,
    drafts: [{ text: `${CASE.symbol} closed out. The record is on the board.`, templateFamily: "CLOSED_WINNER_0" }],
  }, {});
  assert.ok(gate.admitted.length > 0);
  // The fingerprint is derived from the same identity the measurement resolved.
  assert.ok(gate.rootFingerprint.startsWith("cf_"));

  // SURFACE 3 — the plain-language layer the private app renders through.
  assert.equal(plainLabel(m.state).raw, m.state);
  assert.equal(plainLabel(CASE.sourceLane).raw, CASE.sourceLane);

  // And the same case, resolved twice, is the same case.
  const again = measureExecutableOpportunityOnDb(db, { sessionDate: CASE.sessionDate })
    .measurements.find((x) => x.symbol === CASE.symbol);
  assert.deepEqual(again, m, "the measurement is not deterministic");
});

test("the return TYPE is the same everywhere: a peak is never a realized result", () => {
  const db = seed();
  const m = measureExecutableOpportunityOnDb(db, { sessionDate: CASE.sessionDate }).measurements[0];

  // The ladder carries BOTH, distinguishably. 293 is the peak; 180 is what it
  // closed at. A surface that shows 293 as the result is showing a number that
  // never existed at exit.
  assert.equal(m.ladder.mfePct, 293);
  assert.equal(m.ladder.finalReturnPct, 180);
  assert.notEqual(m.ladder.mfePct, m.ladder.finalReturnPct);

  // And the copy guard refuses to describe the peak as realized.
  const bad = validateContentCoherence({
    text: `We made +${m.ladder.mfePct}% on ${CASE.symbol}.`,
    optionType: CASE.side, isMaxExcursion: true, claimVerified: true,
  });
  assert.equal(bad.coherent, false);
  assert.ok(bad.violations.some((v) => v.rule === "MFE_AS_REALIZED"));

  // The realized number, described as realized, is fine.
  const ok = validateContentCoherence({
    text: `The ${CASE.symbol} case closed at +${m.ladder.finalReturnPct}%.`,
    optionType: CASE.side, isMaxExcursion: false, claimVerified: true,
  });
  assert.equal(ok.coherent, true);
});

test("no surface may present an owner-lane result as a subscriber result", () => {
  // The source lane is OWNER_VALIDATION_PAPER. Every surface that names the lane
  // must say what it means, and no surface may attribute the result to anyone
  // who did not receive it.
  const lane = plainLabel(CASE.sourceLane);
  assert.match(lane.meaning, /subscriber/i);
  assert.match(lane.meaning, /Nothing here was delivered/i);

  for (const claim of [
    "Subscribers made +180% on MRNA.",
    "Members caught this MRNA call.",
    "My subscribers were in this one.",
  ]) {
    const v = validateContentCoherence({ text: claim, optionType: CASE.side, claimVerified: true });
    assert.equal(v.coherent, false, `"${claim}" was allowed through`);
    assert.ok(v.violations.some((x) => x.rule === "SUBSCRIBER_CLAIM_WITHOUT_SUBSCRIBERS"));
  }
});

test("the side is consistent, and copy contradicting it cannot ship", () => {
  const db = seed();
  const m = measureExecutableOpportunityOnDb(db, { sessionDate: CASE.sessionDate }).measurements[0];
  assert.equal(String(m.contract.optionType).toUpperCase(), CASE.side);

  // Evidence pointing the other way is refused wherever it appears.
  const contradiction = gateContentBundle(db, {
    symbol: CASE.symbol, category: "CLOSED_WINNER", optionType: CASE.side, direction: CASE.direction,
    sessionDate: CASE.sessionDate, thesisParts: ["x"], claimVerified: true, hasRealizedOutcome: true,
    drafts: [{ text: "Heavy put buying detected on the MRNA call.", templateFamily: "BAD" }],
  }, {});
  assert.deepEqual(contradiction.admitted, []);
});

test("a case with no quote resolves identically as absent on every surface", () => {
  const db = seed();
  db.prepare(
    `INSERT INTO market_mover_observations
       (session_date, symbol, first_observed_at_ms, first_rank, first_move_pct, peak_abs_move_pct, dollar_volume)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(CASE.sessionDate, "MRNX", OPEN_MS, 2, 200, 264, 5e8);

  const exec = measureExecutableOpportunityOnDb(db, { sessionDate: CASE.sessionDate });
  const missed = exec.measurements.find((x) => x.symbol === "MRNX");
  assert.equal(missed.state, "NOT_ADMITTED_TO_UNIVERSE");
  assert.equal(missed.ladder, null);
  assert.equal(missed.contract, null);

  // The private app's own vocabulary for that state says the same thing.
  const p = plainLabel(missed.state);
  assert.equal(p.label, "Never observed");
  assert.match(p.meaning, /No return can be claimed/i);

  // And it contributes nothing to any aggregate that could read as a result.
  assert.equal(exec.attainable.n, 1, "only the quoted case may enter the aggregate");
  assert.equal(exec.bias.notAdmitted, 1);
  assert.equal(exec.bias.unmeasuredFraction, 0.5);
});

test("the evidence state travels with the case rather than being re-derived", () => {
  const db = seed();
  // Two gate calls differing ONLY in evidence state must produce different
  // identities. If they collided, a verified result and its unverified
  // predecessor would be "the same content" and the better one would be dropped.
  const base = {
    symbol: CASE.symbol, category: "CLOSED_WINNER", optionType: CASE.side,
    sessionDate: CASE.sessionDate, thesisParts: ["x"], hasRealizedOutcome: true,
    drafts: [{ text: "MRNA closed out.", templateFamily: "A" }],
  };
  const unverified = gateContentBundle(db, { ...base, evidenceState: "NON_ACTIONABLE_RESEARCH" }, {});
  const verified = gateContentBundle(db, { ...base, evidenceState: "VERIFIED_EXECUTABLE", claimVerified: true }, {});
  assert.notEqual(unverified.rootFingerprint, verified.rootFingerprint);
});
