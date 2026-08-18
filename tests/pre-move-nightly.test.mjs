/**
 * tests/pre-move-nightly.test.mjs
 *
 * The deterministic pre-move section of the nightly. The property under test is the one
 * that separates "we found it early" from "it worked":
 *
 *     A MILESTONE REACHED BEFORE THE ALERT IS NOT LEAD TIME.
 *
 * A trade that had already run +60% before we spoke closes at the same realized number
 * as one alerted before it moved. Counting the pre-alert part as lead time would report
 * the late alert as the better discovery, which is the exact inversion of the finding
 * the nightly exists to surface.
 *
 * Fixture is the SAME migration production runs, not a hand-copy.
 */
import "./helpers/register-alias.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { recordPreMoveObservationOnDb, recordPreMoveAlertOnDb } from "../lib/research/options/pre-move-store.ts";
import { buildPreMoveNightlyReport } from "../lib/research/options/pre-move-nightly.ts";

const { applyProductionSchemaOnDb } = await import("@/lib/db");

const T0 = Date.parse("2026-08-10T13:35:00.000Z");
const MIN = 60_000;
const OCC = "O:NVDA260814C00180000";
const FOREIGN = "O:NVDA260821C00185000";

function db() {
  const d = new Database(":memory:");
  applyProductionSchemaOnDb(d);
  return d;
}

/**
 * One alerted owner case with a mirror on the exact contract.
 * `marks` are [returnPct, offsetMsFromDetection] pairs.
 *
 * NO ALERT ID ANYWHERE, deliberately. An owner callout never writes an `options_alerts`
 * row, so `opportunity_cases.alert_id` and `options_paper_trades.alert_id` are both null
 * in production — 0 of 106 and 0 of 74 respectively at 801b7d0d. This fixture used to set
 * both, which is the subscriber lane's shape, and so it could only ever exercise the join
 * that never fires for a real owner trade.
 *
 * The link that DOES exist is the opportunity case recorded on the mirror's own feature
 * snapshot, judged against the exact contract the case froze.
 */
function seedAlerted(d, {
  caseId, alertOffsetMs = 2 * MIN, marks = [], occ = OCC,
  detectionAsk = 2.0, alertAsk = 2.2, status = "ENTERED", returnPct = null,
  enteredAtMs = T0,
}) {
  d.prepare(
    `INSERT INTO opportunity_cases
       (opportunity_id, underlying_symbol, detected_at_ms, source_path, acceptance_decision,
        delivery_decision, case_json, created_at_ms, updated_at_ms, alert_id)
     VALUES (?,?,?,'owner','accepted','delivered',?,?,?,NULL)`,
  ).run(
    caseId, "NVDA", T0,
    JSON.stringify({
      underlyingSymbol: "NVDA",
      opportunityFingerprint: `of_${caseId}`,
      selectedContract: { optionSymbol: occ, side: "call", strike: 180, expiration: "2026-08-14", dte: 4 },
      frozenTrade: { entryMid: detectionAsk, targetT1: detectionAsk * 1.5, targetT2: detectionAsk * 2, stop: detectionAsk * 0.7 },
    }),
    T0, T0,
  );

  const info = d.prepare(
    `INSERT INTO options_paper_trades
       (option_symbol, side, strike, expiration, dte, result_class, entry_fill, status, return_pct,
        entered_at_ms, feature_snapshot_json, paper_kind, alert_id, created_at_ms, updated_at_ms)
     VALUES (?,'call',180,'2026-08-14',4,'REAL_OPTION_PAPER',?,?,?,?,?,'OWNER_VALIDATION_PAPER',NULL,?,?)`,
  ).run(
    occ, detectionAsk, status, returnPct, enteredAtMs,
    JSON.stringify({ lane: "OWNER_ONLY", opportunityCaseId: caseId, quality: 0.85 }),
    T0, T0,
  );

  for (const [ret, off, markOcc] of marks) {
    d.prepare(
      `INSERT INTO options_paper_marks (trade_id, option_symbol, mark_at_ms, return_pct, created_at_ms)
       VALUES (?,?,?,?,?)`,
    ).run(Number(info.lastInsertRowid), markOcc ?? occ, T0 + off, ret, T0);
  }

  recordPreMoveObservationOnDb(d, {
    opportunityCaseId: caseId, sessionDate: "2026-08-10", symbol: "NVDA", direction: "bullish",
    side: "CALL", optionSymbol: occ, strategyKey: "breakout", deploymentSha: "sha", lane: "SHADOW",
    nowMs: T0, eligible: true, underlyingPrice: 100, optionAsk: detectionAsk,
    triggerLevel: 99, triggerTaken: true, sessionHigh: 104, sessionLow: 99,
  });
  recordPreMoveAlertOnDb(d, {
    opportunityCaseId: caseId, ownerNotifiedAtMs: T0 + alertOffsetMs,
    underlyingAtAlert: 100.5, optionAtAlert: alertAsk, lane: "OWNER",
  });
  return caseId;
}

