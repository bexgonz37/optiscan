/**
 * tests/pre-move-discovery-v2.test.mjs
 *
 * PRE_MOVE_DISCOVERY_V2. The properties under test are the two that make it a
 * measurement rather than a compliment:
 *
 *   1. MAGNITUDE OUTRANKS STRUCTURE AT THE LATE END. A put alerted at the session
 *      low, with the whole day's downside already travelled, is TOO_LATE — even
 *      though its trigger never printed. V1 answered PRE_TRIGGER there, which is
 *      how it graded 70/70 owner rows, 122/125 research rows and 4943/5000 shadow
 *      rows the same way in production.
 *
 *   2. NOTHING IS BACK-FILLED. A row without an alert-instant session snapshot is
 *      not a V2 row, and the running session extent V1 maintains — which keeps
 *      WIDENING after the alert — may never be used as the denominator.
 *
 * Fixture is the SAME migration production runs, not a hand-copy.
 */
import "./helpers/register-alias.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  classifyDiscoveryV2,
  measureDiscoveryOutcomeV2,
  checkDiscoveryV2Frozen,
  discoveryV2DefinitionHash,
  sessionMoveConsumedFractionV2,
  favorableMovePctV2,
  PRE_MOVE_DISCOVERY_V2_DEFINITION_HASH,
  PRE_MOVE_DISCOVERY_V2_DEFINITION,
  DISCOVERY_V2_THRESHOLDS,
} from "../lib/research/options/pre-move-discovery-v2.ts";
import {
  recordPreMoveV2AlertOnDb,
  listPreMoveV2RowsOnDb,
  preMoveV2CoverageOnDb,
} from "../lib/research/options/pre-move-v2-store.ts";
import { recordPreMoveObservationOnDb } from "../lib/research/options/pre-move-store.ts";
import { classifyDiscovery } from "../lib/research/options/pre-move-discovery.ts";
import { buildPreMoveV2Report } from "../lib/research/options/pre-move-v2-report.ts";

const { applyProductionSchemaOnDb } = await import("@/lib/db");

const T0 = Date.parse("2026-08-19T13:35:00.000Z");
const MIN = 60_000;
const OCC = "O:IWM260819P00301000";

function db() {
  const d = new Database(":memory:");
  applyProductionSchemaOnDb(d);
  return d;
}

/** A PUT whose underlying sits `consumed` of the way from the session high to the low. */
const putAt = (consumed, extra = {}) => ({
  side: "PUT",
  sessionHighAtAlert: 200,
  sessionLowAtAlert: 100,
  underlyingAtAlert: 200 - consumed * 100,
  ...extra,
});

// ── the classification ───────────────────────────────────────────────────────

test("direction signing: a PUT profits from a fall, so a fall is POSITIVE consumption", () => {
  assert.equal(favorableMovePctV2("PUT", 100, 98), 2);
  assert.equal(favorableMovePctV2("CALL", 100, 98), -2);
  assert.equal(favorableMovePctV2("CALL", 100, 102), 2);
});

test("a PUT at the session HIGH has spent none of the day's downside", () => {
  assert.equal(sessionMoveConsumedFractionV2("PUT", 200, 200, 100), 0);
});

test("a PUT at the session LOW has spent ALL of it — the V1 inversion", () => {
  assert.equal(sessionMoveConsumedFractionV2("PUT", 100, 200, 100), 1);
});

test("a CALL is the mirror image of the same measurement", () => {
  assert.equal(sessionMoveConsumedFractionV2("CALL", 100, 200, 100), 0);
  assert.equal(sessionMoveConsumedFractionV2("CALL", 200, 200, 100), 1);
});

test("THE HEADLINE FIX — an untaken trigger with the whole move spent is TOO_LATE, not PRE_TRIGGER", () => {
  const obs = putAt(0.95, { triggerTakenAtAlert: false });

  const v2 = classifyDiscoveryV2(obs);
  assert.equal(v2.stage, "TOO_LATE");
  assert.match(v2.reason, /95%/);

  // The same setup through V1, which short-circuits on trigger state and never looks
  // at how much of the move is behind it.
  const v1 = classifyDiscovery({
    side: "PUT",
    underlyingAtFirstDetection: 105,
    underlyingAtAlert: 105,
    triggerTaken: false,
    sessionHigh: 200,
    sessionLow: 100,
  });
  assert.equal(v1.stage, "PRE_TRIGGER", "V1's answer is preserved, not corrected in place");
});

