/**
 * executable-opportunity.test.mjs
 *
 * The EXECUTABLE half of EXTREME_PREMARKET_DISCOVERY_V1, measured from evidence
 * that was already paid for.
 *
 * The invariant these tests exist to protect is the one the MRNA post-mortem
 * turned on: NEVER CLAIM AN UNQUOTED MOVE WAS ATTAINABLE. MRNA's 120C showed
 * +319,400% from a $0.01 prior close and +293% from the first executable
 * regular-hours mark. Only the second number is a thing a person could have had,
 * and a measurement that cannot tell them apart is worse than no measurement.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";

import { measureExecutableOpportunityOnDb } from "../lib/research/options/executable-opportunity.ts";
import {
  MEASUREMENT_SCOPES,
  scopeFor,
  isMeasurable,
} from "../lib/research/options/extreme-premarket-discovery-experiment.ts";
import {
  EXTREME_PREMARKET_DISCOVERY_V1_DEFINITION_HASH,
  checkExtremePremarketDiscoveryFrozen,
} from "../lib/research/options/experiment-registry.ts";

const SESSION = "2026-08-19";
const OPEN_MS = Date.UTC(2026, 7, 19, 13, 30);

function makeDb() {
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
    CREATE TABLE contract_funnel_evidence (
      session_date TEXT, at_ms INTEGER, symbol TEXT, terminal_reason TEXT);
    CREATE TABLE options_candidates (session_date TEXT, symbol TEXT);
  `);
  return db;
}

const addMover = (db, symbol, over = {}) => db.prepare(
  `INSERT INTO market_mover_observations
     (session_date, symbol, first_observed_at_ms, first_rank, first_move_pct, peak_abs_move_pct, dollar_volume)
   VALUES (?,?,?,?,?,?,?)`,
).run(
  SESSION, symbol,
  over.firstObservedAtMs ?? OPEN_MS - 90 * 60_000,
  over.rank ?? 1,
  over.firstMovePct ?? 84,
  over.peakMovePct ?? 133,
  over.dollarVolume ?? 2.3e9,
);

/** `??` treats an explicit null as absent, and several fixtures need null to MEAN null. */
const or = (v, fallback) => (v === undefined ? fallback : v);

const addQuote = (db, symbol, over = {}) => db.prepare(
  `INSERT INTO options_research_observations
     (session_date, symbol, observed_at_ms, option_symbol, option_type, strike, expiration,
      option_bid, option_ask, spread_pct, quote_timestamp_ms, volume, open_interest, delta, dte)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
).run(
  SESSION, symbol,
  over.observedAtMs ?? OPEN_MS,
  over.occ ?? "O:MRNA260821C00120000",
  over.optionType ?? "call", over.strike ?? 120, over.expiration ?? "2026-08-21",
  or(over.bid, 8.0), or(over.ask, 8.26), or(over.spreadPct, 3.2),
  over.quoteAtMs ?? OPEN_MS, over.volume ?? 4200, over.oi ?? 1800, over.delta ?? 0.52, over.dte ?? 2,
);

const addOutcome = (db, occ, over = {}) => db.prepare(
  `INSERT INTO asymmetry_outcomes
     (session_date, fingerprint, option_symbol, entry_ask, mfe_pct, mae_pct, final_return_pct,
      hit_25, hit_50, hit_100, hit_200, time_to_25_ms, time_to_50_ms, time_to_100_ms, time_to_200_ms, marks_used)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
).run(
  SESSION, over.fingerprint ?? `fp_${occ}`, occ,
  over.entryAsk ?? 8.13, over.mfePct ?? 293, over.maePct ?? -8, over.finalPct ?? 180,
  or(over.hit25, 1), or(over.hit50, 1), or(over.hit100, 1), or(over.hit200, 1),
  or(over.t25, 300_000), or(over.t50, 600_000), or(over.t100, 1_200_000), or(over.t200, 2_100_000),
  over.marksUsed ?? 7,
);

// ---------------------------------------------------------------------------
// The invariant
// ---------------------------------------------------------------------------

test("a discovered mover that was never quoted carries a NULL ladder, not a zero", () => {
  const db = makeDb();
  addMover(db, "MRNX", { peakMovePct: 264 });
  const r = measureExecutableOpportunityOnDb(db, { sessionDate: SESSION });
  const m = r.measurements.find((x) => x.symbol === "MRNX");
  assert.equal(m.state, "NOT_ADMITTED_TO_UNIVERSE");
  assert.equal(m.ladder, null, "an unquoted mover must not carry a ladder at all");
  assert.equal(m.firstExecutableNbboAtMs, null);
  assert.equal(m.contract, null);
  assert.match(m.note, /No return can be claimed/i);
  // And the +264% underlying move must appear nowhere as an option return.
  assert.equal(r.attainable.n, 0);
  assert.equal(r.attainable.reached100, 0);
});

