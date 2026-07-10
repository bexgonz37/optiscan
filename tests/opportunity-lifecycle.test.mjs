import test from "node:test";
import assert from "node:assert/strict";
import {
  reconcile,
  computeTargetStatus,
  defaultLifecycleConfig,
  stableOrder,
  groupByBucket,
  bucketOf,
  statusLabel,
  LIFECYCLE_STATUSES,
} from "../lib/opportunity-lifecycle.ts";
import { signalFromTapeRow, signalsFromTape } from "../lib/opportunity-map.ts";

const CFG = defaultLifecycleConfig();
const T0 = Date.parse("2026-07-10T14:30:00.000Z");
const sig = (over = {}) => ({ ticker: "META", setupType: "momentum_long", score: 50, flags: {}, ...over });

test("all 10 lifecycle states exist", () => {
  assert.equal(LIFECYCLE_STATUSES.length, 10);
  for (const s of [
    "WATCHING", "BUILDING", "NEAR_TRIGGER", "ENTRY_CONFIRMED", "WAIT_FOR_PULLBACK",
    "EXTENDED", "INVALIDATED", "DATA_STALE", "NO_VALID_CONTRACT", "RESEARCH_ONLY",
  ]) {
    assert.ok(LIFECYCLE_STATUSES.includes(s), `${s} missing`);
    assert.ok(statusLabel(s).length > 0);
  }
});

test("computeTargetStatus: score ladder and flag precedence", () => {
  assert.equal(computeTargetStatus(sig({ score: 20 }), CFG), "WATCHING");
  assert.equal(computeTargetStatus(sig({ score: 60 }), CFG), "BUILDING");
  assert.equal(computeTargetStatus(sig({ score: 80 }), CFG), "NEAR_TRIGGER");
  assert.equal(computeTargetStatus(sig({ score: 80, flags: { confirmed: true } }), CFG), "ENTRY_CONFIRMED");
  assert.equal(computeTargetStatus(sig({ flags: { extended: true } }), CFG), "EXTENDED");
  assert.equal(computeTargetStatus(sig({ flags: { invalidated: true } }), CFG), "INVALIDATED");
  assert.equal(computeTargetStatus(sig({ flags: { dataStale: true, confirmed: true } }), CFG), "DATA_STALE");
  assert.equal(computeTargetStatus(sig({ flags: { noValidContract: true } }), CFG), "NO_VALID_CONTRACT");
  assert.equal(computeTargetStatus(sig({ flags: { researchOnly: true } }), CFG), "RESEARCH_ONLY");
});

test("reconcile creates a fresh record with monotonic fields", () => {
  const rec = reconcile(null, sig({ score: 72, triggerLevel: 650 }), T0, CFG);
  assert.equal(rec.ticker, "META");
  assert.equal(rec.current_status, "BUILDING");
  assert.equal(rec.highest_score, 72);
  assert.equal(rec.current_score, 72);
  assert.equal(rec.previous_status, null);
  assert.equal(rec.first_detected_at, rec.last_updated_at);
  assert.equal(rec.trigger_level, 650);
});

test("repeated scans evolve ONE record, not new ones (persistence semantics)", () => {
  let rec = reconcile(null, sig({ score: 60 }), T0, CFG);
  const id = rec.opportunity_id;
  rec = reconcile(rec, sig({ score: 82 }), T0 + 5000, CFG);
  assert.equal(rec.opportunity_id, id, "same opportunity id across scans");
  assert.equal(rec.first_detected_at, new Date(T0).toISOString(), "first_detected_at preserved");
  assert.equal(rec.current_status, "NEAR_TRIGGER");
  assert.equal(rec.highest_score, 82);
});

test("hysteresis: a single minor score dip does NOT demote", () => {
  let rec = reconcile(null, sig({ score: 82 }), T0, CFG); // NEAR_TRIGGER
  assert.equal(rec.current_status, "NEAR_TRIGGER");
  // one weak read below build band
  rec = reconcile(rec, sig({ score: 52 }), T0 + 5000, CFG);
  assert.equal(rec.current_status, "NEAR_TRIGGER", "held on first weak read");
  assert.equal(rec.demote_streak, 1);
});

test("hysteresis: demotion only after demoteEvals consecutive weak reads below exit", () => {
  let rec = reconcile(null, sig({ score: 82 }), T0, CFG); // NEAR_TRIGGER (rank 3)
  // three consecutive weak (WATCHING target, below exit 60)
  rec = reconcile(rec, sig({ score: 40 }), T0 + 1000, CFG);
  assert.equal(rec.current_status, "NEAR_TRIGGER");
  rec = reconcile(rec, sig({ score: 40 }), T0 + 2000, CFG);
  assert.equal(rec.current_status, "NEAR_TRIGGER");
  rec = reconcile(rec, sig({ score: 40 }), T0 + 3000, CFG);
  assert.equal(rec.current_status, "WATCHING", "demoted after 3 weak reads");
  assert.equal(rec.previous_status, "NEAR_TRIGGER");
});

test("hysteresis: a weak read at/above exit band never demotes even if repeated", () => {
  let rec = reconcile(null, sig({ score: 82 }), T0, CFG); // NEAR_TRIGGER
  for (let i = 1; i <= 5; i++) {
    // target BUILDING (score 60 == buildScore, below nearScore) but score >= exitScore(60)
    rec = reconcile(rec, sig({ score: 60 }), T0 + i * 1000, CFG);
  }
  assert.equal(rec.current_status, "NEAR_TRIGGER", "no demotion while score stays in exit band");
});

