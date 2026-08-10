/**
 * tests/historical-cohort-v2.test.mjs
 *
 * HISTORICAL_COHORT_V2, robustness, and HISTORICAL_EDGE_SHADOW_V1.
 *
 * Most of these assert that a number is ABSENT, and that is the point. The failures
 * being guarded against all look like success:
 *
 *   · a probability computed off six events
 *   · a profit factor supplied entirely by one +900% trade
 *   · a candidate with NO historical evidence outranking one with measured disadvantage
 *
 * The last one is the subtle one. Treating an absent component as neutral makes absence
 * systematically beat measured weakness, and the model learns to prefer the unknown.
 */
import "./helpers/register-alias.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  computeCohortV2,
  selectCohortV2,
  cohortV2IdFor,
  robustnessFor,
  membersFromWinnerEvents,
  V2_MIN_EVENTS,
  V2_MIN_SESSIONS,
} from "../lib/research/historical/cohort-v2.ts";
import {
  scoreHistoricalEdgeShadow,
  compareBaselineToShadow,
} from "../lib/research/historical/edge-shadow.ts";

const MIN = 60_000;
const KEY = { lane: "REPLAY_HISTORICAL" };

let seq = 0;
function member(over = {}) {
  seq += 1;
  return {
    eventId: `we_${seq}`,
    occ: `O:NVDA260807C00${180 + (seq % 5)}000`,
    symbol: "NVDA",
    sessionDate: "2026-08-03",
    side: "call",
    strategyKey: "breakout",
    regime: "RISK_ON",
    discoveryStage: "EARLY_CONFIRMATION",
    dteBucket: "3-7DTE",
    finalReturnPct: 20,
    mfePct: 40,
    maePct: -10,
    msToMilestone: { "10": 2 * MIN, "25": 6 * MIN, "50": null, "100": null, "200": null },
    peakMilestone: 25,
    evidenceQuality: "VERIFIED",
    ...over,
  };
}

/** N members spread across `sessions` distinct dates. */
function population({ n, sessions, make = () => ({}) }) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const day = `2026-08-${String(3 + (i % sessions)).padStart(2, "0")}`;
    out.push(member({ sessionDate: day, ...make(i) }));
  }
  return out;
}

// ── evidence floors ──────────────────────────────────────────────────────────

test("a small cohort reports counts but never a probability", () => {
  const r = computeCohortV2(population({ n: 6, sessions: 3 }), KEY);
  assert.equal(r.floors.verdict, "INSUFFICIENT_EVIDENCE");
  const p25 = r.milestones.find((m) => m.milestone === 25);
  assert.equal(p25.reached, 6, "the count is a true statement about six events");
  assert.equal(p25.probability, null, "6-of-6 must never become P(+25%) = 1.0");
  assert.equal(r.profitFactor, null);
  assert.equal(r.expectedReturnPct, null);
});

test("enough events across too few sessions is still insufficient", () => {
  const r = computeCohortV2(population({ n: 30, sessions: 1 }), KEY);
  assert.ok(r.floors.events >= V2_MIN_EVENTS);
  assert.equal(r.floors.independentSessions, 1);
  assert.equal(r.floors.verdict, "INSUFFICIENT_EVIDENCE");
  assert.ok(r.floors.reason.includes(String(V2_MIN_SESSIONS)));
});

test("clearing both floors produces real empirical values", () => {
  const r = computeCohortV2(
    population({
      n: 25, sessions: 5,
      make: (i) => (i % 4 === 0
        ? { finalReturnPct: 80, msToMilestone: { "10": MIN, "25": 3 * MIN, "50": 8 * MIN, "100": null, "200": null } }
        : { finalReturnPct: -25, msToMilestone: { "10": 2 * MIN, "25": null, "50": null, "100": null, "200": null } }),
    }),
    KEY,
  );
  assert.equal(r.floors.verdict, "SUPPORTED");
  assert.equal(r.sessions.length, 5);
  const p50 = r.milestones.find((m) => m.milestone === 50);
  assert.equal(p50.reached, 7);
  assert.equal(p50.probability, +(7 / 25).toFixed(4));
  assert.ok(r.profitFactor != null && r.winRate != null && r.expectedReturnPct != null);
  assert.ok(r.medianMsToPeak != null);
});

test("milestone times survive thin coverage but extremes do not", () => {
  // Every member has milestone times; none has VERIFIED extreme evidence.
  const r = computeCohortV2(
    population({ n: 25, sessions: 5, make: () => ({ evidenceQuality: "THIN", mfePct: null, maePct: null }) }),
    KEY,
  );
  assert.equal(r.floors.verdict, "SUPPORTED", "milestones admit every member");
  assert.ok(r.milestones.find((m) => m.milestone === 25).probability != null);
  assert.equal(r.extremeSample.verdict, "INSUFFICIENT_EVIDENCE");
  assert.equal(r.expectedMfePct, null, "an extreme asserts the gaps held nothing larger");
});

