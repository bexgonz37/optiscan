/**
 * tests/learning-and-cohorts.test.mjs
 *
 * Two things this pins.
 *
 * LEARNING: the system already stored plenty of outcomes; what it could not do was say
 * "this keeps happening". A pattern is only reported when it recurs across INDEPENDENT
 * sessions, and every proposal it emits is inert data — no threshold mutation, no promotion,
 * no send authority, no deploy hook.
 *
 * COHORTS: the temptation after "0DTE discovery now works" is to point at the SPY +203%
 * contract and call it validated. A cohort result must repeat across independent sessions,
 * and a replay with an incomplete hindsight fence is not evidence however good it looks.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { detectPatterns, proposeExperiments } from "../lib/research/options/learning-evidence.ts";
import {
  compareCohorts,
  fenceIsComplete,
  missingFenceFields,
  MIN_INDEPENDENT_SESSIONS,
} from "../lib/research/options/validation-cohorts.ts";

const fullFence = (over = {}) => ({
  eligibilityAtMs: 1,
  dataCutoffMs: 1,
  chainSnapshotId: "chain_1",
  quoteSnapshotId: "quote_1",
  providerStateId: "prov_1",
  strategyVersion: "1",
  rankingVersion: "opportunity-ranking@1",
  ...over,
});

const session = (cohortId, sessionDate, over = {}) => ({
  cohortId,
  method: "HISTORICAL_REPLAY",
  sessionDate,
  fence: fullFence(),
  candidatesDetected: 100,
  alertsOrPaperEntries: 10,
  verifiedWinnersRecovered: 1,
  falsePositivesIntroduced: 0,
  falseNegativesReduced: 0,
  correctRejectionsPreserved: 90,
  precision: 0.5,
  recall: 0.5,
  medianReturnPct: 0,
  expectancyPct: -7.2,
  profitFactor: 0.49,
  medianMfePct: 1.6,
  medianMaePct: -15.8,
  immediateFailureRate: 0.599,
  medianAlertLatencyMs: 5000,
  medianPremiumExpansionPct: 5,
  providerRequests: 1000,
  providerBudgetRefusals: 108,
  evidenceCompleteness: 0.9,
  ...over,
});

// ── Learning ────────────────────────────────────────────────────────────────

test("a one-off is not a pattern; recurrence across sessions is", () => {
  const once = detectPatterns({
    outcomes: [], segments: [],
    missedWinners: [{ sessionDate: "2026-08-05", symbol: "SPY", optionSymbol: "O:SPY260805P00770000", dte: 0, whyMissed: "0DTE contract, never fetched." }],
  });
  assert.equal(once.length, 0, "one session is an anecdote");

  const twice = detectPatterns({
    outcomes: [], segments: [],
    missedWinners: [
      { sessionDate: "2026-08-05", symbol: "SPY", optionSymbol: "O:SPY260805P00770000", dte: 0, whyMissed: "0DTE contract, never fetched." },
      { sessionDate: "2026-08-04", symbol: "QQQ", optionSymbol: "O:QQQ260804P00600000", dte: 0, whyMissed: "0DTE contract, never fetched." },
    ],
  });
  assert.equal(twice.length, 1);
  assert.equal(twice[0].patternId, "ZERO_DTE_WINNERS_NEVER_FETCHED");
  assert.equal(twice[0].sessionsObserved, 2);
  assert.ok(twice[0].wouldBeDisprovenBy.length > 0, "a pattern must name what would disprove it");
});

test("structural findings are reported without needing repetition — they are proven by construction", () => {
  const p = detectPatterns({
    outcomes: [], segments: [],
    unselectableStrategies: [{ strategy: "zero_dte_index", dominatedBy: ["pullback_continuation"] }],
  });
  assert.equal(p.length, 1);
  assert.equal(p[0].patternId, "STRATEGY_UNSELECTABLE_BY_DOMINATION");
  assert.match(p[0].evidence[0], /zero_dte_index dominated by pullback_continuation/);
});

test("negative-expectancy segments surface as a named pattern", () => {
  const p = detectPatterns({
    outcomes: [], segments: [{
      key: { strategy: "vwap_rejection", strategyVersion: "1" },
      keyString: "k",
      metrics: { expectancyPct: -12, profitFactor: 0.4, pricedSampleSize: 30 },
      classification: "NEGATIVE_EXPECTANCY",
      rationale: "r",
    }],
  });
  assert.equal(p[0].patternId, "NEGATIVE_FORWARD_EXPECTANCY");
  assert.match(p[0].evidence[0], /vwap_rejection@1/);
});

test("every proposal is inert: bounded lane, human approval, and no applicable lever", () => {
  const patterns = detectPatterns({
    outcomes: [], segments: [],
    unselectableStrategies: [{ strategy: "zero_dte_index", dominatedBy: ["pullback_continuation"] }],
    missedWinners: [
      { sessionDate: "2026-08-05", symbol: "SPY", optionSymbol: "a", dte: 0, whyMissed: "0DTE never fetched" },
      { sessionDate: "2026-08-04", symbol: "QQQ", optionSymbol: "b", dte: 0, whyMissed: "0DTE never fetched" },
    ],
  });
  const proposals = proposeExperiments(patterns);
  assert.ok(proposals.length >= 2);
  for (const p of proposals) {
    assert.equal(p.requiresHumanApproval, true);
    assert.ok(["SHADOW", "PAPER_VALIDATION", "RESEARCH_ONLY"].includes(p.lane),
      `${p.proposalId} must be confined to a non-subscriber lane, got ${p.lane}`);
    assert.ok(p.successCriteria && p.failureCriteria, "both outcomes must be pre-declared");
    assert.ok(p.minimumSample >= 20, "a proposal must state a real minimum sample");
    assert.ok(Array.isArray(p.risks) && p.risks.length > 0, "risks must be stated");
    // The authority boundary is structural: there is no lever on the object.
    assert.equal(typeof p.apply, "undefined");
    assert.equal(typeof p.threshold, "undefined");
    assert.equal(typeof p.promote, "undefined");
  }
});

test("the 0DTE proposal names the real provider constraint as a risk", () => {
  const proposals = proposeExperiments(detectPatterns({
    outcomes: [], segments: [],
    missedWinners: [
      { sessionDate: "2026-08-05", symbol: "SPY", optionSymbol: "a", dte: 0, whyMissed: "0DTE never fetched" },
      { sessionDate: "2026-08-04", symbol: "QQQ", optionSymbol: "b", dte: 0, whyMissed: "0DTE never fetched" },
    ],
  }));
  const zero = proposals.find((p) => p.patternId === "ZERO_DTE_WINNERS_NEVER_FETCHED");
  assert.match(zero.risks.join(" "), /per-minute|280/, "the binding provider cap must be called out");
  assert.notEqual(zero.lane, "SUBSCRIBER");
});

// ── Cohorts ─────────────────────────────────────────────────────────────────

test("an incomplete hindsight fence is LEAKAGE_RISK, whatever the numbers say", () => {
  const leaky = fullFence({ chainSnapshotId: null, providerStateId: null });
  assert.equal(fenceIsComplete(leaky), false);
  assert.deepEqual(missingFenceFields(leaky), ["chainSnapshotId", "providerStateId"]);

  const cohort = [1, 2, 3].map((i) => session("B_ZERO_DTE_DISCOVERY", `2026-08-0${i}`, {
    expectancyPct: 50, fence: leaky,
  }));
  const baseline = [1, 2, 3].map((i) => session("A_PRODUCTION", `2026-08-0${i}`));
  const cmp = compareCohorts(cohort, baseline);
  assert.equal(cmp.verdict, "LEAKAGE_RISK");
  assert.match(cmp.rationale, /incomplete hindsight fence/);
});

test("one spectacular session is not validation", () => {
  // One huge session, two that merely match the baseline. Matching is neutral, not damage.
  const cohort = [
    session("B_ZERO_DTE_DISCOVERY", "2026-08-01", { expectancyPct: 200, immediateFailureRate: 0.2 }),
    session("B_ZERO_DTE_DISCOVERY", "2026-08-02"),
    session("B_ZERO_DTE_DISCOVERY", "2026-08-03"),
  ];
  const baseline = ["2026-08-01", "2026-08-02", "2026-08-03"].map((s) => session("A_PRODUCTION", s));
  const cmp = compareCohorts(cohort, baseline);
  assert.equal(cmp.verdict, "IMPROVED_ONCE_NOT_REPEATED");
  assert.deepEqual(cmp.sessionsImproved, ["2026-08-01"]);
});

test("improvement must repeat across independent sessions to count", () => {
  const cohort = ["2026-08-01", "2026-08-02", "2026-08-03"].map((s) =>
    session("F_COMBINED", s, { expectancyPct: 4, immediateFailureRate: 0.4 }));
  const baseline = ["2026-08-01", "2026-08-02", "2026-08-03"].map((s) => session("A_PRODUCTION", s));
  const cmp = compareCohorts(cohort, baseline);
  assert.equal(cmp.verdict, "IMPROVED_REPEATEDLY");
  assert.equal(cmp.sessionsImproved.length, MIN_INDEPENDENT_SESSIONS);
  assert.ok(cmp.deltas.expectancyPct > 0);
});

test("expectancy bought by worsening the typical alert is NOT an improvement", () => {
  // Higher expectancy, but immediate failure got worse: a few huge winners masking a
  // degraded median. This is exactly the "+203% contract" failure mode.
  const cohort = ["2026-08-01", "2026-08-02", "2026-08-03"].map((s) =>
    session("E_OPPORTUNITY_RANKING", s, { expectancyPct: 10, immediateFailureRate: 0.85 }));
  const baseline = ["2026-08-01", "2026-08-02", "2026-08-03"].map((s) => session("A_PRODUCTION", s));
  const cmp = compareCohorts(cohort, baseline);
  assert.deepEqual(cmp.sessionsImproved, [], "raising expectancy while degrading the median is not an improvement");
  assert.equal(cmp.verdict, "REGRESSED", "a worse typical alert is a regression, even with higher expectancy");
});

test("neutral is distinguished from regressed: not improving is not the same as damage", () => {
  const cohort = ["2026-08-01", "2026-08-02", "2026-08-03"].map((s) => session("F_COMBINED", s));
  const baseline = ["2026-08-01", "2026-08-02", "2026-08-03"].map((s) => session("A_PRODUCTION", s));
  const cmp = compareCohorts(cohort, baseline);
  assert.deepEqual(cmp.sessionsRegressed, [], "identical results are not a regression");
  assert.equal(cmp.verdict, "NO_MATERIAL_CHANGE");
});

test("too few paired sessions is INSUFFICIENT_SESSIONS, not a pass", () => {
  const cohort = [session("C_STRATEGY_SELECTION", "2026-08-01", { expectancyPct: 30 })];
  const baseline = [session("A_PRODUCTION", "2026-08-01")];
  const cmp = compareCohorts(cohort, baseline);
  assert.equal(cmp.verdict, "INSUFFICIENT_SESSIONS");
});

test("a genuine regression is reported as REGRESSED", () => {
  const cohort = ["2026-08-01", "2026-08-02", "2026-08-03"].map((s) =>
    session("D_CONTRACT_RANKING", s, { expectancyPct: -30 }));
  const baseline = ["2026-08-01", "2026-08-02", "2026-08-03"].map((s) => session("A_PRODUCTION", s));
  const cmp = compareCohorts(cohort, baseline);
  assert.equal(cmp.verdict, "REGRESSED");
  assert.ok(cmp.deltas.expectancyPct < 0);
});

test("provider cost is carried through the comparison", () => {
  const cohort = ["2026-08-01", "2026-08-02", "2026-08-03"].map((s) =>
    session("B_ZERO_DTE_DISCOVERY", s, { expectancyPct: 4, providerRequests: 1400 }));
  const baseline = ["2026-08-01", "2026-08-02", "2026-08-03"].map((s) => session("A_PRODUCTION", s));
  const cmp = compareCohorts(cohort, baseline);
  assert.equal(cmp.deltas.providerRequests, 400, "extra provider cost must be visible, not hidden");
});