const ownerLane = (r) => r.lanes.find((l) => l.lane === "OWNER");

test("a milestone reached AFTER the alert is lead time, measured from the alert", () => {
  const d = db();
  // Alert at +2min. +25% first printed at +11min, i.e. 9 minutes AFTER the alert.
  seedAlerted(d, {
    caseId: "oc_early", alertOffsetMs: 2 * MIN,
    marks: [[2, 1 * MIN], [8, 5 * MIN], [27, 11 * MIN], [55, 20 * MIN]],
  });

  const owner = ownerLane(buildPreMoveNightlyReport(d, {}));
  const row = owner.rows[0];
  assert.equal(row.msToMilestone["25"], 9 * MIN, "measured from the alert, not from detection");
  assert.equal(row.msToMilestone["50"], 18 * MIN);
  assert.equal(row.msToMilestone["100"], null, "never reached is null, not 0");
  assert.deepEqual(row.milestonesReachedBeforeAlert, []);
  assert.equal(owner.milestoneAttainment["25"].reached, 1);
  assert.equal(owner.milestoneAttainment["25"].rate, 1);
});

test("a milestone reached BEFORE the alert is never counted as lead time", () => {
  const d = db();
  // The move ran +60% in the first minute; we alerted at +5min and it went no further.
  seedAlerted(d, {
    caseId: "oc_late", alertOffsetMs: 5 * MIN,
    marks: [[62, 1 * MIN], [58, 3 * MIN], [59, 8 * MIN], [57, 15 * MIN]],
  });

  const owner = ownerLane(buildPreMoveNightlyReport(d, {}));
  const row = owner.rows[0];
  // The trade IS above +50% after the alert, but it was already there before it. The
  // milestone times are real; what they must not do is read as discoveries.
  assert.deepEqual(
    row.milestonesReachedBeforeAlert,
    [10, 25, 50],
    "every milestone the move had already passed is reported separately",
  );
  assert.equal(
    owner.alertsWithMilestoneAlreadyHit,
    1,
    "and the lane counts the alert as one that fired on an already-run move",
  );
});

test("a post-alert MFE is withheld unless the excursion is VERIFIED", () => {
  const d = db();
  // Only two same-contract marks: enough to see a number, not enough to claim a maximum.
  seedAlerted(d, { caseId: "oc_thin", marks: [[5, 3 * MIN], [40, 9 * MIN]] });

  const owner = ownerLane(buildPreMoveNightlyReport(d, {}));
  const row = owner.rows[0];
  assert.equal(row.excursionState, "INSUFFICIENT_MARKS");
  assert.equal(row.postAlertMfePct, null, "two marks cannot assert the gaps held nothing larger");
  // The milestone TIME is still reported: "it touched +25% at this moment" is an
  // observation, while "this was the maximum" is a claim about every moment.
  assert.equal(row.msToMilestone["25"], 7 * MIN);
});

