/**
 * tests/historical-realized-outcomes.test.mjs
 *
 * HIST_REALIZED_V1 — the join between a historical winner event and what the governing
 * exit policy actually captured.
 *
 * Two failures are being guarded against, and both produce a better-looking number than
 * the truth:
 *
 *   · a realized return inferred from the maximum favourable excursion, which reports
 *     every trade at its best moment and yields an equity curve no account produced
 *   · a join made on the OCC alone, which attaches a return from one decision to a
 *     different decision that happened to select the same liquid contract that week
 *
 * Most assertions below check that a value is ABSENT or that a state is UNAVAILABLE.
 * UNAVAILABLE is a statement about our records; it is always preferable to an inference.
 */
import "./helpers/register-alias.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  realizedOutcomeForEvent,
  realizedOutcomesForEvents,
  realizedStats,
  REALIZED_OUTCOME_VERSION,
  ENTRY_MATCH_TOLERANCE,
} from "../lib/research/historical/realized-outcomes.ts";
import { tradingSessionsBetween } from "../lib/research/historical/trading-sessions.ts";

const T0 = Date.parse("2026-08-03T14:30:00Z");

/**
 * A minimal stand-in for the SQLite handle.
 *
 * Deliberately not a real database: these tests are about the identity ARGUMENT, and a
 * fixture that answers queries directly makes each rule's failure isolable.
 */
function fakeDb({ cases = {}, trades = [], tables = ["options_paper_trades", "opportunity_cases"] } = {}) {
  return {
    prepare(sql) {
      if (sql.includes("sqlite_master")) {
        return { get: (name) => (tables.includes(name) ? { 1: 1 } : undefined) };
      }
      if (sql.includes("FROM opportunity_cases")) {
        return { get: (id) => (cases[id] ? { alert_id: cases[id] } : undefined) };
      }
      if (sql.includes("FROM options_paper_trades")) {
        return { all: (alertId) => trades.filter((t) => t.alert_id === alertId) };
      }
      return { get: () => undefined, all: () => [] };
    },
  };
}

function event(over = {}) {
  return {
    version: "HIST_WINNER_V1",
    eventId: "we_TEST_1",
    occ: "O:NVDA260807C00180000",
    symbol: "NVDA",
    side: "call",
    strike: 180,
    expiration: "2026-08-07",
    sessionDate: "2026-08-03",
    opportunityCaseId: "oc_1",
    entryAtMs: T0,
    entryConvention: "ASK at T",
    entryPrice: 2.5,
    windowToMs: T0 + 6 * 3600_000,
    quotesUsed: 900,
    peakMilestone: 100,
    msToMilestone: { 10: 1000, 25: 2000, 50: 3000, 100: 4000, 200: null },
    // A big favourable excursion, deliberately. If any code path leaks MFE into a
    // realized return, these fixtures make it obvious.
    mfePct: 185,
    maePct: -8,
    evidenceQuality: "VERIFIED",
    note: "",
    ...over,
  };
}

function trade(over = {}) {
  return {
    id: 1,
    option_symbol: "O:NVDA260807C00180000",
    entry_fill: 2.5,
    exit_fill: 3.0,
    return_pct: 20,
    status: "CLOSED",
    exit_reason: "TARGET",
    entered_at_ms: T0 + 30_000,
    exit_at_ms: T0 + 3600_000,
    alert_id: "al_1",
    paper_kind: "DELIVERED_ALERT_PAPER",
    ...over,
  };
}

// ── the join, rule by rule ───────────────────────────────────────────────────

test("a proven identity yields a realized return recomputed from the fills", () => {
  const db = fakeDb({ cases: { oc_1: "al_1" }, trades: [trade()] });
  const r = realizedOutcomeForEvent(db, event());
  assert.equal(r.version, REALIZED_OUTCOME_VERSION);
  assert.equal(r.evidenceState, "VERIFIED_REALIZED");
  assert.equal(r.state, "WIN");
  assert.equal(r.paperTradeId, 1);
  assert.equal(r.realizedReturnPct, 20, "(3.0 - 2.5) / 2.5");
  assert.equal(r.matchedOn.length, 4, "all four identity rules are recorded");
  assert.equal(r.refusal, null);
});