// ── robustness ───────────────────────────────────────────────────────────────

test("a cohort carried by one enormous winner says so loudly", () => {
  const members = population({
    n: 25, sessions: 5,
    make: (i) => ({ finalReturnPct: i === 0 ? 900 : -20 }),
  });
  const r = computeCohortV2(members, KEY);
  assert.ok(r.profitFactor > 1, "the headline looks profitable");
  assert.equal(r.robustness.profitFactorExBest, 0, "and it is entirely one event");
  assert.equal(r.robustness.survivesBestExcluded, false);
  assert.ok(r.robustness.bestEventShareOfGross === 1);
  assert.ok(
    r.robustness.warnings.some((w) => /tail, not an edge/.test(w)),
    "the warning names the shape, not just the number",
  );
  // The capped variant bounds the same trade's influence a second way.
  assert.ok(r.robustness.profitFactorCapped < r.profitFactor);
});

test("robustness is computed even when the floors fail", () => {
  const members = population({ n: 6, sessions: 2, make: (i) => ({ symbol: i < 5 ? "NVDA" : "AMD" }) });
  const r = computeCohortV2(members, KEY);
  assert.equal(r.floors.verdict, "INSUFFICIENT_EVIDENCE");
  assert.ok(
    r.robustness.symbolConcentration >= 0.8,
    "a reader deciding whether to keep collecting needs to see the cohort is one symbol",
  );
  assert.ok(r.robustness.warnings.some((w) => /one symbol/.test(w)));
});

test("per-session expectancy exposes a single exceptional day", () => {
  const members = population({
    n: 25, sessions: 5,
    make: (i) => ({ finalReturnPct: i % 5 === 0 ? 200 : -10 }),
  });
  const rob = robustnessFor(members);
  assert.equal(rob.perSessionExpectancy.length, 5);
  assert.ok(rob.sessionsPositive + rob.sessionsNegative === 5);
});

// ── identity ─────────────────────────────────────────────────────────────────

test("lane is part of the cohort identity and V1's version is untouched", () => {
  const a = cohortV2IdFor({ lane: "OWNER_VALIDATION", side: "call" });
  const b = cohortV2IdFor({ lane: "RESEARCH", side: "call" });
  assert.notEqual(a, b, "two lanes are two cohorts");
  assert.ok(a.startsWith("HISTORICAL_COHORT_V2:"));
  assert.ok(!a.includes("HISTORICAL_COHORT_V1"), "V1 semantics are not reused or overwritten");
});

test("a null key field does not filter, and does not match missing values", () => {
  const members = [member({ regime: "RISK_ON" }), member({ regime: null })];
  assert.equal(selectCohortV2(members, { lane: "RESEARCH" }).length, 2);
  assert.equal(selectCohortV2(members, { lane: "RESEARCH", regime: null }).length, 2);
  assert.equal(selectCohortV2(members, { lane: "RESEARCH", regime: "RISK_ON" }).length, 1);
});

test("winner events adapt into members without inventing an outcome", () => {
  const [m] = membersFromWinnerEvents([{
    version: "HIST_WINNER_V1", eventId: "we_x", occ: "O:X", symbol: "X", side: "call",
    strike: 1, expiration: "2026-08-07", sessionDate: "2026-08-03",
    entryAtMs: 0, entryConvention: "ASK at T", entryPrice: 2,
    windowToMs: 1, quotesUsed: 5, peakMilestone: 25,
    msToMilestone: { "10": 1, "25": 2, "50": null, "100": null, "200": null },
    mfePct: 30, maePct: -5, evidenceQuality: "VERIFIED", note: "",
  }]);
  assert.equal(m.mfePct, 30);
  assert.equal(
    m.finalReturnPct, null,
    "an event knows its extremes, not where it was closed — inferring one from the other is the peak-as-outcome error",
  );
});

// ── edge shadow ──────────────────────────────────────────────────────────────

const goodCohort = () => computeCohortV2(
  population({
    n: 40, sessions: 8,
    make: (i) => (i % 3 === 0
      ? { finalReturnPct: 60, msToMilestone: { "10": MIN, "25": 3 * MIN, "50": 7 * MIN, "100": 15 * MIN, "200": null } }
      : { finalReturnPct: -18, msToMilestone: { "10": 2 * MIN, "25": null, "50": null, "100": null, "200": null } }),
  }),
  KEY,
);

test("an insufficient cohort yields a NULL score, never a low one", () => {
  const weak = computeCohortV2(population({ n: 5, sessions: 2 }), KEY);
  const s = scoreHistoricalEdgeShadow({ cohort: weak, discovery: { stage: "PRE_TRIGGER", rewardRemainingFraction: 0.9 } });
  assert.equal(s.state, "INSUFFICIENT_HISTORICAL_EVIDENCE");
  assert.equal(s.score, null, "a low score is a finding about the setup; a null is a finding about us");
  assert.equal(s.advisoryOnly, true);
});

