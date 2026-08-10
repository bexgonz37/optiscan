/**
 * tests/pre-move-capture.test.mjs
 *
 * PRE_MOVE_DISCOVERY_V1's prospective capture. The classifier was already tested; this
 * pins the thing that makes the classifier MEAN anything live.
 *
 *     DETECTION-STAGE EVIDENCE IS WRITE-ONCE.
 *
 * The scanner re-evaluates the same living case many times a session. If a later
 * observation could overwrite "the underlying when we first saw it", the stage would
 * compare the alert price against a price taken at almost the same moment and report
 * every alert as perfectly early — a metric that always agrees with us. Most of these
 * tests are that one property, approached from the angles that would break it.
 *
 * Fixture is the SAME migration production runs, not a hand-copy.
 */
import "./helpers/register-alias.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  recordPreMoveObservationOnDb,
  recordPreMoveAlertOnDb,
  readPreMoveDiscoveryOnDb,
  summarizePreMoveDiscoveryOnDb,
  listPreMoveDiscoveriesOnDb,
} from "../lib/research/options/pre-move-store.ts";

const { applyProductionSchemaOnDb } = await import("@/lib/db");

const T0 = Date.parse("2026-08-10T13:35:00.000Z");

function db() {
  const d = new Database(":memory:");
  applyProductionSchemaOnDb(d);
  return d;
}

function obs(over = {}) {
  return {
    opportunityCaseId: "oc_pm1",
    sessionDate: "2026-08-10",
    symbol: "NVDA",
    direction: "bullish",
    side: "CALL",
    optionSymbol: "O:NVDA260814C00180000",
    strategyKey: "breakout_continuation",
    deploymentSha: "abc1234",
    lane: "SHADOW",
    nowMs: T0,
    eligible: false,
    underlyingPrice: 100,
    optionAsk: 2.0,
    triggerLevel: 101,
    triggerTaken: false,
    compressionPct: 0.8,
    volumeAcceleration: 1.4,
    sessionHigh: 100.5,
    sessionLow: 99,
    vwap: 99.8,
    aboveVwap: true,
    dte: 4,
    delta: 0.45,
    iv: 0.38,
    spreadPct: 2.1,
    openInterest: 4200,
    contractVolume: 900,
    moneynessPct: 1.2,
    ...over,
  };
}

test("the first observation establishes detection and a stage", () => {
  const d = db();
  assert.equal(recordPreMoveObservationOnDb(d, obs()), true);
  const row = readPreMoveDiscoveryOnDb(d, "oc_pm1");
  assert.equal(row.underlyingAtDetection, 100);
  assert.equal(row.optionAtDetection, 2.0);
  assert.equal(row.firstDetectedAtMs, T0);
  assert.equal(row.modelVersion, "PRE_MOVE_DISCOVERY_V1");
  // The trigger has not been taken, and that is a statement about structure, not size.
  assert.equal(row.discoveryStage, "PRE_TRIGGER");
});

test("an unalerted case measures against its LATEST observation, not against detection", () => {
  const d = db();
  // Detected pre-trigger at 100, and the move then ran the whole session range without
  // us ever alerting. If detection were its own endpoint this would score 0% consumed
  // and read as maximally early — the self-flattering failure this endpoint prevents.
  recordPreMoveObservationOnDb(d, obs({ triggerTaken: true, sessionHigh: 100.2, sessionLow: 99 }));
  recordPreMoveObservationOnDb(d, obs({
    nowMs: T0 + 900_000, triggerTaken: true, underlyingPrice: 110, optionAsk: 6.0,
    sessionHigh: 110, sessionLow: 99,
  }));

  const row = readPreMoveDiscoveryOnDb(d, "oc_pm1");
  assert.equal(row.underlyingAtDetection, 100, "detection is still write-once");
  assert.equal(row.underlyingAtLatest, 110, "but the current endpoint moves");
  assert.equal(row.underlyingMoveConsumedPct, 10);
  assert.equal(row.ownerNotifiedAtMs, null, "no alert was ever sent");
  assert.equal(row.discoveryStage, "TOO_LATE", "the whole move ran while we sat on it");
});