test("a realized return is never the excursion", () => {
  const db = fakeDb({ cases: { oc_1: "al_1" }, trades: [trade()] });
  const r = realizedOutcomeForEvent(db, event({ mfePct: 185, peakMilestone: 100 }));
  assert.equal(r.realizedReturnPct, 20);
  assert.notEqual(r.realizedReturnPct, 185, "MFE must never become the realized return");
  assert.ok(/never/i.test(r.convention), "the row states the convention it used");
});

test("a stored return_pct is not trusted over the fills", () => {
  // A stored percentage that disagrees with its own prices is the kind of drift that
  // survives for months. The fills are the record.
  const db = fakeDb({ cases: { oc_1: "al_1" }, trades: [trade({ return_pct: 900 })] });
  const r = realizedOutcomeForEvent(db, event());
  assert.equal(r.realizedReturnPct, 20, "recomputed, not read");
});

test("a loss is recorded as a loss, not withheld", () => {
  const db = fakeDb({ cases: { oc_1: "al_1" }, trades: [trade({ exit_fill: 1.25, exit_reason: "STOP" })] });
  const r = realizedOutcomeForEvent(db, event());
  assert.equal(r.state, "LOSS");
  assert.equal(r.realizedReturnPct, -50);
  assert.equal(r.evidenceState, "VERIFIED_REALIZED", "a loss is verified evidence too");
  assert.equal(r.exitReason, "STOP");
});

test("an event with no case id refuses rather than joining on the OCC alone", () => {
  const db = fakeDb({ cases: { oc_1: "al_1" }, trades: [trade()] });
  const r = realizedOutcomeForEvent(db, event({ opportunityCaseId: null }));
  assert.equal(r.evidenceState, "UNAVAILABLE");
  assert.equal(r.refusal, "NO_CASE_ID_ON_EVENT");
  assert.equal(r.realizedReturnPct, null);
  assert.ok(/same contract/.test(r.note), "the refusal explains the risk it is avoiding");
});

test("a mirror on a different contract is refused, never measured", () => {
  const db = fakeDb({
    cases: { oc_1: "al_1" },
    trades: [trade({ option_symbol: "O:NVDA260807C00185000" })],
  });
  const r = realizedOutcomeForEvent(db, event());
  assert.equal(r.refusal, "OCC_MISMATCH");
  assert.equal(r.realizedReturnPct, null);
});

test("a different entry price is a different decision", () => {
  const db = fakeDb({ cases: { oc_1: "al_1" }, trades: [trade({ entry_fill: 3.4 })] });
  const r = realizedOutcomeForEvent(db, event({ entryPrice: 2.5 }));
  assert.equal(r.refusal, "ENTRY_FILL_MISMATCH");
  assert.equal(r.realizedReturnPct, null);

  // Just inside tolerance still joins: a cent of rounding is not a different trade.
  const near = fakeDb({
    cases: { oc_1: "al_1" },
    trades: [trade({ entry_fill: 2.5 + ENTRY_MATCH_TOLERANCE / 2 })],
  });
  assert.equal(realizedOutcomeForEvent(near, event()).evidenceState, "VERIFIED_REALIZED");
});

test("a re-entry hours later is not this event's outcome", () => {
  const db = fakeDb({
    cases: { oc_1: "al_1" },
    trades: [trade({ entered_at_ms: T0 + 4 * 3600_000 })],
  });
  const r = realizedOutcomeForEvent(db, event());
  assert.equal(r.refusal, "ENTRY_TIME_MISMATCH");
});

