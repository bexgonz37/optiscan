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
import {
  classifySessionDate,
  countIndependentSessions,
  tradingSessionsBetween,
} from "../lib/research/historical/trading-sessions.ts";

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

/**
 * N members spread across `sessions` distinct REAL trading sessions.
 *
 * The naive version walked calendar days and silently produced 2026-08-08 and 08-09 — a
 * Saturday and a Sunday — for any population wanting six or more sessions. A suite that
 * asserts on independence counts must not itself invent sessions the market never held.
 */
const SESSION_POOL = tradingSessionsBetween("2026-08-03", "2026-10-30");

function population({ n, sessions, make = () => ({}) }) {
  assert.ok(sessions <= SESSION_POOL.length, "session pool exhausted");
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(member({ sessionDate: SESSION_POOL[i % sessions], ...make(i) }));
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

// ── session / calendar accounting ────────────────────────────────────────────
//
// The independence floor is the safeguard that stops twenty events from one frantic
// afternoon reading as twenty independent confirmations. It is therefore the number most
// worth attacking, and the attack does not have to be deliberate — a `new Set(dates).size`
// over Eastern CALENDAR dates counts a Saturday as evidence.

test("a calendar date is not automatically a trading session", () => {
  assert.equal(classifySessionDate("2026-08-06").isTradingSession, true, "Thursday");
  assert.equal(classifySessionDate("2026-08-08").reason, "WEEKEND", "Saturday");
  assert.equal(classifySessionDate("2026-08-09").reason, "WEEKEND", "Sunday");
  // 4 July 2026 is a Saturday, so the market closes on Friday the 3rd.
  assert.equal(classifySessionDate("2026-07-03").reason, "MARKET_HOLIDAY");
  assert.equal(classifySessionDate("2026-07-03").holiday, "Independence Day");
  assert.equal(classifySessionDate("2026-01-01").reason, "MARKET_HOLIDAY");
  assert.equal(classifySessionDate("2026-04-03").holiday, "Good Friday");
  assert.equal(classifySessionDate("2026-11-26").holiday, "Thanksgiving Day");
  // Corrupt inputs must not become sessions.
  assert.equal(classifySessionDate("1970-01-01").reason, "OUT_OF_RANGE", "a zero epoch");
  assert.equal(classifySessionDate("2026-02-30").reason, "MALFORMED_DATE", "not a real day");
  assert.equal(classifySessionDate("not-a-date").reason, "MALFORMED_DATE");
  assert.equal(classifySessionDate(null).reason, "MALFORMED_DATE");
});

test("non-trading dates cannot inflate an independent-session count", () => {
  const real = ["2026-07-27", "2026-07-29", "2026-07-30", "2026-07-31", "2026-08-03", "2026-08-06"];
  const clean = countIndependentSessions(real);
  assert.equal(clean.independentSessions, 6, "all six are genuine weekday sessions");
  assert.deepEqual(clean.rejected, []);

  const padded = countIndependentSessions([
    ...real, "2026-08-08", "2026-08-09", "2026-07-03", "1970-01-01", "", null,
  ]);
  assert.equal(padded.independentSessions, 6, "padding with junk must not raise the count");
  assert.equal(padded.distinctDatesSeen, 10, "but the junk is still reported, not hidden");
  assert.equal(padded.rejected.length, 4);
  assert.ok(padded.warnings.some((w) => w.includes("NOT trading sessions")));
});

test("duplicate session dates count once", () => {
  const r = countIndependentSessions(["2026-08-03", "2026-08-03", "2026-08-03", "2026-08-04"]);
  assert.equal(r.independentSessions, 2);
  assert.equal(r.distinctDatesSeen, 2);
});

test("the cohort floor counts verified trading sessions, not distinct strings", () => {
  // Twenty-two events, but three of the five session dates are weekends.
  const members = [];
  const dates = ["2026-08-03", "2026-08-04", "2026-08-08", "2026-08-09", "2026-08-15"];
  for (let i = 0; i < 22; i++) members.push(member({ sessionDate: dates[i % dates.length] }));
  const r = computeCohortV2(members, KEY);
  assert.equal(r.floors.events, 22);
  assert.equal(r.floors.independentSessions, 2, "three of the five dates are weekends");
  assert.equal(r.floors.verdict, "INSUFFICIENT_EVIDENCE", "a weekend must not clear the floor");
  assert.ok(r.floors.reason.includes("WEEKEND"));
  assert.deepEqual(r.sessions, ["2026-08-03", "2026-08-04"], "reported sessions are the verified ones");
});

test("the reported session list and the floor never disagree", () => {
  const r = computeCohortV2(population({ n: 25, sessions: 5 }), KEY);
  assert.equal(r.sessions.length, r.floors.independentSessions);
  assert.equal(r.floors.sessionAudit.independentSessions, r.floors.independentSessions);
  for (const d of r.sessions) assert.equal(classifySessionDate(d).isTradingSession, true);
});

test("a trading-session span is not a calendar-day span", () => {
  // The exact confusion behind "6 sessions over a 5-day bars window": the bars range and
  // the option-quote range are different datasets covering different spans.
  assert.equal(tradingSessionsBetween("2026-08-03", "2026-08-07").length, 5);
  assert.equal(tradingSessionsBetween("2026-07-27", "2026-08-06").length, 9);
  assert.equal(tradingSessionsBetween("2026-08-08", "2026-08-09").length, 0, "a weekend spans none");
});

// ── zero observed vs evidence unavailable ────────────────────────────────────
//
// `probability: 0` is two completely different claims depending on what produced it, and
// they print identically. This is especially load-bearing for +50/+100/+200, where a
// coverage gap and a genuine absence of tail moves look the same.

test("a contract with no post-entry quote is not counted as a miss", () => {
  const witnessed = population({ n: 20, sessions: 5, make: () => ({ postEntryQuotes: 500 }) });
  const blind = population({
    n: 5, sessions: 5,
    make: () => ({
      postEntryQuotes: 0,
      evidenceQuality: "UNSUPPORTED",
      mfePct: null, maePct: null, finalReturnPct: null,
      msToMilestone: { "10": null, "25": null, "50": null, "100": null, "200": null },
    }),
  });
  const r = computeCohortV2([...witnessed, ...blind], KEY);
  const p10 = r.milestones.find((m) => m.milestone === 10);
  assert.equal(p10.of, 20, "the denominator is witnesses, not all 25 members");
  assert.equal(p10.excludedNoWitness, 5);
  assert.equal(p10.reached, 20);
  assert.equal(p10.probability, 1, "20/20, not 20/25 — silence is not a miss");
});

test("an observed zero and an unobservable milestone are different rows", () => {
  const r = computeCohortV2(
    population({ n: 25, sessions: 5, make: () => ({ postEntryQuotes: 800 }) }),
    KEY,
  );
  const p25 = r.milestones.find((m) => m.milestone === 25);
  assert.equal(p25.observation, "OBSERVED", "the fixture reaches +25%");

  const p100 = r.milestones.find((m) => m.milestone === 100);
  assert.equal(p100.reached, 0);
  assert.equal(p100.observation, "OBSERVED_ZERO", "witnesses existed and none reached it");
  assert.ok(p100.upperBound95 > 0, "0-of-25 bounds the rate, it does not zero it");
  assert.ok(p100.upperBound95 < 0.2);
  assert.ok(p100.note.includes("not a"), "the row says what kind of zero it is");
});

test("no witnesses makes a milestone EVIDENCE_UNAVAILABLE, never a zero probability", () => {
  const blind = population({
    n: 25, sessions: 5,
    make: () => ({
      postEntryQuotes: 0,
      evidenceQuality: "UNSUPPORTED",
      mfePct: null, maePct: null,
      msToMilestone: { "10": null, "25": null, "50": null, "100": null, "200": null },
    }),
  });
  const r = computeCohortV2(blind, KEY);
  for (const m of r.milestones) {
    assert.equal(m.of, 0, "nothing could witness anything");
    assert.equal(m.observation, "EVIDENCE_UNAVAILABLE");
    assert.equal(m.probability, null, "absence of observation must never print as 0");
    assert.equal(m.upperBound95, null);
  }
});

test("an unobservable milestone is not scored as measured disadvantage", () => {
  // The mirror of "missing evidence must not become a favourable zero": it must not become
  // an UNFAVOURABLE one either, or candidates get penalised for our coverage gaps.
  const base = population({ n: 25, sessions: 5, make: () => ({ postEntryQuotes: 800 }) });
  const cohort = computeCohortV2(base, KEY);
  const tailRow = cohort.milestones.find((m) => m.milestone === 100);
  assert.equal(tailRow.observation, "OBSERVED_ZERO");

  const observedZero = scoreHistoricalEdgeShadow({ cohort, discovery: null, contract: null });
  const tail = observedZero.components.find((c) => c.name === "tailUpside");
  assert.equal(tail.value, 0, "an observed zero IS a finding and is scored");
  assert.ok(
    observedZero.warnings.some((w) => w.includes("OBSERVED ZERO")),
    "but the reader is told it is a bound, not an impossibility",
  );

  // The same cohort with the tail milestone genuinely unobservable.
  const unavailable = {
    ...cohort,
    milestones: cohort.milestones.map((m) =>
      m.milestone === 100
        ? { ...m, observation: "EVIDENCE_UNAVAILABLE", probability: null, of: 0, upperBound95: null }
        : m),
  };
  const s = scoreHistoricalEdgeShadow({ cohort: unavailable, discovery: null, contract: null });
  const t = s.components.find((c) => c.name === "tailUpside");
  assert.equal(t.value, null, "unobservable must be null, not 0");
});
