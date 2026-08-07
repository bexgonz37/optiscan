import test from "node:test";
import assert from "node:assert/strict";
import { buildCohort } from "../lib/research/options/lower-high-cohort.ts";
import {
  evaluate, simulate, rankScore, splitByDate, perSessionEffect,
  EXPERIMENT_ID, EXPERIMENT_MODE, GATES,
} from "../lib/research/options/selection-experiment.ts";
import {
  extractPreEntryFeatures, assertNoLeakage, HINDSIGHT_DENYLIST, degenerateFeatures,
} from "../lib/research/options/pre-entry-features.ts";

const T0 = Date.UTC(2026, 6, 29, 13, 35, 0);
const DAY = 86_400_000;

function src(over = {}) {
  return {
    paperTradeId: 1, alertId: "a1", opportunityCaseId: "oc_1", discordMessageId: "d1",
    symbol: "AAPL", optionSymbol: "O:AAPL260803P00330000", side: "put", expiration: "2026-08-03",
    status: "EXITED", exitReason: "target_hit", enteredAtMs: T0, exitAtMs: T0 + 3_600_000,
    returnPct: 45, sameContractMarks: 100, peakPct: 45, troughPct: -8,
    msToPct: { p5: null, p10: null, p25: null, p50: null, p100: null },
    strike: 330, dte: 1, entryFill: 2.0, spreadPct: 2, volume: 5000, openInterest: 4000,
    iv: 0.35, delta: -0.45, underlyingPrice: 331,
    evidence: { underlying: { dollarVolume: 3e10, vwapDistPct: -0.3 }, chain: { ivLevel: 1.1, callPutVolRatio: 0.9 } },
    firstDetectedAtMs: T0, optionAtFirstDetection: 2.0,
    strategyVersion: null, exitPolicyVersion: null, deploymentSha: null,
    ...over,
  };
}
const feat = (over = {}) => buildCohort([src(over)]).rows[0].features;

// --------------------------------------------------------------------------
// Leakage. The two strongest apparent predictors in the raw data were hindsight.
// --------------------------------------------------------------------------

test("hindsight fields can never reach a selection rule", () => {
  assert.ok(HINDSIGHT_DENYLIST.includes("contractUpdateCount"));
  assert.ok(HINDSIGHT_DENYLIST.includes("contractCandidateCount"));
  assert.ok(HINDSIGHT_DENYLIST.includes("returnPct"));
  assert.throws(
    () => assertNoLeakage({ moneynessPct: -0.2, contractUpdateCount: 6 }, "test"),
    /hindsight field\(s\) reached a pre-entry rule: contractUpdateCount/,
  );
  assert.doesNotThrow(() => assertNoLeakage({ moneynessPct: -0.2 }, "test"));
});

test("extracted features contain no outcome or lifetime-accumulator field", () => {
  const f = feat();
  for (const k of HINDSIGHT_DENYLIST) assert.ok(!(k in f), `feature set leaked ${k}`);
  assert.doesNotThrow(() => evaluate(f));
});

test("features degenerate in production are reported as unmeasured, not as 'did not matter'", () => {
  // Production wrote first_detected == entry for every historical row.
  const fs = [feat(), feat({ paperTradeId: 2 })];
  const d = degenerateFeatures(fs);
  const ids = d.map((x) => x.feature);
  assert.ok(ids.includes("confirmationDelayMs"), "zero confirmation delay everywhere is a gap, not a finding");
  assert.ok(ids.includes("premiumExpansionPct"));
});

// --------------------------------------------------------------------------
// The rule itself.
// --------------------------------------------------------------------------

test("the experiment is shadow-only and names itself", () => {
  assert.equal(EXPERIMENT_ID, "LHC_SELECT_V1");
  assert.equal(EXPERIMENT_MODE, "SHADOW_PAPER_ONLY");
  assert.equal(GATES.length, 4);
  for (const g of GATES) assert.ok(g.rationale.length > 40, `${g.id} must state a mechanism`);
});

test("each gate rejects independently and names why", () => {
  assert.equal(evaluate(feat()).admitted, true);
  // far OTM: strike 320 against spot 331 is -3.3%
  assert.deepEqual(evaluate(feat({ strike: 320 })).blockedBy, ["ATM_BAND"]);
  assert.deepEqual(evaluate(feat({ dte: 9 })).blockedBy, ["SHORT_DTE"]);
  assert.deepEqual(
    evaluate(feat({ evidence: { underlying: { dollarVolume: 1e9 }, chain: {} } })).blockedBy,
    ["UNDERLYING_LIQUIDITY"],
  );
  assert.deepEqual(evaluate(feat({ iv: 0.8 })).blockedBy, ["IV_CEILING"]);
});