test("a mirror entered before the detection it mirrors is refused", () => {
  const db = fakeDb({ cases: { oc_1: "al_1" }, trades: [trade({ entered_at_ms: T0 - 3600_000 })] });
  assert.equal(realizedOutcomeForEvent(db, event()).refusal, "ENTRY_TIME_MISMATCH");
});

test("two equally valid matches are ambiguous, not arbitrary", () => {
  const db = fakeDb({
    cases: { oc_1: "al_1" },
    trades: [trade({ id: 1 }), trade({ id: 2, exit_fill: 9.0 })],
  });
  const r = realizedOutcomeForEvent(db, event());
  assert.equal(r.refusal, "AMBIGUOUS_MULTIPLE_MATCHES");
  assert.equal(r.realizedReturnPct, null, "picking the better one would be the whole bias");
});

test("an open position has no realized return and is not marked to market", () => {
  const db = fakeDb({
    cases: { oc_1: "al_1" },
    trades: [trade({ status: "OPEN", exit_fill: null, exit_at_ms: null })],
  });
  const r = realizedOutcomeForEvent(db, event());
  assert.equal(r.state, "OPEN");
  assert.equal(r.evidenceState, "OPEN_POSITION");
  assert.equal(r.realizedReturnPct, null);
  assert.equal(r.realizedEntry, 2.5, "identity is still proven; only the outcome is pending");
  assert.equal(r.refusal, null, "OPEN is not a refusal");
});

test("a closed trade with no exit fill is unavailable, not reconstructed", () => {
  const db = fakeDb({ cases: { oc_1: "al_1" }, trades: [trade({ exit_fill: null })] });
  const r = realizedOutcomeForEvent(db, event());
  assert.equal(r.refusal, "CLOSED_WITHOUT_EXIT_FILL");
  assert.equal(r.realizedReturnPct, null);
});

test("a case with no linked mirror is a gap in our records, stated as one", () => {
  const db = fakeDb({ cases: { oc_1: "al_1" }, trades: [] });
  const r = realizedOutcomeForEvent(db, event());
  assert.equal(r.refusal, "NO_PAPER_TRADE_FOR_CASE");
  assert.ok(/excursion evidence/.test(r.note));
});

test("absent tables refuse instead of throwing", () => {
  const r = realizedOutcomeForEvent(fakeDb({ tables: [] }), event());
  assert.equal(r.refusal, "PAPER_TABLE_ABSENT");
});

test("the census groups refusals by cause and never pools them", () => {
  const db = fakeDb({ cases: { oc_1: "al_1" }, trades: [trade()] });
  const { census } = realizedOutcomesForEvents(db, [
    event({ eventId: "a" }),
    event({ eventId: "b", opportunityCaseId: null }),
    event({ eventId: "c", opportunityCaseId: "oc_missing" }),
  ]);
  assert.equal(census.examined, 3);
  assert.equal(census.verifiedRealized, 1);
  assert.equal(census.unavailable, 2);
  assert.equal(census.byRefusal.NO_CASE_ID_ON_EVENT, 1);
  assert.equal(census.byRefusal.NO_PAPER_TRADE_FOR_CASE, 1);
});

// ── realized statistics ──────────────────────────────────────────────────────

const POOL = tradingSessionsBetween("2026-08-03", "2026-09-30");

function outcome(i, returnPct, state = "VERIFIED_REALIZED") {
  return {
    version: REALIZED_OUTCOME_VERSION,
    eventId: `we_${i}`,
    occ: `O:NVDA260807C00${180 + (i % 4)}000`,
    opportunityCaseId: `oc_${i}`,
    paperTradeId: i,
    state: returnPct > 0 ? "WIN" : "LOSS",
    evidenceState: state,
    refusal: null,
    convention: "test",
    realizedEntry: 2.5,
    realizedExit: 2.5 * (1 + returnPct / 100),
    realizedReturnPct: state === "VERIFIED_REALIZED" ? returnPct : null,
    exitReason: "TARGET",
    enteredAtMs: T0,
    exitAtMs: T0 + 1000,
    sessionDate: POOL[i % 6],
    matchedOn: [],
    note: "",
  };
}