test("promotion applies immediately (catch the move fast)", () => {
  let rec = reconcile(null, sig({ score: 40 }), T0, CFG); // WATCHING
  rec = reconcile(rec, sig({ score: 85 }), T0 + 1000, CFG);
  assert.equal(rec.current_status, "NEAR_TRIGGER");
  assert.equal(rec.demote_streak, 0);
});

test("safety states apply immediately, INVALIDATED is terminal", () => {
  let rec = reconcile(null, sig({ score: 85, flags: { confirmed: true } }), T0, CFG);
  assert.equal(rec.current_status, "ENTRY_CONFIRMED");
  rec = reconcile(rec, sig({ score: 85, flags: { dataStale: true } }), T0 + 1000, CFG);
  assert.equal(rec.current_status, "DATA_STALE", "stale applies immediately, no hysteresis");
  rec = reconcile(rec, sig({ score: 85, flags: { invalidated: true } }), T0 + 2000, CFG);
  assert.equal(rec.current_status, "INVALIDATED");
  // a fresh confirmed signal does NOT revive an invalidated thesis
  rec = reconcile(rec, sig({ score: 90, flags: { confirmed: true } }), T0 + 3000, CFG);
  assert.equal(rec.current_status, "INVALIDATED", "invalidated is terminal for the day");
});

test("bucketOf maps every status to a Command Center section", () => {
  assert.equal(bucketOf("ENTRY_CONFIRMED"), "ACTIONABLE");
  assert.equal(bucketOf("NEAR_TRIGGER"), "NEAR_TRIGGER");
  assert.equal(bucketOf("WAIT_FOR_PULLBACK"), "NEAR_TRIGGER");
  assert.equal(bucketOf("WATCHING"), "DEVELOPING");
  assert.equal(bucketOf("BUILDING"), "DEVELOPING");
  assert.equal(bucketOf("EXTENDED"), "EXTENDED_OR_INVALID");
  assert.equal(bucketOf("INVALIDATED"), "EXTENDED_OR_INVALID");
  assert.equal(bucketOf("DATA_STALE"), "RESEARCH");
});

test("stableOrder is deterministic and keyed on monotonic highest_score", () => {
  const mk = (ticker, status, highest, detected) => ({
    opportunity_id: `opp_${ticker}`, ticker, setup_type: "x",
    first_detected_at: detected, last_updated_at: detected,
    highest_score: highest, current_score: highest, previous_status: null,
    current_status: status, trigger_level: null, entry_zone: null,
    invalidation_level: null, expiration_time: null, demote_streak: 0, status_since: detected,
  });
  const list = [
    mk("A", "BUILDING", 60, "2026-07-10T14:00:00Z"),
    mk("B", "ENTRY_CONFIRMED", 90, "2026-07-10T14:10:00Z"),
    mk("C", "NEAR_TRIGGER", 80, "2026-07-10T14:05:00Z"),
    mk("D", "NEAR_TRIGGER", 80, "2026-07-10T14:02:00Z"),
  ];
  const ordered = stableOrder(list).map((r) => r.ticker);
  // ACTIONABLE first, then NEAR_TRIGGER (ties broken by earlier detection: D before C), then DEVELOPING
  assert.deepEqual(ordered, ["B", "D", "C", "A"]);
  // Order is stable when current_score dips but highest_score is unchanged
  list[2].current_score = 10;
  assert.deepEqual(stableOrder(list).map((r) => r.ticker), ["B", "D", "C", "A"]);
});

test("groupByBucket returns all five buckets", () => {
  const g = groupByBucket([]);
  assert.deepEqual(Object.keys(g).sort(), ["ACTIONABLE", "DEVELOPING", "EXTENDED_OR_INVALID", "NEAR_TRIGGER", "RESEARCH"]);
});

test("map: bearish rows are research-only unless BEARISH_ACTIONABLE (safety guarantee)", () => {
  const bear = { symbol: "TSLA", price: 240, shortRate: -0.3, direction: "bearish", confidence: 80, lodBreak: true };
  const blocked = signalFromTapeRow(bear, { bearishActionable: false, optionsSession: true });
  assert.equal(blocked.setupType, "momentum_short");
  assert.equal(blocked.flags.researchOnly, true, "bearish demoted to research-only");
  assert.ok(!blocked.flags.confirmed, "bearish is never confirmed while disabled");

  const allowed = signalFromTapeRow(bear, { bearishActionable: true, optionsSession: true });
  assert.equal(allowed.flags.confirmed, true, "with BEARISH_ACTIONABLE, level+momentum confirms");
});

test("map: stale symbol forces DATA_STALE, weak rows dropped, bullish break confirms", () => {
  const bull = { symbol: "NVDA", price: 130, shortRate: 0.3, direction: "bullish", confidence: 75, hodBreak: true };
  assert.equal(signalFromTapeRow(bull, { optionsSession: true }).flags.confirmed, true);
  assert.equal(signalFromTapeRow(bull, { optionsSession: true, staleSymbols: new Set(["NVDA"]) }).flags.dataStale, true);
  assert.equal(signalFromTapeRow({ symbol: "X", confidence: 5 }), null, "sub-threshold noise dropped");
  // out of options session → research only, not confirmed
  assert.equal(signalFromTapeRow(bull, { optionsSession: false }).flags.researchOnly, true);
  assert.equal(signalsFromTape([bull, { symbol: "Y", confidence: 2 }], { optionsSession: true }).length, 1);
});