test("the underlying's move is never converted into an option return", () => {
  const db = makeDb();
  addMover(db, "MRNA", { peakMovePct: 133 });
  db.prepare("INSERT INTO options_candidates (session_date, symbol) VALUES (?,?)").run(SESSION, "MRNA");
  const r = measureExecutableOpportunityOnDb(db, { sessionDate: SESSION });
  const m = r.measurements[0];
  assert.equal(m.state, "ADMITTED_NOT_QUOTED");
  assert.equal(m.ladder, null);
  assert.equal(m.peakUnderlyingMovePct, 133);
  const json = JSON.stringify(r.attainable);
  assert.equal(/133/.test(json), false, "the underlying move leaked into the attainable aggregate");
});

// ---------------------------------------------------------------------------
// The measurable path
// ---------------------------------------------------------------------------

test("a quoted mover yields the executable scope end to end", () => {
  const db = makeDb();
  addMover(db, "MRNA");
  addQuote(db, "MRNA");
  addOutcome(db, "O:MRNA260821C00120000");

  const r = measureExecutableOpportunityOnDb(db, { sessionDate: SESSION });
  const m = r.measurements[0];
  assert.equal(m.state, "EXECUTABLE_EVIDENCE_PRESENT");

  // Everything the brief asked to capture at entry.
  assert.equal(m.symbol, "MRNA");
  assert.equal(m.premarketRank, 1);
  assert.equal(m.underlyingMovePct, 84);
  assert.equal(m.firstExecutableNbboAtMs, OPEN_MS);
  assert.equal(m.timeToFirstQuoteMinutes, 90);
  assert.equal(m.contract.optionSymbol, "O:MRNA260821C00120000");
  assert.equal(m.contract.spreadPct, 3.2);
  assert.equal(m.contract.delta, 0.52);
  assert.equal(m.contract.openInterest, 1800);
  assert.equal(m.contract.volume, 4200);
  assert.equal(m.contract.dte, 2);
  // The entry mark is the MIDPOINT of a two-sided quote, not the last trade and
  // not the ask.
  assert.equal(m.contract.entryMark, (8.0 + 8.26) / 2);

  // And the ladder after entry.
  assert.equal(m.ladder.pct10, true);
  assert.equal(m.ladder.pct25, true);
  assert.equal(m.ladder.pct50, true);
  assert.equal(m.ladder.pct100, true);
  assert.equal(m.ladder.pct200, true);
  assert.equal(m.ladder.mfePct, 293);
  assert.equal(m.ladder.maePct, -8);
  assert.equal(m.ladder.timeTo50Ms, 600_000);
  assert.equal(m.ladder.ladderSource, "MARKED");
  assert.equal(r.evidenceState, "MEASURABLE");
});

test("the ladder is measured from the first EXECUTABLE mark, not the prior close", () => {
  const db = makeDb();
  addMover(db, "MRNA");
  // Two quotes: an earlier, one-sided book and the real two-sided open.
  addQuote(db, "MRNA", { quoteAtMs: OPEN_MS - 3_600_000, bid: null, ask: null, occ: "O:MRNA_STALE" });
  addQuote(db, "MRNA", { quoteAtMs: OPEN_MS });
  addOutcome(db, "O:MRNA260821C00120000");
  const m = measureExecutableOpportunityOnDb(db, { sessionDate: SESSION }).measurements[0];
  assert.equal(m.firstExecutableNbboAtMs, OPEN_MS,
    "a one-sided book is not a price you can cross and must not count as executable");
  assert.equal(m.ladder.entryMark, (8.0 + 8.26) / 2);
});

test("+10 is derived from the peak when no rung was marked, and says so", () => {
  const db = makeDb();
  addMover(db, "TEM", { peakMovePct: 18 });
  addQuote(db, "TEM", { occ: "O:TEM_C" });
  addOutcome(db, "O:TEM_C", {
    mfePct: 14, hit25: null, hit50: null, hit100: null, hit200: null,
    t25: null, t50: null, t100: null, t200: null, marksUsed: 3,
  });
  const m = measureExecutableOpportunityOnDb(db, { sessionDate: SESSION }).measurements[0];
  assert.equal(m.ladder.pct10, true, "a peak of +14% did reach +10%");
  assert.equal(m.ladder.pct25, false);
  assert.equal(m.ladder.ladderSource, "DERIVED_FROM_MFE");
  assert.equal(m.ladder.timeTo25Ms, null, "a derived rung has no timestamp and must not invent one");
});