test("V1 is never rewritten: both classifiers still answer, and they may disagree", () => {
  assert.equal(PRE_MOVE_DISCOVERY_V2_DEFINITION.supersedes, "PRE_MOVE_DISCOVERY_V1");
  assert.equal(PRE_MOVE_DISCOVERY_V2_DEFINITION.v1RowsUnchanged, true);
  assert.equal(PRE_MOVE_DISCOVERY_V2_DEFINITION.affectsDelivery, false);
  assert.equal(PRE_MOVE_DISCOVERY_V2_DEFINITION.authority, "MEASUREMENT_ONLY");
});

test("structure decides only at the early end, and it decides both ways", () => {
  assert.equal(classifyDiscoveryV2(putAt(0.05, { triggerTakenAtAlert: false })).stage, "PRE_TRIGGER_WATCH");
  assert.equal(classifyDiscoveryV2(putAt(0.05, { triggerTakenAtAlert: true })).stage, "EARLY_CONFIRMATION");
  assert.equal(classifyDiscoveryV2(putAt(0.18, { triggerTakenAtAlert: true })).stage, "EARLY_EXPANSION");
  assert.equal(classifyDiscoveryV2(putAt(0.18, { triggerTakenAtAlert: false })).stage, "PRE_TRIGGER_WATCH");
});

test("every stage is reachable — the metric has variance, which is the whole complaint about V1", () => {
  const seen = new Set();
  for (const taken of [true, false, null]) {
    for (const c of [0, 0.15, 0.4, 0.7, 0.95]) {
      seen.add(classifyDiscoveryV2(putAt(c, { triggerTakenAtAlert: taken })).stage);
    }
  }
  for (const s of ["PRE_TRIGGER_WATCH", "EARLY_CONFIRMATION", "EARLY_EXPANSION", "MATURE_MOVE", "TOO_LATE", "UNGRADABLE"]) {
    assert.ok(seen.has(s), `stage ${s} is unreachable`);
  }
});

test("an unobserved trigger at low consumption is UNGRADABLE, not a guess", () => {
  const c = classifyDiscoveryV2(putAt(0.05, { triggerTakenAtAlert: null }));
  assert.equal(c.stage, "UNGRADABLE");
  assert.equal(c.triggerState, "UNKNOWN");
  assert.ok(c.missingInputs.includes("triggerTakenAtAlert"));
  assert.match(c.reason, /cannot be distinguished/);
});

test("no session range means UNGRADABLE — 'nothing to be early for' is not 'we were late'", () => {
  const c = classifyDiscoveryV2({
    side: "PUT", underlyingAtAlert: 100, sessionHighAtAlert: 100, sessionLowAtAlert: 100,
    triggerTakenAtAlert: false,
  });
  assert.equal(c.stage, "UNGRADABLE");
  assert.equal(c.sessionMoveConsumedFraction, null);
  assert.equal(c.rewardRemainingFraction, null, "unknown remaining reward is null, never 0");
});

test("a missing alert-instant snapshot is UNGRADABLE and says which input was absent", () => {
  const c = classifyDiscoveryV2({
    side: "PUT", underlyingAtAlert: 150, sessionHighAtAlert: null, sessionLowAtAlert: 100,
    triggerTakenAtAlert: false,
  });
  assert.equal(c.stage, "UNGRADABLE");
  assert.ok(c.missingInputs.includes("sessionHighAtAlert"));
});

test("premium expansion over a 1.6-second window is NULL, not 0% — V1's flattering answer", () => {
  const c = classifyDiscoveryV2(putAt(0.3, {
    triggerTakenAtAlert: false,
    optionAtFirstDetection: 1.0,
    optionAtAlert: 1.0,
    timeline: { firstSetupObservedAtMs: T0, ownerCalloutAtMs: T0 + 1619 },
  }));
  assert.equal(c.premiumExpansionConsumedPct, null,
    "0% reads as 'the delay cost nothing'; it actually means 'the two prices are one tick'");
  assert.ok(c.missingInputs.includes("premiumExpansionConsumedPct"));
});

test("premium expansion across genuinely distinct observations IS measured", () => {
  const c = classifyDiscoveryV2(putAt(0.3, {
    triggerTakenAtAlert: false,
    optionAtFirstDetection: 1.0,
    optionAtAlert: 1.4,
    timeline: { firstSetupObservedAtMs: T0, ownerCalloutAtMs: T0 + 10 * MIN },
  }));
  assert.equal(c.premiumExpansionConsumedPct, 40);
  assert.ok(!c.missingInputs.includes("premiumExpansionConsumedPct"));
});