test("a later scan cannot move the detection price or the detection time", () => {
  const d = db();
  recordPreMoveObservationOnDb(d, obs());
  // The move has since run to 107 and the premium has doubled.
  recordPreMoveObservationOnDb(d, obs({
    nowMs: T0 + 900_000, underlyingPrice: 107, optionAsk: 4.4, triggerTaken: true, sessionHigh: 107.2,
  }));

  const row = readPreMoveDiscoveryOnDb(d, "oc_pm1");
  assert.equal(row.underlyingAtDetection, 100, "detection price is write-once");
  assert.equal(row.optionAtDetection, 2.0, "detection premium is write-once");
  assert.equal(row.firstDetectedAtMs, T0, "detection time is write-once");
  assert.equal(row.observations, 2, "but the row knows it was seen twice");
});

test("eligibility is captured the first time the candidate is READY, and only then", () => {
  const d = db();
  recordPreMoveObservationOnDb(d, obs());
  let row = readPreMoveDiscoveryOnDb(d, "oc_pm1");
  assert.equal(row.firstEligibleAtMs, null, "a candidate that was never READY has no eligibility");

  recordPreMoveObservationOnDb(d, obs({ nowMs: T0 + 60_000, eligible: true, underlyingPrice: 101.5, optionAsk: 2.4 }));
  row = readPreMoveDiscoveryOnDb(d, "oc_pm1");
  assert.equal(row.firstEligibleAtMs, T0 + 60_000);
  assert.equal(row.underlyingAtEligible, 101.5);

  // A second READY scan must not move it forward.
  recordPreMoveObservationOnDb(d, obs({ nowMs: T0 + 300_000, eligible: true, underlyingPrice: 105, optionAsk: 3.9 }));
  row = readPreMoveDiscoveryOnDb(d, "oc_pm1");
  assert.equal(row.firstEligibleAtMs, T0 + 60_000, "eligibility is write-once too");
  assert.equal(row.underlyingAtEligible, 101.5);
});

test("the session extent may widen but never narrow", () => {
  const d = db();
  recordPreMoveObservationOnDb(d, obs({ sessionHigh: 100.5, sessionLow: 99 }));
  recordPreMoveObservationOnDb(d, obs({ nowMs: T0 + 60_000, sessionHigh: 104, sessionLow: 98.2 }));
  let row = readPreMoveDiscoveryOnDb(d, "oc_pm1");
  let raw = d.prepare("SELECT session_high, session_low FROM opportunity_pre_move_discovery WHERE opportunity_case_id=?").get("oc_pm1");
  assert.equal(raw.session_high, 104, "a new high widens the extent");
  assert.equal(raw.session_low, 98.2, "a new low widens the extent");

  // A narrower reading is a worse observation of the same day, not a smaller day. A
  // shrinking denominator would inflate the share of the move already consumed.
  recordPreMoveObservationOnDb(d, obs({ nowMs: T0 + 120_000, sessionHigh: 101, sessionLow: 99.5 }));
  raw = d.prepare("SELECT session_high, session_low FROM opportunity_pre_move_discovery WHERE opportunity_case_id=?").get("oc_pm1");
  assert.equal(raw.session_high, 104);
  assert.equal(raw.session_low, 98.2);
  assert.ok(row);
});

test("an owner alert sets lead time, promotes the lane, and is itself write-once", () => {
  const d = db();
  recordPreMoveObservationOnDb(d, obs());
  recordPreMoveObservationOnDb(d, obs({ nowMs: T0 + 60_000, eligible: true, underlyingPrice: 101.5, optionAsk: 2.4, triggerTaken: true }));

  assert.equal(recordPreMoveAlertOnDb(d, {
    opportunityCaseId: "oc_pm1",
    ownerNotifiedAtMs: T0 + 120_000,
    underlyingAtAlert: 102,
    optionAtAlert: 2.6,
    lane: "OWNER",
  }), true);

  let row = readPreMoveDiscoveryOnDb(d, "oc_pm1");
  assert.equal(row.lane, "OWNER", "the lane is promoted only when an owner was really notified");
  assert.equal(row.ownerNotifiedAtMs, T0 + 120_000);
  assert.equal(row.underlyingAtAlert, 102);
  // 2.00 -> 2.60 between detection and alert.
  assert.equal(row.premiumExpansionConsumedPct, 30);

  // A retry or a re-send must not shorten the measured lead.
  recordPreMoveAlertOnDb(d, {
    opportunityCaseId: "oc_pm1", ownerNotifiedAtMs: T0 + 600_000, underlyingAtAlert: 108, optionAtAlert: 5.0,
  });
  row = readPreMoveDiscoveryOnDb(d, "oc_pm1");
  assert.equal(row.ownerNotifiedAtMs, T0 + 120_000, "the first notification is the one lead time is measured from");
  assert.equal(row.underlyingAtAlert, 102);
});