test("a foreign-contract mark cannot manufacture a milestone", () => {
  const d = db();
  seedAlerted(d, {
    caseId: "oc_foreign", alertOffsetMs: 2 * MIN,
    marks: [[3, 3 * MIN], [6, 5 * MIN], [9, 7 * MIN], [180, 9 * MIN, FOREIGN]],
  });

  const owner = ownerLane(buildPreMoveNightlyReport(d, {}));
  const row = owner.rows[0];
  assert.equal(row.msToMilestone["100"], null, "a price from another strike is not this trade's move");
  assert.equal(row.msToMilestone["10"], null);
  assert.equal(row.marksOnContract, 3, "only the three same-contract marks count");
});

test("an unmarked alert is unmeasured, never a failure to reach a milestone", () => {
  const d = db();
  seedAlerted(d, { caseId: "oc_marked", marks: [[2, 1 * MIN], [30, 6 * MIN], [40, 9 * MIN]] });
  seedAlerted(d, { caseId: "oc_unmarked", marks: [] });

  const owner = ownerLane(buildPreMoveNightlyReport(d, {}));
  assert.equal(owner.gradedAlerts, 2);
  // Denominator is 1, not 2. Counting the unmarked trade as a miss would understate
  // every attainment rate with rows that were never observed at all.
  assert.equal(owner.milestoneAttainment["25"].of, 1);
  assert.equal(owner.milestoneAttainment["25"].reached, 1);
  assert.equal(owner.milestoneAttainment["25"].rate, 1);
});

test("an open mirror is STILL_OPEN, not a zero realized return", () => {
  const d = db();
  seedAlerted(d, { caseId: "oc_open", marks: [[5, 2 * MIN]], status: "ENTERED" });
  seedAlerted(d, { caseId: "oc_closed", marks: [[5, 2 * MIN]], status: "EXITED", returnPct: 31.5 });

  const owner = ownerLane(buildPreMoveNightlyReport(d, {}));
  const open = owner.rows.find((r) => r.opportunityCaseId === "oc_open");
  const closed = owner.rows.find((r) => r.opportunityCaseId === "oc_closed");
  assert.equal(open.realizedEvidence, "STILL_OPEN");
  assert.equal(open.realizedReturnPct, null);
  assert.equal(closed.realizedEvidence, "VERIFIED");
  assert.equal(closed.realizedReturnPct, 31.5);
});

test("the lanes are reported separately and never pooled", () => {
  const d = db();
  seedAlerted(d, { caseId: "oc_owner", marks: [[30, 5 * MIN]] });
  recordPreMoveObservationOnDb(d, {
    opportunityCaseId: "oc_research", sessionDate: "2026-08-10", symbol: "AMD", direction: "bullish",
    side: "CALL", optionSymbol: "O:AMD260814C00170000", strategyKey: "x", deploymentSha: "sha",
    lane: "RESEARCH", nowMs: T0, eligible: true, underlyingPrice: 100, optionAsk: 1.5,
    triggerLevel: 99, triggerTaken: true, sessionHigh: 103, sessionLow: 99,
  });

  const r = buildPreMoveNightlyReport(d, {});
  assert.equal(r.lanes.length, 4, "OWNER, RESEARCH, SHADOW and EXPERIMENT are always all present");
  assert.equal(ownerLane(r).gradedAlerts, 1);
  assert.equal(r.lanes.find((l) => l.lane === "RESEARCH").census.examined, 1);
  assert.equal(r.lanes.find((l) => l.lane === "RESEARCH").gradedAlerts, 0, "a research row has no owner alert");
});

test("with no evidence the standing questions refuse rather than answer 0", () => {
  const d = db();
  const r = buildPreMoveNightlyReport(d, {});
  const answers = r.questions.map((q) => q.answer).join(" | ");
  assert.ok(answers.includes("INSUFFICIENT_EVIDENCE"), "an unanswerable question says so");
  assert.ok(r.questions.length >= 5, "the standing questions are always emitted, answered or not");
});