test("no cohort at all is its own state", () => {
  const s = scoreHistoricalEdgeShadow({ cohort: null });
  assert.equal(s.state, "NO_COMPARABLE_COHORT");
  assert.equal(s.score, null);
});

test("missing evidence never outranks measured disadvantage", () => {
  const cohort = goodCohort();
  // A: complete evidence, but genuinely poor — late, no reward left, chasing, wide.
  const poorButMeasured = scoreHistoricalEdgeShadow({
    cohort,
    discovery: {
      stage: "TOO_LATE", rewardRemainingFraction: 0.02,
      premiumExpansionConsumedPct: 55, marketAlignment: "COUNTER_TREND", spreadPct: 12,
    },
    contract: { spreadPct: 12, openInterest: 50, volume: 10 },
  });
  // B: nothing known about the setup at all.
  const unknown = scoreHistoricalEdgeShadow({ cohort, discovery: null, contract: null });

  assert.equal(poorButMeasured.state, "SCORED");
  assert.equal(unknown.state, "SCORED");
  assert.ok(
    unknown.componentsScored < poorButMeasured.componentsScored,
    "the unknown candidate has strictly less evidence",
  );
  // Only the cohort-derived components scored, so coverage falls below half and the
  // result is marked INSUFFICIENT rather than merely partial. The thinness is a
  // first-class field, not something buried inside the number.
  assert.equal(unknown.evidenceQuality, "INSUFFICIENT");
  assert.equal(poorButMeasured.evidenceQuality, "COMPLETE");
  assert.ok(
    unknown.warnings.some((w) => /components had evidence/.test(w)),
    "and the score says out loud how little it rests on",
  );
});

test("an early setup with room left outranks a late one on identical history", () => {
  const cohort = goodCohort();
  const common = { contract: { spreadPct: 2, openInterest: 4000, volume: 1500 } };
  const early = scoreHistoricalEdgeShadow({
    cohort,
    discovery: { stage: "PRE_TRIGGER", rewardRemainingFraction: 0.9, premiumExpansionConsumedPct: 3, marketAlignment: "ALIGNED", spreadPct: 2 },
    ...common,
  });
  const late = scoreHistoricalEdgeShadow({
    cohort,
    discovery: { stage: "TOO_LATE", rewardRemainingFraction: 0.05, premiumExpansionConsumedPct: 55, marketAlignment: "ALIGNED", spreadPct: 2 },
    ...common,
  });
  assert.ok(early.score > late.score, "the point is finding them before they run, not direction accuracy");
});

test("UNGRADABLE and UNKNOWN are not scored as mild preferences", () => {
  const cohort = goodCohort();
  const s = scoreHistoricalEdgeShadow({
    cohort,
    discovery: { stage: "UNGRADABLE", rewardRemainingFraction: null, premiumExpansionConsumedPct: null, marketAlignment: "UNKNOWN", spreadPct: null },
  });
  const stage = s.components.find((c) => c.name === "discoveryStage");
  const align = s.components.find((c) => c.name === "marketAlignment");
  assert.equal(stage.value, null, "UNGRADABLE is an admission, not a stage");
  assert.equal(align.value, null, "UNKNOWN means we could not see the tape; scoring it rewards a blind spot");
});

test("a tail-dependent cohort carries its warning into the shadow result", () => {
  const tail = computeCohortV2(
    population({ n: 25, sessions: 5, make: (i) => ({ finalReturnPct: i === 0 ? 900 : -20 }) }),
    KEY,
  );
  const s = scoreHistoricalEdgeShadow({ cohort: tail, discovery: { stage: "PRE_TRIGGER", rewardRemainingFraction: 0.8 } });
  assert.ok(s.warnings.some((w) => /best event|tail/.test(w)), "the caveat travels with the score");
});

test("an uncomparable pair is never counted as agreement", () => {
  const s = scoreHistoricalEdgeShadow({ cohort: null });
  const c = compareBaselineToShadow({ opportunityCaseId: "oc_1", symbol: "NVDA", baselineRank: 3, shadow: s });
  assert.equal(c.agreement, "UNCOMPARABLE");
  assert.notEqual(c.agreement, "AGREE", "otherwise the shadow looks more correct as its coverage gets worse");
});

test("baseline and shadow disagreement is directional", () => {
  const cohort = goodCohort();
  const strong = scoreHistoricalEdgeShadow({
    cohort,
    discovery: { stage: "PRE_TRIGGER", rewardRemainingFraction: 0.95, premiumExpansionConsumedPct: 1, marketAlignment: "ALIGNED", spreadPct: 1 },
    contract: { spreadPct: 1, openInterest: 9000, volume: 5000 },
  });
  const c = compareBaselineToShadow({ opportunityCaseId: "oc_2", symbol: "NVDA", baselineRank: 18, shadow: strong });
  assert.equal(c.agreement, "SHADOW_PREFERS", "baseline ranked it near the bottom; the shadow did not");
});
