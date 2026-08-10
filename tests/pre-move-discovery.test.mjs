/**
 * tests/pre-move-discovery.test.mjs
 *
 * PRE_MOVE_DISCOVERY_V1 answers the question the retired metric could not: did
 * OptiScan find the opportunity BEFORE the profitable move?
 *
 * The retired metric computed (price − LOD) / (HOD − LOD) and called a low reading
 * "early". For a PUT that is the moment the downside move has already happened — the
 * latest possible entry, labelled the earliest. The first test below is that exact
 * case, and it is the reason this module exists.
 *
 * Also pinned:
 *   - CALL and PUT are mirror images under the same code path
 *   - the classification reads nothing dated after the alert (no hindsight)
 *   - outcomes appear only in gradeDiscovery, which asks a different question
 *   - lead time separates "we alerted 12 minutes before +25%" from "it had already
 *     gained 47% before we alerted"
 *   - reward-remaining returns null, never 0, when there is nothing to measure
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyDiscovery,
  favorableMovePct,
  moveConsumedFraction,
  computeAlertLeadTime,
  computeRewardRemaining,
  gradeDiscovery,
  PRE_MOVE_DISCOVERY_VERSION,
} from "../lib/research/options/pre-move-discovery.ts";
import {
  classifySessionRangePosition,
  sessionRangeFraction,
  SESSION_RANGE_POSITION_SEMANTICS,
} from "../lib/research/options/session-range-position.ts";

const T = Date.parse("2026-08-10T14:00:00.000Z");

// ── the defect that motivated the module ────────────────────────────────────

test("THE BUG: a completed downside move reads 'early' under the retired metric", () => {
  // GOOGL fell from a 360 high to a 352 low; price is at the low. For a PUT the entire
  // downside move is spent — the worst possible moment to buy.
  const fraction = sessionRangeFraction(352.2, 360, 352);
  assert.ok(fraction <= 0.4);
  assert.equal(classifySessionRangePosition(fraction), "early", "the retired metric says EARLY");

  // Direction-aware, the same moment is correctly TOO_LATE.
  const c = classifyDiscovery({
    side: "PUT",
    underlyingAtFirstDetection: 360,
    underlyingAtEligible: 356,
    underlyingAtAlert: 352.2,
    optionAtFirstDetection: 1.10,
    optionAtEligible: 1.80,
    optionAtAlert: 2.33,
    sessionOpen: 360,
    sessionHigh: 360,
    sessionLow: 352,
    triggerTaken: true,
  });
  assert.equal(c.stage, "TOO_LATE");
  assert.ok(c.moveConsumedFraction >= 0.95);
  assert.equal(SESSION_RANGE_POSITION_SEMANTICS.directionAware, false);
});

// ── direction awareness ─────────────────────────────────────────────────────

test("favourable movement is signed by the contract, not the chart", () => {
  // Underlying falls 2%.
  assert.equal(favorableMovePct("PUT", 100, 98), 2, "a PUT profits when the underlying falls");
  assert.equal(favorableMovePct("CALL", 100, 98), -2, "the same move is adverse for a CALL");
  // Underlying rises 2%.
  assert.equal(favorableMovePct("CALL", 100, 102), 2);
  assert.equal(favorableMovePct("PUT", 100, 102), -2);
});

test("CALL and PUT are mirror images through the same code path", () => {
  const call = classifyDiscovery({
    side: "CALL",
    underlyingAtFirstDetection: 100,
    underlyingAtAlert: 101,
    optionAtFirstDetection: 1.00,
    optionAtAlert: 1.05,
    sessionOpen: 100, sessionHigh: 110, sessionLow: 100,
    triggerTaken: true,
  });
  const put = classifyDiscovery({
    side: "PUT",
    underlyingAtFirstDetection: 100,
    underlyingAtAlert: 99,
    optionAtFirstDetection: 1.00,
    optionAtAlert: 1.05,
    sessionOpen: 100, sessionHigh: 100, sessionLow: 90,
    triggerTaken: true,
  });
  assert.equal(call.stage, put.stage);
  assert.equal(call.underlyingMoveConsumedPct, 1);
  assert.equal(put.underlyingMoveConsumedPct, 1);
  assert.equal(call.moveConsumedFraction, put.moveConsumedFraction);
});

test("a PUT found before the move is EARLY, and the same for a CALL", () => {
  const put = classifyDiscovery({
    side: "PUT",
    underlyingAtFirstDetection: 360,
    underlyingAtAlert: 359.5,
    optionAtFirstDetection: 2.20,
    optionAtAlert: 2.33,
    sessionOpen: 360, sessionHigh: 360, sessionLow: 350,
    triggerTaken: true,
  });
  assert.equal(put.stage, "EARLY_CONFIRMATION");
  assert.ok(put.moveConsumedFraction <= 0.1, "almost none of the downside was spent");
});

// ── stages ──────────────────────────────────────────────────────────────────

test("an untaken trigger is PRE_TRIGGER regardless of range position", () => {
  const c = classifyDiscovery({
    side: "CALL",
    underlyingAtFirstDetection: 100,
    underlyingAtAlert: 104,
    optionAtFirstDetection: 1.0,
    optionAtAlert: 1.4,
    sessionOpen: 100, sessionHigh: 110, sessionLow: 99,
    triggerLevel: 106,
    triggerTaken: false,
  });
  assert.equal(c.stage, "PRE_TRIGGER", "a move that has not begun cannot be partly spent");
});

test("premium already expanding with room left is EARLY_EXPANSION", () => {
  const c = classifyDiscovery({
    side: "CALL",
    underlyingAtFirstDetection: 100,
    underlyingAtAlert: 102,
    optionAtFirstDetection: 1.00,
    optionAtAlert: 1.30,
    sessionOpen: 100, sessionHigh: 110, sessionLow: 100,
    triggerTaken: true,
  });
  assert.equal(c.stage, "EARLY_EXPANSION");
  assert.equal(c.premiumExpansionConsumedPct, 30);
});

test("most of the move spent is MATURE_MOVE, nearly all is TOO_LATE", () => {
  const mature = classifyDiscovery({
    side: "CALL",
    underlyingAtFirstDetection: 100, underlyingAtAlert: 107,
    optionAtFirstDetection: 1, optionAtAlert: 2,
    sessionOpen: 100, sessionHigh: 110, sessionLow: 100, triggerTaken: true,
  });
  assert.equal(mature.stage, "MATURE_MOVE");

  const late = classifyDiscovery({
    side: "CALL",
    underlyingAtFirstDetection: 100, underlyingAtAlert: 109.5,
    optionAtFirstDetection: 1, optionAtAlert: 3,
    sessionOpen: 100, sessionHigh: 110, sessionLow: 100, triggerTaken: true,
  });
  assert.equal(late.stage, "TOO_LATE");
});

// ── missing inputs stay missing ─────────────────────────────────────────────

test("absent inputs produce UNGRADABLE and name what was missing", () => {
  const c = classifyDiscovery({
    side: "CALL",
    underlyingAtFirstDetection: null,
    underlyingAtEligible: null,
    underlyingAtAlert: null,
    optionAtFirstDetection: null,
    optionAtEligible: null,
    optionAtAlert: null,
  });
  assert.equal(c.stage, "UNGRADABLE");
  assert.equal(c.underlyingMoveConsumedPct, null, "unknown is null, never 0");
  assert.ok(c.missingInputs.includes("underlyingAtFirstDetection"));
  assert.ok(c.missingInputs.includes("underlyingAtAlert"));
});

test("a session with no favourable extent is unmeasurable, not late", () => {
  // A CALL on a day that only ever fell: there was nothing to be early for.
  const f = moveConsumedFraction("CALL", 100, 98, 100, 95);
  assert.equal(f, null, "no favourable extent means unknown, not 0% or 100%");
});

// ── no hindsight ────────────────────────────────────────────────────────────

test("the classification is unchanged by anything that happened after the alert", () => {
  const obs = {
    side: "CALL",
    underlyingAtFirstDetection: 100,
    underlyingAtAlert: 102,
    optionAtFirstDetection: 1.00,
    optionAtAlert: 1.30,
    sessionOpen: 100, sessionHigh: 110, sessionLow: 100,
    triggerTaken: true,
    firstDetectedAtMs: T,
    alertAtMs: T + 300_000,
  };
  const a = classifyDiscovery(obs);
  // Outcomes are supplied only to the grader, and only afterwards.
  const wonBig = gradeDiscovery(a, { realizedReturnPct: 300, postAlertMfePct: 300 });
  const lostAll = gradeDiscovery(a, { realizedReturnPct: -90, postAlertMfePct: -90 });
  assert.equal(classifyDiscovery(obs).stage, a.stage, "the label does not move with the outcome");
  assert.equal(wonBig.stage, a.stage);
  assert.equal(lostAll.stage, a.stage);
  // The GRADE differs, which is the point of keeping them apart.
  assert.equal(wonBig.classificationWasUseful, true);
  assert.equal(lostAll.classificationWasUseful, false);
});

test("an unverified excursion cannot grade a classification", () => {
  const c = classifyDiscovery({
    side: "CALL",
    underlyingAtFirstDetection: 100, underlyingAtAlert: 102,
    optionAtFirstDetection: 1, optionAtAlert: 1.3,
    sessionOpen: 100, sessionHigh: 110, sessionLow: 100, triggerTaken: true,
  });
  const g = gradeDiscovery(c, { realizedReturnPct: 47, postAlertMfePct: null });
  assert.equal(g.classificationWasUseful, null, "no verified excursion means ungraded, not failed");
});

// ── lead time ───────────────────────────────────────────────────────────────

test("lead time measures from the alert and reports pre-alert gains separately", () => {
  const alertAtMs = T + 600_000;
  const lead = computeAlertLeadTime({
    alertAtMs,
    excursionVerified: true,
    premiumConsumedBeforeAlertPct: 47.2103,
    marks: [
      // Before the alert — the option had already run.
      { atMs: T, returnPct: 0 },
      { atMs: T + 300_000, returnPct: 30 },
      // After the alert.
      { atMs: alertAtMs + 120_000, returnPct: 12 },
      { atMs: alertAtMs + 720_000, returnPct: 28 },
      { atMs: alertAtMs + 1_260_000, returnPct: 55 },
    ],
  });
  assert.equal(lead.msToMilestone["10"], 120_000, "+10% reached 2 minutes after the alert");
  assert.equal(lead.msToMilestone["25"], 720_000, "+25% reached 12 minutes after the alert");
  assert.equal(lead.msToMilestone["50"], 1_260_000, "+50% reached 21 minutes after the alert");
  assert.equal(lead.msToMilestone["200"], null, "never reached stays null");
  assert.equal(lead.postAlertMfePct, 55);

  // The other half of the story: the move that happened before we spoke.
  assert.equal(lead.premiumConsumedBeforeAlertPct, 47.2103);
  assert.deepEqual(lead.milestonesReachedBeforeAlert, [10, 25]);
});

test("a pre-alert milestone is never counted as lead time", () => {
  const alertAtMs = T + 600_000;
  const lead = computeAlertLeadTime({
    alertAtMs,
    excursionVerified: true,
    marks: [{ atMs: T, returnPct: 80 }],
  });
  for (const v of Object.values(lead.msToMilestone)) {
    assert.equal(v, null, "the alert cannot claim credit for a move that preceded it");
  }
  assert.deepEqual(lead.milestonesReachedBeforeAlert, [10, 25, 50]);
});

test("no alert timestamp means lead time is unavailable, not zero", () => {
  const lead = computeAlertLeadTime({ alertAtMs: null, marks: [{ atMs: T, returnPct: 50 }] });
  assert.equal(lead.msToMilestone["25"], null);
  assert.match(lead.note, /unavailable, not zero/);
});

test("post-alert MFE is withheld unless the excursion is verified", () => {
  const marks = [
    { atMs: T + 1000, returnPct: 10 },
    { atMs: T + 2000, returnPct: 40 },
    { atMs: T + 3000, returnPct: 25 },
  ];
  assert.equal(computeAlertLeadTime({ alertAtMs: T, marks, excursionVerified: false }).postAlertMfePct, null);
  assert.equal(computeAlertLeadTime({ alertAtMs: T, marks, excursionVerified: true }).postAlertMfePct, 40);
});

// ── reward remaining ────────────────────────────────────────────────────────

test("reward remaining separates 'most of it is gone' from 'most of it is ahead'", () => {
  const early = computeRewardRemaining(classifyDiscovery({
    side: "CALL",
    underlyingAtFirstDetection: 100, underlyingAtAlert: 101,
    optionAtFirstDetection: 1, optionAtAlert: 1.05,
    sessionOpen: 100, sessionHigh: 110, sessionLow: 100, triggerTaken: true,
  }));
  assert.equal(early.band, "LARGE_REMAINING");
  assert.ok(early.fraction >= 0.85);

  const late = computeRewardRemaining(classifyDiscovery({
    side: "CALL",
    underlyingAtFirstDetection: 100, underlyingAtAlert: 109,
    optionAtFirstDetection: 1, optionAtAlert: 3,
    sessionOpen: 100, sessionHigh: 110, sessionLow: 100, triggerTaken: true,
  }));
  assert.equal(late.band, "MOSTLY_SPENT");
  assert.ok(late.fraction <= 0.15);
});

test("reward remaining is null, never 0, when nothing can be measured", () => {
  const r = computeRewardRemaining(classifyDiscovery({
    side: "CALL",
    underlyingAtFirstDetection: null,
    underlyingAtEligible: null,
    underlyingAtAlert: null,
    optionAtFirstDetection: null,
    optionAtEligible: null,
    optionAtAlert: null,
  }));
  assert.equal(r.fraction, null);
  assert.equal(r.band, "UNAVAILABLE");
  assert.equal(r.advisoryOnly, true);
  assert.match(r.basis, /unknown, not zero/);
});

test("every output is version-stamped so a later V2 cannot be mistaken for it", () => {
  const c = classifyDiscovery({
    side: "CALL", underlyingAtFirstDetection: 100, underlyingAtAlert: 101,
    optionAtFirstDetection: 1, optionAtAlert: 1.05,
    sessionOpen: 100, sessionHigh: 110, sessionLow: 100, triggerTaken: true,
  });
  assert.equal(c.version, PRE_MOVE_DISCOVERY_VERSION);
  assert.equal(computeRewardRemaining(c).version, PRE_MOVE_DISCOVERY_VERSION);
  assert.equal(computeAlertLeadTime({ alertAtMs: T, marks: [] }).version, PRE_MOVE_DISCOVERY_VERSION);
  assert.equal(SESSION_RANGE_POSITION_SEMANTICS.supersededBy, PRE_MOVE_DISCOVERY_VERSION);
});
