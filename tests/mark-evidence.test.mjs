/**
 * tests/mark-evidence.test.mjs
 *
 * `recordObservedMark` sets MFE and MAE from MAX(return_pct) and MIN(return_pct) over
 * options_paper_marks. Over a real series that is correct. Over a series of ONE it makes
 * MFE and MAE identical, and the position's single mark is then reported as a full
 * excursion history. Production carries segments where 55-89% of priced rows are in
 * exactly that state, which is why the -7.2% expectancy and 59.9% immediate-failure
 * figures could not be trusted.
 *
 * These tests pin the rule that fixes it: an excursion is a statement about a PATH, and
 * one point is not a path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  classifyMarkEvidence,
  summariseMarkEvidence,
  excursionIsTrustworthy,
  MIN_MARKS_FOR_EXCURSION,
  EARLY_WINDOW_MS,
} from "../lib/research/options/mark-evidence.ts";
import { loadMarkEvidenceOnDb } from "../lib/research/options/mark-evidence-loader.ts";

const T0 = Date.parse("2026-08-06T14:00:00.000Z");
const mark = (offsetMs, returnPct) => ({
  markAtMs: T0 + offsetMs, returnPct, bid: 2, ask: 2.05, quoteAgeMs: 500,
});

const trade = (over = {}) => ({
  tradeId: 1,
  enteredAtMs: T0,
  exitAtMs: T0 + 60 * 60_000,
  status: "EXITED",
  entryFill: 2.22,
  marks: [],
  ...over,
});

// ── The exact artifact ──────────────────────────────────────────────────────

test("REPRODUCES THE ARTIFACT: one post-entry mark cannot yield MFE or MAE", () => {
  const e = classifyMarkEvidence(trade({ marks: [mark(60_000, -55.26)] }));
  assert.equal(e.state, "SINGLE_POST_ENTRY_MARK");
  assert.equal(e.distinctObservationTimes, 1);
  assert.equal(e.permissions.mfe, false);
  assert.equal(e.permissions.mae, false);
  assert.equal(e.permissions.attainment, false);
  assert.equal(e.verifiedMfePct, null, "no MFE may be derived from one point");
  assert.equal(e.verifiedMaePct, null);
  assert.match(e.reasons.join(" "), /MAX and MIN over one point are that point/);
  assert.equal(excursionIsTrustworthy(e.state), false);
});

test("a verified realized return survives even when the trajectory was never recorded", () => {
  // This is the other half of the honesty requirement: a real loss stays a real loss.
  const e = classifyMarkEvidence(trade({ marks: [] }));
  assert.equal(e.state, "ENTRY_ONLY");
  assert.equal(e.permissions.mfe, false);
  assert.equal(e.permissions.realizedReturn, true, "entry ask + recorded exit is enough for a return");
});

test("an open position with no exit cannot claim a realized return", () => {
  const e = classifyMarkEvidence(trade({ status: "ENTERED", exitAtMs: null, marks: [] }));
  assert.equal(e.permissions.realizedReturn, false);
});

// ── Two distinct observations is the floor ──────────────────────────────────

test("two DISTINCT observation times unlock MFE and MAE", () => {
  const e = classifyMarkEvidence(trade({
    marks: [mark(60_000, -20), mark(30 * 60_000, 45)],
  }));
  assert.equal(e.distinctObservationTimes, MIN_MARKS_FOR_EXCURSION);
  assert.equal(e.permissions.mfe, true);
  assert.equal(e.verifiedMfePct, 45);
  assert.equal(e.verifiedMaePct, -20);
  assert.notEqual(e.verifiedMfePct, e.verifiedMaePct, "a real excursion has two different ends");
});

test("two marks at the SAME instant are one observation, not two", () => {
  const e = classifyMarkEvidence(trade({
    marks: [mark(60_000, -20), mark(60_000, -20)],
  }));
  assert.equal(e.markCount, 2);
  assert.equal(e.distinctObservationTimes, 1, "duplicate timestamps do not make a path");
  assert.equal(e.state, "SINGLE_POST_ENTRY_MARK");
  assert.equal(e.permissions.mfe, false);
});

test("marks at or before entry are not post-entry observations", () => {
  const e = classifyMarkEvidence(trade({
    marks: [mark(-5_000, 0), mark(0, 0)],
  }));
  assert.equal(e.state, "ENTRY_ONLY");
  assert.equal(e.usablePostEntryMarks, 0);
});

// ── Immediate failure needs EARLY evidence specifically ─────────────────────

test("immediate-failure needs early marks, not merely many marks", () => {
  // Dense marking, but it all starts an hour in. That answers a different question.
  const late = classifyMarkEvidence(trade({
    exitAtMs: T0 + 4 * 60 * 60_000,
    marks: [mark(60 * 60_000, 5), mark(90 * 60_000, 10), mark(120 * 60_000, 8)],
  }));
  assert.equal(late.permissions.mfe, true, "excursion is fine");
  assert.equal(late.permissions.immediateFailure, false, "but the early window is unobserved");
  assert.match(late.reasons.join(" "), /too few to claim what happened early/);

  const early = classifyMarkEvidence(trade({
    marks: [mark(60_000, -3), mark(5 * 60_000, -4), mark(30 * 60_000, 20)],
  }));
  assert.equal(early.earlyMarks, 2);
  assert.equal(early.permissions.immediateFailure, true);
});

test("the early window is 15 minutes", () => {
  assert.equal(EARLY_WINDOW_MS, 15 * 60_000);
});

// ── Coverage and states ─────────────────────────────────────────────────────

test("dense marking through to a recorded exit is COMPLETE_TO_EXIT", () => {
  const marks = [1, 3, 5, 10, 15, 30, 45, 55].map((m) => mark(m * 60_000, m));
  const e = classifyMarkEvidence(trade({ marks }));
  assert.equal(e.state, "COMPLETE_TO_EXIT");
  assert.ok(e.coverage > 0.6);
  assert.equal(e.permissions.mfe, true);
  assert.equal(e.permissions.immediateFailure, true);
  assert.equal(excursionIsTrustworthy(e.state), true);
});

test("sparse marking over a long hold is MULTI_MARK_PARTIAL and says so", () => {
  const e = classifyMarkEvidence(trade({
    exitAtMs: T0 + 6 * 60 * 60_000,
    marks: [mark(60_000, -5), mark(3 * 60_000, -8)],
  }));
  assert.equal(e.state, "MULTI_MARK_PARTIAL");
  assert.ok(e.coverage < 0.1);
  assert.match(e.reasons.join(" "), /span \d+% of the holding period/);
  assert.equal(excursionIsTrustworthy(e.state), true, "partial is still a real path");
});

test("a known blocker is reported as itself, not as missing data", () => {
  for (const b of ["QUOTE_UNAVAILABLE", "PROVIDER_BUDGET_BLOCKED", "LEGACY_NO_MARKING"]) {
    const e = classifyMarkEvidence(trade({ knownBlocker: b, marks: [] }));
    assert.equal(e.state, b, "a skipped mark must never be silently recorded as absent data");
    assert.equal(e.permissions.mfe, false);
  }
});

test("unusable timestamps are named, not treated as no marks", () => {
  const e = classifyMarkEvidence(trade({
    marks: [{ markAtMs: null, returnPct: 5, bid: 1, ask: 1.1, quoteAgeMs: 0 }],
  }));
  assert.equal(e.state, "INVALID_TIMESTAMPS");
});

// ── Aggregation ─────────────────────────────────────────────────────────────

test("the distribution separates trustworthy excursions from the rest", () => {
  const rows = [
    classifyMarkEvidence(trade({ tradeId: 1, marks: [mark(60_000, -55)] })),
    classifyMarkEvidence(trade({ tradeId: 2, marks: [mark(60_000, -55)] })),
    classifyMarkEvidence(trade({ tradeId: 3, marks: [mark(60_000, -5), mark(30 * 60_000, 40)] })),
  ];
  const s = summariseMarkEvidence(rows);
  assert.equal(s.total, 3);
  assert.equal(s.excursionTrustworthy, 1);
  assert.equal(s.excursionUntrustworthy, 2);
  assert.equal(s.realizedUsable, 3, "all three have a verified realized return");
  assert.equal(s.byState.SINGLE_POST_ENTRY_MARK, 2);
});

// ── Loader against a real schema ────────────────────────────────────────────

function db() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE options_paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT NOT NULL, side TEXT, strike REAL,
      expiration TEXT, dte INTEGER, result_class TEXT NOT NULL, entry_fill REAL, strategy TEXT,
      status TEXT NOT NULL, return_pct REAL, mfe_pct REAL, mae_pct REAL,
      entered_at_ms INTEGER, exit_at_ms INTEGER, paper_kind TEXT,
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE options_paper_marks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, trade_id INTEGER NOT NULL, option_symbol TEXT NOT NULL,
      mark_at_ms INTEGER NOT NULL, bid REAL, ask REAL, exit_fill REAL, return_pct REAL,
      quote_age_ms INTEGER, created_at_ms INTEGER NOT NULL, UNIQUE(trade_id, mark_at_ms)
    );
  `);
  return d;
}

const insertTrade = (d, id, over = {}) => d.prepare(
  `INSERT INTO options_paper_trades
     (id, option_symbol, result_class, entry_fill, strategy, status, return_pct, mfe_pct, mae_pct,
      entered_at_ms, exit_at_ms, paper_kind, created_at_ms, updated_at_ms)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
).run(
  id, "O:SPY260807P00770000", "REAL_OPTION_PAPER", 2.22,
  over.strategy ?? "lower_high_continuation", over.status ?? "EXITED",
  over.returnPct ?? -55.26, over.mfePct ?? -55.26, over.maePct ?? -55.26,
  T0, over.exitAtMs ?? T0 + 3_600_000, over.lane ?? "DELIVERED_ALERT_PAPER", T0, T0,
);

test("loader classifies the real production shape: one mark, stored MFE == stored MAE", () => {
  const d = db();
  insertTrade(d, 1);
  d.prepare(
    `INSERT INTO options_paper_marks (trade_id, option_symbol, mark_at_ms, bid, ask, exit_fill, return_pct, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(1, "O:SPY260807P00770000", T0 + 60_000, 0.99, 1.02, 0.99, -55.26, T0);

  const rows = loadMarkEvidenceOnDb(d, {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "SINGLE_POST_ENTRY_MARK");
  assert.equal(rows[0].storedMfePct, rows[0].storedMaePct, "the stored fields are identical — the artifact");
  assert.equal(rows[0].verifiedMfePct, null, "and the evidence supports neither");
  assert.equal(rows[0].permissions.realizedReturn, true, "the -55.26% return is still real");
});

test("loader handles a database with no marks table at all", () => {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE options_paper_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT NOT NULL, result_class TEXT NOT NULL,
    entry_fill REAL, strategy TEXT, status TEXT NOT NULL, return_pct REAL, mfe_pct REAL, mae_pct REAL,
    entered_at_ms INTEGER, exit_at_ms INTEGER, paper_kind TEXT,
    created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);`);
  insertTrade(d, 1);
  const rows = loadMarkEvidenceOnDb(d, {});
  assert.equal(rows[0].state, "LEGACY_NO_MARKING");
});

test("loader returns empty rather than throwing on a database with no paper table", () => {
  assert.deepEqual(loadMarkEvidenceOnDb(new Database(":memory:"), {}), []);
});