test("an alert for a case that was never captured writes nothing", () => {
  const d = db();
  assert.equal(
    recordPreMoveAlertOnDb(d, { opportunityCaseId: "oc_never_seen", ownerNotifiedAtMs: T0, underlyingAtAlert: 1, optionAtAlert: 1 }),
    false,
    "a lead time with no detection to measure from is not a lead time",
  );
  assert.equal(readPreMoveDiscoveryOnDb(d, "oc_never_seen"), null);
});

test("direction decides what counts as favourable movement", () => {
  const d = db();
  // A PUT whose underlying FELL between detection and alert consumed favourable move.
  recordPreMoveObservationOnDb(d, obs({
    opportunityCaseId: "oc_put", side: "PUT", triggerTaken: true,
    underlyingPrice: 100, sessionHigh: 100.2, sessionLow: 96,
  }));
  recordPreMoveAlertOnDb(d, {
    opportunityCaseId: "oc_put", ownerNotifiedAtMs: T0 + 120_000, underlyingAtAlert: 98, optionAtAlert: 2.2,
  });
  const put = readPreMoveDiscoveryOnDb(d, "oc_put");
  assert.equal(put.underlyingMoveConsumedPct, 2, "a put profits on a fall, so a 2% drop is +2% consumed");

  // The identical price path is UNfavourable for a CALL.
  recordPreMoveObservationOnDb(d, obs({
    opportunityCaseId: "oc_call", side: "CALL", triggerTaken: true,
    underlyingPrice: 100, sessionHigh: 100.2, sessionLow: 96,
  }));
  recordPreMoveAlertOnDb(d, {
    opportunityCaseId: "oc_call", ownerNotifiedAtMs: T0 + 120_000, underlyingAtAlert: 98, optionAtAlert: 2.2,
  });
  const call = readPreMoveDiscoveryOnDb(d, "oc_call");
  assert.equal(call.underlyingMoveConsumedPct, -2, "the same path went against a call");
});

test("a missing session extent is reported as PARTIAL evidence, not as a complete answer", () => {
  const d = db();
  recordPreMoveObservationOnDb(d, obs({ sessionHigh: null, sessionLow: null, triggerTaken: true }));
  recordPreMoveAlertOnDb(d, {
    opportunityCaseId: "oc_pm1", ownerNotifiedAtMs: T0 + 120_000, underlyingAtAlert: 102, optionAtAlert: 2.6,
  });
  const row = readPreMoveDiscoveryOnDb(d, "oc_pm1");
  assert.equal(row.evidenceQuality, "PARTIAL");
  // Premium expanded 30% with no extent to size it against: a real answer that says the
  // move was already being paid for, reached without a denominator.
  assert.equal(row.discoveryStage, "MATURE_MOVE");
  assert.equal(row.rewardRemainingBand, "UNAVAILABLE");
  assert.equal(row.rewardRemainingFraction, null, "unknown remaining reward is null, never zero");
});