test("realized statistics are withheld below the floor but robustness is not", () => {
  const few = [outcome(0, 50), outcome(1, -20), outcome(2, 30)];
  const s = realizedStats(few);
  assert.equal(s.verdict, "INSUFFICIENT_EVIDENCE");
  assert.equal(s.profitFactor, null, "3 trades must never produce a published profit factor");
  assert.equal(s.winRate, null);
  assert.equal(s.meanReturnPct, null);
  assert.equal(s.closedTrades, 3, "the count is still a true statement");
  assert.ok(s.profitFactorExBest != null, "robustness is shown so collection can be judged");
  assert.ok(s.warnings.some((w) => /withheld/.test(w)));
});

test("clearing the floor produces realized expectancy, PF and payoff", () => {
  const many = [];
  for (let i = 0; i < 24; i++) many.push(outcome(i, i % 3 === 0 ? 60 : -20));
  const s = realizedStats(many);
  assert.equal(s.verdict, "SUPPORTED");
  assert.equal(s.closedTrades, 24);
  assert.equal(s.independentSessions, 6);
  assert.equal(s.winRate, +(8 / 24).toFixed(4));
  assert.equal(s.avgWinnerPct, 60);
  assert.equal(s.avgLoserPct, -20);
  assert.equal(s.payoffRatio, 3);
  // 8 winners * 60 = 480 gross win; 16 losers * 20 = 320 gross loss.
  assert.equal(s.profitFactor, 1.5);
  assert.equal(s.medianReturnPct, -20);
});

test("open and unavailable rows never enter the realized denominator", () => {
  const rows = [];
  for (let i = 0; i < 22; i++) rows.push(outcome(i, 40));
  rows.push({ ...outcome(90, 0, "OPEN_POSITION"), realizedReturnPct: null });
  rows.push({ ...outcome(91, 0, "UNAVAILABLE"), realizedReturnPct: null });
  const s = realizedStats(rows);
  assert.equal(s.closedTrades, 22, "24 rows, 22 closed");
  assert.equal(s.excluded.open, 1);
  assert.equal(s.excluded.unavailable, 1);
  assert.equal(s.winRate, 1, "22 of 22 closed, not 22 of 24");
});

test("realized independence is counted against the trading calendar", () => {
  const rows = [];
  // 22 closed trades but every session date is a weekend.
  for (let i = 0; i < 22; i++) {
    rows.push({ ...outcome(i, 40), sessionDate: i % 2 ? "2026-08-08" : "2026-08-09" });
  }
  const s = realizedStats(rows);
  assert.equal(s.closedTrades, 22);
  assert.equal(s.independentSessions, 0, "a weekend is not a trading session");
  assert.equal(s.verdict, "INSUFFICIENT_EVIDENCE");
  assert.equal(s.profitFactor, null);
});

test("a realized record carried by one trade says so", () => {
  const rows = [outcome(0, 900)];
  for (let i = 1; i < 24; i++) rows.push(outcome(i, -20));
  const s = realizedStats(rows);
  assert.equal(s.verdict, "SUPPORTED");
  assert.ok(s.profitFactor > 1, "the headline looks profitable");
  assert.equal(s.profitFactorExBest, 0, "and it is entirely one trade");
  assert.equal(s.survivesBestExcluded, false);
  assert.equal(s.bestTradeShareOfGross, 1);
  assert.ok(s.warnings.some((w) => /single best trade/.test(w)));
  assert.ok(s.profitFactorCapped < s.profitFactor, "capping bounds it a second way");
});

test("the basis string forbids the substitutions the numbers must not contain", () => {
  const s = realizedStats([outcome(0, 10)]);
  assert.ok(/REALIZED ONLY/.test(s.basis));
  assert.ok(/excursion/i.test(s.basis), "the reader is told which question this does not answer");
});
