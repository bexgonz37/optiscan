/**
 * tests/high-asymmetry-replay.test.mjs — the real-data replay contract.
 *
 * Proves the replay cannot use future observations, cannot cross sessions,
 * keeps exact OCC mandatory, excludes stale and after-hours evidence, is
 * idempotent, writes nothing, and never reports an empty cohort as a result.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { runAsymmetryReplayOnDb, replayCoverageSummary } from "../lib/research/asymmetry/replay.ts";
import { EXCLUSION_REASONS } from "../lib/research/asymmetry/coverage-audit.ts";

const DAY = "2026-07-30";
const T = Date.parse("2026-07-30T14:00:00Z"); // 10:00 ET
const OCC = "AAPL260731C00150000";
const HORIZON = T + 6 * 60 * 60_000;

function db({ withMarks = true } = {}) {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE options_research_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, observed_at_ms INTEGER, session_date TEXT, symbol TEXT,
    direction TEXT, thesis_fingerprint TEXT, alert_id TEXT, strategy_family TEXT, candidate_state TEXT,
    blockers_json TEXT, underlying_price REAL, support_level REAL, resistance_level REAL, trigger_level REAL,
    option_symbol TEXT, option_type TEXT, strike REAL, expiration TEXT, option_bid REAL, option_ask REAL,
    spread_pct REAL, quote_timestamp_ms INTEGER, quote_age_ms INTEGER, volume REAL, open_interest REAL,
    delta REAL, dte INTEGER, source TEXT, freshness_state TEXT);`);
  if (withMarks) {
    d.exec(`CREATE TABLE options_paper_marks (
      trade_id INTEGER, option_symbol TEXT, mark_at_ms INTEGER, bid REAL, ask REAL,
      quote_age_ms INTEGER, created_at_ms INTEGER);`);
  }
  return d;
}

const observe = (d, over = {}) => {
  const row = {
    observed_at_ms: T, session_date: DAY, symbol: "AAPL", direction: "bullish",
    thesis_fingerprint: null, alert_id: null, strategy_family: "DAILY_BREAKOUT",
    candidate_state: "READY", blockers_json: null, underlying_price: 150,
    support_level: null, resistance_level: null, trigger_level: 151,
    option_symbol: OCC, option_type: "call", strike: 150, expiration: "2026-07-31",
    option_bid: 1.00, option_ask: 1.10, spread_pct: 9, quote_timestamp_ms: T - 5_000,
    quote_age_ms: 5_000, volume: 500, open_interest: 250, delta: 0.5, dte: 1,
    source: "provider:chain", freshness_state: "FRESH", ...over,
  };
  d.prepare(`INSERT INTO options_research_observations (
    observed_at_ms, session_date, symbol, direction, thesis_fingerprint, alert_id, strategy_family,
    candidate_state, blockers_json, underlying_price, support_level, resistance_level, trigger_level,
    option_symbol, option_type, strike, expiration, option_bid, option_ask, spread_pct,
    quote_timestamp_ms, quote_age_ms, volume, open_interest, delta, dte, source, freshness_state
  ) VALUES (${new Array(28).fill("?").join(",")})`).run(...Object.values(row));
  return row;
};

const mark = (d, over = {}) => {
  const row = {
    trade_id: 1, option_symbol: OCC, mark_at_ms: T + 5 * 60_000, bid: 3.00, ask: 3.10,
    quote_age_ms: 1_000, created_at_ms: T + 5 * 60_000, ...over,
  };
  d.prepare("INSERT INTO options_paper_marks VALUES (?,?,?,?,?,?,?)").run(...Object.values(row));
};

test("an empty database reports absent evidence, never a zero result", () => {
  const result = runAsymmetryReplayOnDb(db(), { evaluationAtMs: HORIZON });
  assert.equal(result.readOnly, true);
  assert.equal(result.writesPerformed, 0);
  assert.equal(result.coverage.totalObservations, 0);
  assert.equal(result.coverage.gradeableCandidates, 0);
  assert.equal(result.report.outsizedCount, 0);
  assert.equal(result.report.cohortComparison.outcomeRates.OUTSIZED.sharePct, null,
    "a share of nothing is unknown, not 0%");
  assert.equal(replayCoverageSummary(result).gradeableSharePct, null);
  assert.equal(result.duplicateAudit.recommendation, "INSUFFICIENT_EVIDENCE");
  assert.ok(result.notes.some((note) => /evidence is absent, not that the strategy performed at zero/i.test(note)));
  assert.equal(/profitable|guaranteed|will produce/i.test(JSON.stringify(result)), false);
});

test("a real candidate replays and grades from exact-OCC marks", () => {
  const d = db();
  observe(d);
  mark(d);
  const result = runAsymmetryReplayOnDb(d, { evaluationAtMs: HORIZON });

  assert.deepEqual(result.sessionsWithData, [DAY]);
  assert.equal(result.coverage.distinctCandidateDetections, 1);
  assert.equal(result.coverage.gradeableCandidates, 1);
  assert.equal(result.coverage.candidatesWithFreshAskEntry, 1);
  assert.equal(result.report.outcomeCounts.OUTSIZED_100, 1, "entry ask 1.10 → bid 3.00 is +172%");

  const row = result.rows[0];
  assert.equal(row.symbol, "AAPL");
  assert.equal(row.occSymbol, OCC);
  assert.equal(row.entryAsk, 1.10);
  assert.equal(row.peakVerifiedBid, 3.00);
  assert.equal(row.exclusionReason, null);
  assert.equal(row.usableMarkCount, 1);
});

test("observations after the evidence horizon cannot be read", () => {
  const d = db();
  observe(d);
  mark(d, { mark_at_ms: T + 5 * 60_000, bid: 1.20, ask: 1.25 });
  mark(d, { mark_at_ms: T + 90 * 60_000, bid: 9.00, ask: 9.10 });

  const early = runAsymmetryReplayOnDb(d, { evaluationAtMs: T + 30 * 60_000 });
  assert.equal(early.report.outcomeCounts.FLAT, 1, "the later +700% mark is not yet knowable");
  assert.equal(early.rows[0].mfePct, 9.0909, "only the +9% mark is in evidence");

  const later = runAsymmetryReplayOnDb(d, { evaluationAtMs: T + 120 * 60_000 });
  assert.equal(later.report.outcomeCounts.OUTSIZED_500, 1, "once past, the same mark grades normally");
});

test("a candidate cannot be graded by a mark from another session", () => {
  const d = db();
  observe(d);
  // Same contract, same clock time, but the NEXT trading day.
  mark(d, { mark_at_ms: Date.parse("2026-07-31T14:05:00Z"), bid: 9.00, ask: 9.10 });
  const result = runAsymmetryReplayOnDb(d, { evaluationAtMs: Date.parse("2026-08-01T00:00:00Z") });

  assert.equal(result.coverage.gradeableCandidates, 0);
  assert.equal(result.coverage.exclusions.MISSING_SUBSEQUENT_BID, 1);
  assert.equal(result.report.outsizedCount, 0, "a next-session mark must not create an outsized move");
});

test("exact OCC stays mandatory and a wrong OCC is attributed, not dropped", () => {
  const missing = db();
  observe(missing, { option_symbol: null });
  const missingResult = runAsymmetryReplayOnDb(missing, { evaluationAtMs: HORIZON });
  assert.equal(missingResult.coverage.exclusions.MISSING_OCC, 1);
  assert.equal(missingResult.coverage.observationsWithoutContract, 1);
  assert.equal(missingResult.coverage.distinctCandidateDetections, 1,
    "a contract-less detection stays in the denominator");

  const wrong = db();
  observe(wrong, { strike: 155 }); // disagrees with the OCC's 150 strike
  const wrongResult = runAsymmetryReplayOnDb(wrong, { evaluationAtMs: HORIZON });
  assert.equal(wrongResult.coverage.exclusions.WRONG_OCC, 1);
  assert.equal(wrongResult.coverage.gradeableCandidates, 0);
});

test("stale and after-hours entry evidence are excluded with distinct reasons", () => {
  const stale = db();
  observe(stale, { quote_timestamp_ms: T - 25 * 60_000, quote_age_ms: 25 * 60_000 });
  assert.equal(runAsymmetryReplayOnDb(stale, { evaluationAtMs: HORIZON }).coverage.exclusions.STALE_QUOTE, 1);

  const afterHours = db();
  const evening = Date.parse("2026-07-30T23:00:00Z"); // 19:00 ET
  observe(afterHours, { observed_at_ms: evening, quote_timestamp_ms: evening - 5_000 });
  const out = runAsymmetryReplayOnDb(afterHours, { evaluationAtMs: HORIZON + 24 * 60 * 60_000 });
  assert.equal(out.coverage.exclusions.AFTER_HOURS_EVIDENCE, 1);
});

test("every ungradeable candidate is attributed to exactly one reason", () => {
  const d = db();
  observe(d, { option_symbol: null });
  observe(d, { strike: 155 });
  observe(d, { option_symbol: "MSFT260731C00400000", symbol: "MSFT", strike: 400, quote_timestamp_ms: T - 25 * 60_000, quote_age_ms: 25 * 60_000 });
  const result = runAsymmetryReplayOnDb(d, { evaluationAtMs: HORIZON });

  const attributed = Object.values(result.coverage.exclusions).reduce((a, b) => a + b, 0);
  assert.equal(attributed, result.coverage.ungradeableCandidates,
    "exclusion counts must sum exactly to the ungradeable population");
  assert.equal(result.coverage.gradeableCandidates + result.coverage.ungradeableCandidates,
    result.coverage.distinctCandidateDetections);
  for (const reason of EXCLUSION_REASONS) {
    assert.equal(typeof result.coverage.exclusions[reason], "number", `${reason} must always be reported`);
  }
});

test("horizon coverage records absence as false, never as a zero return", () => {
  const d = db();
  observe(d);
  mark(d, { mark_at_ms: T + 2 * 60_000, bid: 1.30, ask: 1.35 });
  const result = runAsymmetryReplayOnDb(d, { evaluationAtMs: HORIZON });

  assert.equal(result.coverage.gradeableByHorizon["1m"], 1);
  assert.equal(result.coverage.gradeableByHorizon["5m"], 0);
  assert.equal(result.coverage.gradeableByHorizon["60m"], 0);
  assert.equal(result.report.candidates[0].outcome.returnsByHorizon["5m"], null,
    "an unobserved horizon is null, not 0%");
});

test("repeated replay is idempotent and performs no writes", () => {
  const d = db();
  observe(d);
  mark(d);
  const before = {
    observations: d.prepare("SELECT COUNT(*) c FROM options_research_observations").get().c,
    marks: d.prepare("SELECT COUNT(*) c FROM options_paper_marks").get().c,
    tables: d.prepare("SELECT COUNT(*) c FROM sqlite_master").get().c,
  };

  const first = runAsymmetryReplayOnDb(d, { evaluationAtMs: HORIZON });
  const second = runAsymmetryReplayOnDb(d, { evaluationAtMs: HORIZON });
  assert.deepEqual(second, first, "the same database and horizon must produce identical output");
  assert.equal(first.writesPerformed, 0);

  assert.deepEqual({
    observations: d.prepare("SELECT COUNT(*) c FROM options_research_observations").get().c,
    marks: d.prepare("SELECT COUNT(*) c FROM options_paper_marks").get().c,
    tables: d.prepare("SELECT COUNT(*) c FROM sqlite_master").get().c,
  }, before);
});

test("the replay works against a genuinely readonly database handle", () => {
  const file = join(tmpdir(), `asymmetry-replay-${process.pid}-${Date.now()}.db`);
  const writable = new Database(file);
  writable.exec(`CREATE TABLE options_research_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, observed_at_ms INTEGER, session_date TEXT, symbol TEXT,
    direction TEXT, thesis_fingerprint TEXT, alert_id TEXT, strategy_family TEXT, candidate_state TEXT,
    blockers_json TEXT, underlying_price REAL, support_level REAL, resistance_level REAL, trigger_level REAL,
    option_symbol TEXT, option_type TEXT, strike REAL, expiration TEXT, option_bid REAL, option_ask REAL,
    spread_pct REAL, quote_timestamp_ms INTEGER, quote_age_ms INTEGER, volume REAL, open_interest REAL,
    delta REAL, dte INTEGER, source TEXT, freshness_state TEXT);`);
  observe(writable);
  writable.close();

  // If the replay attempted any write at all, sqlite would throw here.
  const readonly = new Database(file, { readonly: true, fileMustExist: true });
  const result = runAsymmetryReplayOnDb(readonly, { evaluationAtMs: HORIZON });
  assert.equal(result.coverage.distinctCandidateDetections, 1);
  assert.equal(result.writesPerformed, 0);
  readonly.close();

  for (const suffix of ["", "-wal", "-shm"]) {
    try { rmSync(`${file}${suffix}`, { force: true }); } catch { /* best effort */ }
  }
});

test("an absent marks table leaves outcomes ungraded rather than guessed", () => {
  const d = db({ withMarks: false });
  observe(d);
  const result = runAsymmetryReplayOnDb(d, { evaluationAtMs: HORIZON });
  assert.equal(result.coverage.exclusions.MISSING_SUBSEQUENT_BID, 1);
  assert.equal(result.report.outcomeCounts.INSUFFICIENT_EVIDENCE, 1);
  assert.equal(result.rows[0].mfePct, null);
  assert.ok(result.warnings.some((w) => /options_paper_marks unavailable/.test(w)));
});
