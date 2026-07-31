/**
 * tests/high-asymmetry-loader.test.mjs — the read-only cohort loader.
 *
 * Proves the loader reads persisted facts only, matches marks by exact OCC,
 * degrades honestly when a table or a field has no source, and never invents a
 * value to fill a gap.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { loadAsymmetryCohortOnDb, KNOWN_UNSOURCED_FIELDS } from "../lib/research/asymmetry/loader.ts";

const DAY = "2026-07-30";
const T = Date.parse("2026-07-30T14:00:00Z"); // 10:00 ET
const OCC = "AAPL260731C00150000";

function db({ withMarks = true } = {}) {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE options_research_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, observed_at_ms INTEGER, session_date TEXT, symbol TEXT,
    direction TEXT, strategy_family TEXT, candidate_state TEXT, blockers_json TEXT,
    underlying_price REAL, support_level REAL, resistance_level REAL, trigger_level REAL,
    option_symbol TEXT, option_type TEXT, strike REAL, expiration TEXT, option_bid REAL, option_ask REAL,
    quote_timestamp_ms INTEGER, quote_age_ms INTEGER, volume REAL, open_interest REAL, delta REAL,
    dte INTEGER, source TEXT, freshness_state TEXT);`);
  if (withMarks) {
    d.exec(`CREATE TABLE options_paper_marks (
      trade_id INTEGER, option_symbol TEXT, mark_at_ms INTEGER, bid REAL, ask REAL,
      quote_age_ms INTEGER, created_at_ms INTEGER);`);
  }
  return d;
}

const insertObservation = (d, over = {}) => {
  const row = {
    observed_at_ms: T, session_date: DAY, symbol: "AAPL", direction: "bullish",
    strategy_family: "DAILY_BREAKOUT", candidate_state: "READY", blockers_json: null,
    underlying_price: 150, support_level: null, resistance_level: null, trigger_level: 151,
    option_symbol: OCC, option_type: "call", strike: 150, expiration: "2026-07-31",
    option_bid: 1.00, option_ask: 1.10, quote_timestamp_ms: T - 5_000, quote_age_ms: 5_000,
    volume: 500, open_interest: 250, delta: 0.5, dte: 1, source: "provider:chain", freshness_state: "FRESH",
    ...over,
  };
  d.prepare(`INSERT INTO options_research_observations (
    observed_at_ms, session_date, symbol, direction, strategy_family, candidate_state, blockers_json,
    underlying_price, support_level, resistance_level, trigger_level, option_symbol, option_type,
    strike, expiration, option_bid, option_ask, quote_timestamp_ms, quote_age_ms, volume,
    open_interest, delta, dte, source, freshness_state
  ) VALUES (${new Array(25).fill("?").join(",")})`).run(...Object.values(row));
  return row;
};

const insertMark = (d, over = {}) => {
  const row = {
    trade_id: 1, option_symbol: OCC, mark_at_ms: T + 5 * 60_000, bid: 3.00, ask: 3.10,
    quote_age_ms: 1_000, created_at_ms: T + 5 * 60_000, ...over,
  };
  d.prepare("INSERT INTO options_paper_marks VALUES (?,?,?,?,?,?,?)").run(...Object.values(row));
};

test("an invalid session date fails before any read", () => {
  assert.throws(() => loadAsymmetryCohortOnDb(db(), { sessionDate: "bad" }), /YYYY-MM-DD/);
});

test("a missing observations table yields an empty cohort and a warning, never a throw", () => {
  const d = new Database(":memory:");
  const out = loadAsymmetryCohortOnDb(d, { sessionDate: DAY, evaluationAtMs: T + 60 * 60_000 });
  assert.equal(out.cohortSize, 0);
  assert.equal(out.report.candidates.length, 0);
  assert.ok(out.warnings.some((w) => /options_research_observations unavailable/.test(w)));
  assert.equal(out.report.productionBehaviorChanged, false);
});

test("a missing marks table leaves outcomes ungraded rather than guessed", () => {
  const d = db({ withMarks: false });
  insertObservation(d);
  const out = loadAsymmetryCohortOnDb(d, { sessionDate: DAY, evaluationAtMs: T + 60 * 60_000 });
  assert.equal(out.cohortSize, 1);
  assert.equal(out.report.candidates[0].label, "INSUFFICIENT_EVIDENCE");
  assert.equal(out.report.candidates[0].outcome.mfePct, null);
  assert.ok(out.warnings.some((w) => /options_paper_marks unavailable/.test(w)));
});

test("a candidate is graded from exact-OCC marks and carries a shadow state", () => {
  const d = db();
  insertObservation(d);
  insertMark(d);
  const out = loadAsymmetryCohortOnDb(d, { sessionDate: DAY, evaluationAtMs: T + 60 * 60_000 });

  assert.equal(out.cohortSize, 1);
  const candidate = out.report.candidates[0];
  assert.equal(candidate.symbol, "AAPL");
  assert.equal(candidate.evidence.occSymbol, OCC);
  assert.equal(candidate.label, "OUTSIZED_100", "entry ask 1.10 → bid 3.00 is +172%");
  assert.equal(candidate.outcome.usableMarkCount, 1);
  assert.equal(candidate.canSend, false);
  assert.equal(candidate.notSubscriberReady, true);
  assert.equal(out.report.outsizedCount, 1);
});

test("a mark for a different contract cannot be attributed to this candidate", () => {
  const d = db();
  insertObservation(d);
  insertMark(d, { option_symbol: "AAPL260731P00150000", bid: 9.00, ask: 9.10 });
  const out = loadAsymmetryCohortOnDb(d, { sessionDate: DAY, evaluationAtMs: T + 60 * 60_000 });
  assert.equal(out.report.candidates[0].label, "INSUFFICIENT_EVIDENCE");
  assert.equal(out.report.candidates[0].outcome.usableMarkCount, 0);
});

test("an observation with no provider quote timestamp is refused, not assumed current", () => {
  const d = db();
  insertObservation(d, { quote_timestamp_ms: null, quote_age_ms: null });
  insertMark(d);
  const out = loadAsymmetryCohortOnDb(d, { sessionDate: DAY, evaluationAtMs: T + 60 * 60_000 });
  const candidate = out.report.candidates[0];
  assert.equal(candidate.evidence.ask, null);
  assert.equal(candidate.evidence.quoteRejection, "QUOTE_TIMESTAMP_UNAVAILABLE");
  assert.equal(candidate.state, "INSUFFICIENT_EVIDENCE");
  assert.equal(candidate.label, "INSUFFICIENT_EVIDENCE");
});

test("the earliest observation of a contract anchors the premium chase", () => {
  const d = db();
  insertObservation(d, { observed_at_ms: T - 10 * 60_000, quote_timestamp_ms: T - 10 * 60_000 - 5_000, option_bid: 0.85, option_ask: 0.90 });
  insertObservation(d, { observed_at_ms: T, quote_timestamp_ms: T - 5_000, option_bid: 1.00, option_ask: 1.10 });
  const out = loadAsymmetryCohortOnDb(d, { sessionDate: DAY, evaluationAtMs: T + 60 * 60_000 });

  const candidate = out.report.candidates[0];
  assert.equal(candidate.evidence.detectionAtMs, T - 10 * 60_000, "the FIRST observation is the candidate");
  assert.equal(candidate.chase.earliestAsk, 0.90);
  assert.equal(candidate.premiumChasePct, 0, "at its own first sighting nothing has been chased yet");
});

test("fields with no persisted source stay missing and are declared", () => {
  const d = db();
  insertObservation(d);
  insertMark(d);
  const out = loadAsymmetryCohortOnDb(d, { sessionDate: DAY, evaluationAtMs: T + 60 * 60_000 });
  const evidence = out.report.candidates[0].evidence;

  for (const field of ["stockVolume", "relativeStockVolume", "volumeAcceleration", "impliedVolatility", "gamma", "relativeStrengthVsSpyPct"]) {
    assert.equal(evidence[field], null, `${field} has no source and must stay null`);
    assert.ok(evidence.missing[field], `${field} must record why it is missing`);
  }
  assert.equal(evidence.catalystState, "ABSENT_OR_UNKNOWN");
  assert.deepEqual(out.knownUnsourcedFields, [...KNOWN_UNSOURCED_FIELDS]);
  assert.ok(out.report.coverage.missingByField.relativeStockVolume.count >= 1);
});

test("observations after the evaluation time are not read at all", () => {
  const d = db();
  insertObservation(d, { observed_at_ms: T + 30 * 60_000 });
  const out = loadAsymmetryCohortOnDb(d, { sessionDate: DAY, evaluationAtMs: T });
  assert.equal(out.cohortSize, 0);
  assert.ok(out.warnings.some((w) => /No research observations recorded/.test(w)));
});

test("the loader performs no writes", () => {
  const d = db();
  insertObservation(d);
  insertMark(d);
  const before = {
    observations: d.prepare("SELECT COUNT(*) c FROM options_research_observations").get().c,
    marks: d.prepare("SELECT COUNT(*) c FROM options_paper_marks").get().c,
    tables: d.prepare("SELECT COUNT(*) c FROM sqlite_master").get().c,
  };
  loadAsymmetryCohortOnDb(d, { sessionDate: DAY, evaluationAtMs: T + 60 * 60_000 });
  assert.deepEqual({
    observations: d.prepare("SELECT COUNT(*) c FROM options_research_observations").get().c,
    marks: d.prepare("SELECT COUNT(*) c FROM options_paper_marks").get().c,
    tables: d.prepare("SELECT COUNT(*) c FROM sqlite_master").get().c,
  }, before);
});