test("reward remaining is the complement of consumption and falls as the move is spent", () => {
  assert.equal(classifyDiscoveryV2(putAt(0.1, { triggerTakenAtAlert: false })).rewardRemainingFraction, 0.9);
  assert.equal(classifyDiscoveryV2(putAt(0.9, { triggerTakenAtAlert: false })).rewardRemainingFraction, 0.1);
});

test("the timeline carries the five instants and the gaps between them", () => {
  const c = classifyDiscoveryV2(putAt(0.3, {
    triggerTakenAtAlert: false,
    timeline: {
      firstSetupObservedAtMs: T0,
      firstPartialConfirmationAtMs: T0 + 2 * MIN,
      firstFullConfirmationAtMs: T0 + 5 * MIN,
      ownerCalloutAtMs: T0 + 6 * MIN,
    },
  }));
  assert.equal(c.setupToCalloutMs, 6 * MIN);
  assert.equal(c.fullConfirmationToCalloutMs, 1 * MIN);
  assert.equal(c.timeline.firstPartialConfirmationAtMs, T0 + 2 * MIN);
  assert.equal(c.timeline.firstExpansionAtMs, null, "an unobserved instant is null, not the callout");
});

// ── outcomes are hindsight and live somewhere else ───────────────────────────

test("milestone times are measured FROM the callout; a pre-callout touch is never lead time", () => {
  const classification = classifyDiscoveryV2(putAt(0.3, { triggerTakenAtAlert: false }));
  const o = measureDiscoveryOutcomeV2({
    classification,
    calloutAtMs: T0 + 5 * MIN,
    marks: [
      { atMs: T0 + 1 * MIN, returnPct: 40, premium: 2.0 },   // BEFORE the callout
      { atMs: T0 + 7 * MIN, returnPct: 12, premium: 1.2 },
      { atMs: T0 + 20 * MIN, returnPct: 30, premium: 1.5 },
    ],
    entryPremium: 1.0,
    target1Premium: 1.45,
    excursionVerified: true,
  });
  assert.equal(o.msToPlus10, 2 * MIN, "the +40% print before the callout cannot be claimed");
  assert.equal(o.msToPlus25, 15 * MIN);
  assert.equal(o.msToTarget1, 15 * MIN);
  assert.equal(o.msToTarget2, null, "no T2 supplied means unavailable, not reached");
});

test("targets are reached on PREMIUM, and a mark without one cannot reach them", () => {
  const classification = classifyDiscoveryV2(putAt(0.3, { triggerTakenAtAlert: false }));
  const o = measureDiscoveryOutcomeV2({
    classification,
    calloutAtMs: T0,
    marks: [{ atMs: T0 + MIN, returnPct: 500, premium: null }],
    target1Premium: 1.45,
  });
  assert.equal(o.msToTarget1, null,
    "a 500% return recomputed from an unknown entry is not proof the premium touched T1");
});

test("a stage never sees an outcome, and an outcome never moves a stage", () => {
  const early = classifyDiscoveryV2(putAt(0.05, { triggerTakenAtAlert: true }));
  const withWin = measureDiscoveryOutcomeV2({
    classification: early, calloutAtMs: T0,
    marks: [{ atMs: T0 + MIN, returnPct: 300, premium: 4 }],
    realizedReturnPct: 300, excursionVerified: true,
  });
  const withLoss = measureDiscoveryOutcomeV2({
    classification: early, calloutAtMs: T0,
    marks: [{ atMs: T0 + MIN, returnPct: -90, premium: 0.1 }],
    realizedReturnPct: -90, excursionVerified: true,
  });
  assert.equal(withWin.stage, withLoss.stage, "the stage is decided before any of this exists");
  assert.equal(withWin.eventualWinner, true);
  assert.equal(withLoss.eventualWinner, false);
  assert.equal(withLoss.neverConfirmed, true);
  assert.equal(withWin.neverConfirmed, false);
});

test("a post-callout MFE is reported only when the excursion evidence is verified", () => {
  const c = classifyDiscoveryV2(putAt(0.3, { triggerTakenAtAlert: false }));
  const unverified = measureDiscoveryOutcomeV2({
    classification: c, calloutAtMs: T0,
    marks: [{ atMs: T0 + MIN, returnPct: 50, premium: 1.5 }],
    excursionVerified: false,
  });
  assert.equal(unverified.postCalloutMfePct, null);
  assert.equal(unverified.neverConfirmed, null, "unknown is null, never false");
});

// ── the definition is frozen ─────────────────────────────────────────────────