test("an ITM strike is rejected as well as a far-OTM one", () => {
  assert.equal(evaluate(feat({ strike: 340 })).admitted, false, "strike above spot on a put is ITM");
});

test("an unmeasurable gate fails closed and is reported as unavailable", () => {
  const d = evaluate(feat({ iv: null }));
  assert.equal(d.admitted, false);
  assert.deepEqual(d.unavailable, ["IV_CEILING"]);
  assert.ok(d.blockedBy.includes("IV_CEILING"));
});

test("rank score is deterministic, bounded, and ordered by contract fit", () => {
  const a = rankScore(feat());
  assert.deepEqual(a, rankScore(feat()), "same input must give the same score");
  assert.ok(a.score >= 0 && a.score <= 100);
  assert.equal(a.components.reduce((s, c) => s + c.max, 0), 100);
  const worse = rankScore(feat({ strike: 320, dte: 9, spreadPct: 8 }));
  assert.ok(worse.score < a.score, "a worse contract must rank lower");
});

// --------------------------------------------------------------------------
// The simulator must be able to say the rule is bad. This is the trailing-stop lesson.
// --------------------------------------------------------------------------

test("the simulator CAN reject a winner and reports it first", () => {
  // A winner that the ATM gate rejects: far-OTM strike, big realized return.
  const rows = buildCohort([
    src({ paperTradeId: 1, returnPct: 343.93, strike: 300 }),
    src({ paperTradeId: 2, returnPct: -40, exitReason: "stop_hit" }),
  ]).rows;
  const s = simulate(rows);
  assert.equal(s.winnersRejected.length, 1, "the simulator must be able to clip a winner");
  assert.equal(s.winnersRejected[0].paperTradeId, 1);
  assert.ok(s.winnersRejected[0].blockedBy.includes("ATM_BAND"));
  assert.equal(s.realizedWinnerValueLostPts, 343.93);
  assert.equal(s.productionBehaviorChanged, false);
});

test("simulate reports the tail-stripped and capped framings, not only the flattering one", () => {
  const rows = buildCohort([
    src({ paperTradeId: 1, returnPct: 343.93 }),
    src({ paperTradeId: 2, returnPct: 45 }),
    src({ paperTradeId: 3, returnPct: -40, exitReason: "stop_hit" }),
    src({ paperTradeId: 4, returnPct: -40, exitReason: "stop_hit", strike: 300 }),
  ]).rows;
  const s = simulate(rows);
  assert.equal(s.winnersRejected.length, 0);
  assert.equal(s.lossesAvoided, 1);
  assert.ok(s.experiment.profitFactor > s.baseline.profitFactor);
  // The tail carries the result; stripping it must be visible and must lower PF.
  assert.ok(s.exTopWinner.experiment.profitFactor < s.experiment.profitFactor,
    "removing the best trade must reduce reported profit factor");
  assert.ok(s.cappedAt60.experiment.largestWinnerPct <= 60);
});

test("a rule that admits nothing is not scored as a success", () => {
  const rows = buildCohort([src({ paperTradeId: 1, returnPct: 45, dte: 30 })]).rows;
  const s = simulate(rows);
  assert.equal(s.experiment.n, 0);
  assert.equal(s.experiment.profitFactor, null, "an empty arm has no profit factor to boast");
  assert.equal(s.winnersRejected.length, 1);
});

// --------------------------------------------------------------------------
// Date separation.
// --------------------------------------------------------------------------

test("date split holds out whole sessions, never individual trades", () => {
  const rows = buildCohort([
    src({ paperTradeId: 1, enteredAtMs: T0 }),
    src({ paperTradeId: 2, enteredAtMs: T0 + DAY }),
    src({ paperTradeId: 3, enteredAtMs: T0 + 2 * DAY }),
  ]).rows;
  const { development, validation } = splitByDate(rows, [rows[0].sessionDate]);
  assert.equal(development.length, 1);
  assert.equal(validation.length, 2);
  assert.equal(development[0].paperTradeId, 1);
  const sessions = new Set(rows.map((r) => r.sessionDate));
  assert.equal(sessions.size, 3, "each trade is on its own session date");
});

test("per-session effect marks a session WORSE whenever it costs a winner", () => {
  const rows = buildCohort([
    src({ paperTradeId: 1, enteredAtMs: T0, returnPct: 50, strike: 300 }), // winner the rule rejects
    src({ paperTradeId: 2, enteredAtMs: T0 + 60_000, returnPct: -40, exitReason: "stop_hit" }),
  ]).rows;
  const eff = perSessionEffect(rows);
  assert.equal(eff.length, 1);
  assert.equal(eff[0].winnersLost, 1);
  assert.equal(eff[0].direction, "WORSE", "losing a winner can never read as an improvement");
});