test("a quoted mover the funnel refused is reported with its recorded reason", () => {
  const db = makeDb();
  addMover(db, "GDXU", { peakMovePct: 26 });
  db.prepare("INSERT INTO contract_funnel_evidence (session_date, at_ms, symbol, terminal_reason) VALUES (?,?,?,?)")
    .run(SESSION, OPEN_MS, "GDXU", "NO_CONTRACT_SELECTED[PROVIDER_QUOTA_EXCEEDED]");
  const m = measureExecutableOpportunityOnDb(db, { sessionDate: SESSION }).measurements[0];
  assert.equal(m.state, "QUOTED_NO_CONTRACT_SELECTED");
  assert.equal(m.ladder, null);
  assert.match(m.noContractReason, /PROVIDER_QUOTA_EXCEEDED/);
});

// ---------------------------------------------------------------------------
// Honesty about what it cannot see
// ---------------------------------------------------------------------------

test("selection bias is reported on every run, not left to be assumed", () => {
  const db = makeDb();
  addMover(db, "MRNA");
  addQuote(db, "MRNA");
  addOutcome(db, "O:MRNA260821C00120000");
  for (const s of ["MRNX", "BNTX", "TWST"]) addMover(db, s, { peakMovePct: 20 });

  const r = measureExecutableOpportunityOnDb(db, { sessionDate: SESSION });
  assert.equal(r.bias.moversConsidered, 4);
  assert.equal(r.bias.withExecutableEvidence, 1);
  assert.equal(r.bias.notAdmitted, 3);
  assert.equal(r.bias.unmeasuredFraction, 0.75);
  assert.ok(r.limitations.some((l) => /75%/.test(l)),
    "the excluded share must be stated in plain English, not only as a number");
  assert.ok(r.limitations.some((l) => /cannot describe/i.test(l)));
});

test("no movers and no evidence are distinguishable states", () => {
  const db = makeDb();
  assert.equal(measureExecutableOpportunityOnDb(db, { sessionDate: SESSION }).evidenceState, "NO_MOVERS");
  addMover(db, "MRNA");
  assert.equal(
    measureExecutableOpportunityOnDb(db, { sessionDate: SESSION }).evidenceState,
    "NO_EXECUTABLE_EVIDENCE",
  );
});

test("it spends no provider budget, so it runs when the cap is saturated", () => {
  const db = makeDb();
  addMover(db, "MRNA");
  addQuote(db, "MRNA");
  const r = measureExecutableOpportunityOnDb(db, { sessionDate: SESSION });
  assert.equal(r.providerRequests, 0);
  const src = readSource("lib/research/options/executable-opportunity.ts");
  for (const forbidden of ["fetchOptionChain", "fetchOptionContractSnapshot", "fetchCandles", "recordPolygonCall"]) {
    assert.equal(src.includes(forbidden), false, `${forbidden} would make this a quoting lane`);
  }
});

test("a missing table degrades to an empty report rather than throwing", () => {
  const bare = new Database(":memory:");
  const r = measureExecutableOpportunityOnDb(bare, { sessionDate: SESSION });
  assert.equal(r.evidenceState, "NO_MOVERS");
  assert.deepEqual(r.measurements, []);
});

// ---------------------------------------------------------------------------
// The frozen experiment is not disturbed
// ---------------------------------------------------------------------------

test("the frozen discovery definition is unchanged", () => {
  assert.equal(EXTREME_PREMARKET_DISCOVERY_V1_DEFINITION_HASH, "d173a8c4d28c479e71000482f0a39e30");
  assert.equal(checkExtremePremarketDiscoveryFrozen().frozen, true);
});

test("the PROSPECTIVE executable scope is still NOT STARTED and still blocked on budget", () => {
  const prospective = scopeFor("EXECUTABLE");
  assert.equal(prospective.started, false);
  assert.match(prospective.blockedBy, /[Pp]rovider budget/);
  assert.match(prospective.blockedBy, /PREREQUISITE/);
  // Its fields stay unclaimable. Measuring the quoted subset must not be allowed
  // to read as having measured every discovered mover.
  for (const f of ["firstExecutableNbboAtMs", "attainableMfePct", "tooLateRate", "selectionStrength"]) {
    assert.equal(isMeasurable(f), false, `${f} is a prospective claim and must stay unclaimable`);
  }
});

test("the shared-evidence scope is started, separate, and narrower by name", () => {
  const shared = scopeFor("EXECUTABLE_FROM_SHARED_EVIDENCE");
  assert.equal(shared.started, true);
  assert.equal(shared.blockedBy, null);
  // Every field it claims is prefixed `quoted`, so a reader cannot mistake it
  // for a statement about movers that were never quoted.
  for (const f of shared.measures) {
    assert.ok(/^quoted/.test(f) || f === "unmeasuredFraction",
      `${f} does not name itself as being about the quoted subset`);
  }
  assert.equal(MEASUREMENT_SCOPES.length, 3);
  assert.equal(MEASUREMENT_SCOPES.filter((s) => s.started).length, 2);
});

function readSource(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}