test("the V2 definition is frozen and the hash tracks BEHAVIOUR, not source text", () => {
  const check = checkDiscoveryV2Frozen();
  assert.equal(check.frozen, true, check.message);
  assert.equal(check.actual, PRE_MOVE_DISCOVERY_V2_DEFINITION_HASH);
  assert.equal(discoveryV2DefinitionHash(), PRE_MOVE_DISCOVERY_V2_DEFINITION_HASH);
});

test("every stage boundary is a named constant, so none can move unnoticed", () => {
  for (const k of ["tooLateConsumed", "matureConsumed", "expansionConsumed", "expansionAfterTriggerConsumed"]) {
    assert.equal(typeof DISCOVERY_V2_THRESHOLDS[k], "number", `${k} must be a named threshold`);
  }
  assert.throws(() => { DISCOVERY_V2_THRESHOLDS.tooLateConsumed = 0.99; },
    "the thresholds are frozen so a runtime retune cannot dodge the definition hash");
});

// ── the store is prospective-only ────────────────────────────────────────────

function seedObservation(d, caseId) {
  recordPreMoveObservationOnDb(d, {
    opportunityCaseId: caseId, sessionDate: "2026-08-19", symbol: "IWM", direction: "bearish",
    side: "PUT", optionSymbol: OCC, strategyKey: "lower_high_continuation", deploymentSha: "sha",
    lane: "SHADOW", nowMs: T0, eligible: true, underlyingPrice: 302, optionAsk: 0.98,
    // The RUNNING extent V1 maintains. It keeps widening all day.
    sessionHigh: 305, sessionLow: 295, triggerLevel: 300, triggerTaken: false,
  });
}

test("a row with no V2 capture is not a V2 row at all", () => {
  const d = db();
  seedObservation(d, "oc_nov2");
  assert.deepEqual(listPreMoveV2RowsOnDb(d), []);
  const cov = preMoveV2CoverageOnDb(d);
  assert.equal(cov.available, true);
  assert.equal(cov.capturedRows, 0);
  assert.equal(cov.uncapturedRows, 1, "it is counted as uncaptured, never as UNGRADABLE");
});

test("the capture writes the alert-instant snapshot and the stage together", () => {
  const d = db();
  seedObservation(d, "oc_v2a");
  const res = recordPreMoveV2AlertOnDb(d, {
    opportunityCaseId: "oc_v2a",
    side: "PUT",
    ownerNotifiedAtMs: T0 + 90 * MIN,
    underlyingAtAlert: 296,
    sessionHighAtAlert: 306,
    sessionLowAtAlert: 294,
    triggerTakenAtAlert: false,
    entryPremium: 0.986, target1Premium: 1.42, target2Premium: 1.86, stopPremium: 0.59,
  });
  assert.equal(res.stored, true);
  // (306 - 296) / (306 - 294) = 0.8333 → MATURE_MOVE, not "the move has not begun".
  assert.equal(res.stage, "MATURE_MOVE");

  const [row] = listPreMoveV2RowsOnDb(d);
  assert.equal(row.captured, true);
  assert.equal(row.stage, "MATURE_MOVE");
  assert.equal(row.triggerState, "NOT_TAKEN");
  assert.equal(row.sessionHighAtAlert, 306);
  assert.equal(row.target1Premium, 1.42);
  assert.equal(row.definitionHash, PRE_MOVE_DISCOVERY_V2_DEFINITION_HASH,
    "the stage is stored with the definition that produced it");
});

test("THE HINDSIGHT TRAP — a later, wider session does not move an already-captured stage", () => {
  const d = db();
  seedObservation(d, "oc_v2b");
  const first = recordPreMoveV2AlertOnDb(d, {
    opportunityCaseId: "oc_v2b", side: "PUT", ownerNotifiedAtMs: T0 + 30 * MIN,
    underlyingAtAlert: 296, sessionHighAtAlert: 306, sessionLowAtAlert: 294,
    triggerTakenAtAlert: false,
  });
  assert.equal(first.stage, "MATURE_MOVE");

  // The day carries on and the range widens enormously. Re-running the capture against
  // the grown extent reports the SAME callout as PRE_TRIGGER_WATCH — a mature move
  // relabelled as one that had not started, purely because the afternoon extended the
  // denominator. That is the entire defect this write-once rule exists to prevent, and
  // it runs in the flattering direction every time.
  const wouldBe = classifyDiscoveryV2({
    side: "PUT", underlyingAtAlert: 296, sessionHighAtAlert: 306, sessionLowAtAlert: 250,
    triggerTakenAtAlert: false,
  });
  assert.equal(wouldBe.stage, "PRE_TRIGGER_WATCH", "the grown range really would flatter this callout");

  const second = recordPreMoveV2AlertOnDb(d, {
    opportunityCaseId: "oc_v2b", side: "PUT", ownerNotifiedAtMs: T0 + 300 * MIN,
    underlyingAtAlert: 296, sessionHighAtAlert: 306, sessionLowAtAlert: 250,
    triggerTakenAtAlert: false,
  });
  assert.equal(second.stored, false, "the snapshot is write-once");

  const [row] = listPreMoveV2RowsOnDb(d);
  assert.equal(row.stage, "MATURE_MOVE", "the stage the decision was actually made under");
  assert.equal(row.sessionLowAtAlert, 294);
});