test("the census rates gradable rows only, and separates the lanes", () => {
  const d = db();
  // Two gradable early rows in the owner lane, one ungradable.
  for (const [id, taken] of [["oc_a", false], ["oc_b", false]]) {
    recordPreMoveObservationOnDb(d, obs({ opportunityCaseId: id, triggerTaken: taken }));
    recordPreMoveAlertOnDb(d, { opportunityCaseId: id, ownerNotifiedAtMs: T0 + 60_000, underlyingAtAlert: 100.4, optionAtAlert: 2.1, lane: "OWNER" });
  }
  // No detection price at all: nothing to measure from.
  recordPreMoveObservationOnDb(d, obs({ opportunityCaseId: "oc_c", underlyingPrice: null, optionAsk: null, lane: "OWNER" }));
  // A different lane entirely.
  recordPreMoveObservationOnDb(d, obs({ opportunityCaseId: "oc_r", lane: "RESEARCH" }));

  const owner = summarizePreMoveDiscoveryOnDb(d, { lane: "OWNER" });
  assert.equal(owner.examined, 3);
  assert.equal(owner.byStage.UNGRADABLE, 1);
  assert.equal(owner.withOwnerAlert, 2);
  // 2 early of 2 gradable — the ungradable row is excluded from the denominator so a
  // day of missing inputs cannot read as a day of late discoveries.
  assert.equal(owner.earlyRate, 1);
  assert.equal(owner.tooLateRate, 0);

  const research = summarizePreMoveDiscoveryOnDb(d, { lane: "RESEARCH" });
  assert.equal(research.examined, 1, "lanes are never blended");
  assert.equal(listPreMoveDiscoveriesOnDb(d, { ownerAlertedOnly: true }).length, 2);
});

test("an empty table censuses to zero rather than throwing", () => {
  const d = db();
  const c = summarizePreMoveDiscoveryOnDb(d, {});
  assert.equal(c.examined, 0);
  assert.equal(c.earlyRate, null, "no gradable rows means no rate, not a rate of 0");
  assert.deepEqual(listPreMoveDiscoveriesOnDb(d, {}), []);
});

// ── the degenerate-column trap ───────────────────────────────────────────────
//
// Measured live at 9018ae5: 174 of 174 captured rows classified PRE_TRIGGER. The cause
// was not the market. `triggerTaken` was derived by comparing price to
// `nearestResistance`, a value features.ts builds by filtering levels to those ABOVE
// price — so the comparison is structurally false for every candidate that will ever be
// evaluated. classifyDiscovery checks PRE_TRIGGER first and short-circuits, so that one
// always-false input silenced the entire consumed-fraction measurement.
//
// A column that always reports the flattering answer measures nothing, and it looks
// exactly like a system that is brilliantly early.

test("a stage that cannot vary is not a finding: PRE_TRIGGER must be earnable and losable", () => {
  const d = db();
  // Same setup twice, differing ONLY in whether the trigger was taken.
  recordPreMoveObservationOnDb(d, obs({ opportunityCaseId: "oc_untaken", triggerTaken: false }));
  recordPreMoveObservationOnDb(d, obs({
    opportunityCaseId: "oc_taken", triggerTaken: true,
    underlyingPrice: 100, sessionHigh: 100.2, sessionLow: 99,
  }));
  recordPreMoveAlertOnDb(d, {
    opportunityCaseId: "oc_taken", ownerNotifiedAtMs: T0 + 60_000, underlyingAtAlert: 100.2, optionAtAlert: 2.4,
  });

  assert.equal(readPreMoveDiscoveryOnDb(d, "oc_untaken").discoveryStage, "PRE_TRIGGER");
  assert.notEqual(
    readPreMoveDiscoveryOnDb(d, "oc_taken").discoveryStage,
    "PRE_TRIGGER",
    "a taken trigger must reach a different stage, or the column is decorative",
  );
});

test("an unknown trigger is null and does NOT short-circuit to PRE_TRIGGER", () => {
  const d = db();
  // No break flag available (the unenriched scan path). The move is in fact 100% spent.
  recordPreMoveObservationOnDb(d, obs({
    opportunityCaseId: "oc_unknown", triggerTaken: null,
    underlyingPrice: 100, sessionHigh: 100, sessionLow: 99,
  }));
  recordPreMoveObservationOnDb(d, obs({
    opportunityCaseId: "oc_unknown", nowMs: T0 + 600_000, triggerTaken: null,
    underlyingPrice: 110, sessionHigh: 110, sessionLow: 99,
  }));

  const row = readPreMoveDiscoveryOnDb(d, "oc_unknown");
  assert.equal(
    row.discoveryStage,
    "TOO_LATE",
    "unknown structure must fall through to the consumed-fraction measurement, not assert earliness",
  );
});
