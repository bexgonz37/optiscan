import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCohort, closedRows, performance, classifyLoss,
  COHORT_ID, MIN_MARKS_FOR_TRAJECTORY, UNKNOWN_LEGACY_VERSION,
} from "../lib/research/options/lower-high-cohort.ts";

// 2026-07-29 09:35 ET
const T0 = Date.UTC(2026, 6, 29, 13, 35, 0);

function src(over = {}) {
  return {
    paperTradeId: 1, alertId: "a1", opportunityCaseId: "oc_1", discordMessageId: "d1",
    symbol: "AAPL", optionSymbol: "O:AAPL260803P00330000", side: "put", expiration: "2026-08-03",
    status: "EXITED", exitReason: "target_hit", enteredAtMs: T0, exitAtMs: T0 + 3_600_000,
    returnPct: 45, sameContractMarks: 100, peakPct: 45, troughPct: -8,
    msToPct: { p5: 1000, p10: 2000, p25: 3000, p50: null, p100: null },
    strike: 330, dte: 1, entryFill: 2.0, spreadPct: 2, volume: 5000, openInterest: 4000,
    iv: 0.35, delta: -0.45, underlyingPrice: 331,
    evidence: { underlying: { dollarVolume: 3e10, vwapDistPct: -0.3 }, chain: { ivLevel: 1.1, callPutVolRatio: 0.9 } },
    firstDetectedAtMs: T0, optionAtFirstDetection: 2.0,
    strategyVersion: null, exitPolicyVersion: null, deploymentSha: null,
    ...over,
  };
}

test("cohort membership is versioned and outcomes are assigned from realized return", () => {
  const c = buildCohort([
    src({ paperTradeId: 1, returnPct: 45 }),
    src({ paperTradeId: 2, returnPct: -40, exitReason: "stop_hit" }),
    src({ paperTradeId: 3, status: "ENTERED", returnPct: null, exitAtMs: null }),
    src({ paperTradeId: 4, status: "EXITED", returnPct: null, exitAtMs: T0 + 100 }),
  ]);
  assert.equal(c.cohortId, COHORT_ID);
  assert.deepEqual(c.counts, { WINNER: 1, LOSS: 1, OPEN: 1, UNGRADABLE: 1 });
  assert.equal(closedRows(c).length, 2, "only WINNER and LOSS are closed members");
});

test("a thin mark series cannot support a trajectory claim but still supports realized return", () => {
  const c = buildCohort([src({ sameContractMarks: MIN_MARKS_FOR_TRAJECTORY - 1, peakPct: 45, troughPct: -8 })]);
  const r = c.rows[0];
  assert.equal(r.trajectoryTrustworthy, false);
  assert.equal(r.peakPct, null, "peak must not be reported from an untrustworthy path");
  assert.equal(r.neverWorked, null, "'never worked' is unknowable without a path");
  assert.equal(r.returnPct, 45, "realized return survives a single mark");
  assert.equal(r.outcome, "WINNER");
});

test("historical attribution is stamped UNKNOWN_LEGACY_VERSION, never invented", () => {
  const r = buildCohort([src()]).rows[0];
  assert.equal(r.strategyVersion, UNKNOWN_LEGACY_VERSION);
  assert.equal(r.exitPolicyVersion, UNKNOWN_LEGACY_VERSION);
  assert.equal(r.deploymentSha, UNKNOWN_LEGACY_VERSION);
});

test("crowding features are computed from the session, not from the row alone", () => {
  const c = buildCohort([
    src({ paperTradeId: 1, enteredAtMs: T0, exitAtMs: T0 + 9_000_000 }),
    src({ paperTradeId: 2, enteredAtMs: T0 + 60_000, exitAtMs: T0 + 9_000_000 }),
    src({ paperTradeId: 3, enteredAtMs: T0 + 120_000, exitAtMs: T0 + 9_000_000 }),
  ]);
  assert.deepEqual(c.rows.map((r) => r.features.sessionAlertOrdinal), [1, 2, 3]);
  assert.deepEqual(c.rows.map((r) => r.features.concurrentOpen), [0, 1, 2]);
});

test("profit factor and convexity share are reported so a single tail cannot hide", () => {
  const p = performance(buildCohort([
    src({ paperTradeId: 1, returnPct: 343.93 }),
    src({ paperTradeId: 2, returnPct: 45 }),
    src({ paperTradeId: 3, returnPct: -40 }),
    src({ paperTradeId: 4, returnPct: -40 }),
  ]).rows);
  assert.equal(p.winners, 2);
  assert.equal(p.losses, 2);
  assert.ok(p.profitFactor > 4.8 && p.profitFactor < 4.9, `PF ${p.profitFactor}`);
  assert.ok(p.topWinnerShareOfGross > 0.88, "the tail's share of gross profit must be visible");
});

test("loss taxonomy separates never-worked from worked-then-lost, and refuses to guess", () => {
  const mk = (o) => buildCohort([src({ returnPct: -45, exitReason: "stop_hit", ...o })]).rows[0];
  assert.equal(classifyLoss(mk({ sameContractMarks: 2, peakPct: 1 })).cause, "INSUFFICIENT_EVIDENCE");
  assert.equal(classifyLoss(mk({ peakPct: 30 })).cause, "PROFIT_GIVEN_BACK");
  assert.equal(classifyLoss(mk({ peakPct: 10 })).cause, "WORKED_MARGINALLY_THEN_LOST");
  // never worked -> the cause must be a pre-entry property
  assert.equal(classifyLoss(mk({ peakPct: 1, strike: 320, underlyingPrice: 331 })).cause, "CONTRACT_TOO_FAR_OTM");
  assert.equal(classifyLoss(mk({ peakPct: 1, iv: 0.9 })).cause, "PREMIUM_CHASE");
  assert.equal(classifyLoss(mk({ peakPct: 1, dte: 9 })).cause, "WRONG_DTE");
  assert.equal(classifyLoss(mk({ peakPct: 1 })).cause, "IMMEDIATE_SETUP_FAILURE");
  assert.equal(classifyLoss(mk({ peakPct: 30 })).workedFirst, true);
  assert.equal(classifyLoss(mk({ peakPct: 1 })).workedFirst, false);
  assert.equal(classifyLoss(mk({ sameContractMarks: 2, peakPct: 1 })).workedFirst, null);
});