test("the capture never touches a V1 column", () => {
  const d = db();
  seedObservation(d, "oc_v2c");
  const before = d.prepare(
    "SELECT discovery_stage, move_consumed_fraction, reward_remaining_fraction, session_low FROM opportunity_pre_move_discovery WHERE opportunity_case_id=?",
  ).get("oc_v2c");
  recordPreMoveV2AlertOnDb(d, {
    opportunityCaseId: "oc_v2c", side: "PUT", ownerNotifiedAtMs: T0 + MIN,
    underlyingAtAlert: 296, sessionHighAtAlert: 306, sessionLowAtAlert: 294,
    triggerTakenAtAlert: false,
  });
  const after = d.prepare(
    "SELECT discovery_stage, move_consumed_fraction, reward_remaining_fraction, session_low FROM opportunity_pre_move_discovery WHERE opportunity_case_id=?",
  ).get("oc_v2c");
  assert.deepEqual(after, before, "V1's reading of this callout is history and stays history");
});

// ── the report refuses to conclude from a young sample ───────────────────────

test("the report is INSUFFICIENT_EVIDENCE until the prospective floors are met", () => {
  const d = db();
  seedObservation(d, "oc_r1");
  recordPreMoveV2AlertOnDb(d, {
    opportunityCaseId: "oc_r1", side: "PUT", ownerNotifiedAtMs: T0,
    underlyingAtAlert: 296, sessionHighAtAlert: 306, sessionLowAtAlert: 294,
    triggerTakenAtAlert: false,
  });
  const r = buildPreMoveV2Report(d, {});
  assert.equal(r.verdict, "INSUFFICIENT_EVIDENCE");
  assert.equal(r.definitionFrozen.frozen, true);
  assert.equal(r.population.rows, 1);
  for (const q of r.questions) {
    assert.equal(q.supported, false);
    assert.match(q.answer, /INSUFFICIENT_EVIDENCE/);
  }
  assert.ok(r.limitations.some((l) => /PROSPECTIVE ONLY/.test(l)));
  assert.match(r.note, /MEASUREMENT ONLY/);
});

test("an empty database produces an empty report, not a zero-filled one", () => {
  const r = buildPreMoveV2Report(db(), {});
  assert.equal(r.population.rows, 0);
  assert.equal(r.population.closedOutcomes, 0);
  assert.equal(r.verdict, "INSUFFICIENT_EVIDENCE");
  for (const s of r.byStage) {
    assert.equal(s.winRate, null, "no trades means unknown win rate, never 0%");
    assert.equal(s.profitFactor, null);
    assert.equal(s.supported, false);
  }
});

test("a weekend date cannot clear the independent-session floor", () => {
  const d = db();
  // 2026-08-22 and 2026-08-23 are a Saturday and a Sunday.
  for (const [i, date] of [["a", "2026-08-22"], ["b", "2026-08-23"]]) {
    const caseId = `oc_wk${i}`;
    recordPreMoveObservationOnDb(d, {
      opportunityCaseId: caseId, sessionDate: date, symbol: "IWM", direction: "bearish",
      side: "PUT", optionSymbol: OCC, strategyKey: "lhc", deploymentSha: "sha", lane: "SHADOW",
      nowMs: T0, eligible: true, underlyingPrice: 302, optionAsk: 0.98,
      sessionHigh: 305, sessionLow: 295, triggerLevel: 300, triggerTaken: false,
    });
    recordPreMoveV2AlertOnDb(d, {
      opportunityCaseId: caseId, side: "PUT", ownerNotifiedAtMs: T0,
      underlyingAtAlert: 296, sessionHighAtAlert: 306, sessionLowAtAlert: 294,
      triggerTakenAtAlert: false,
    });
  }
  const r = buildPreMoveV2Report(d, {});
  assert.equal(r.population.independentSessions, 0, "a calendar date is not a trading session");
});
