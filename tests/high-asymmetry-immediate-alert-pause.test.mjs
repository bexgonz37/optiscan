/**
 * tests/high-asymmetry-immediate-alert-pause.test.mjs
 *
 * The owner audit pause: HIGH_ASYMMETRY_IMMEDIATE_ALERTS_ENABLED=0.
 *
 * The pause exists so an unvalidated opening candidate cannot interrupt the
 * owner while the called-versus-missed audit is still running. Its correctness
 * has two halves, and the second is the one that is easy to get wrong:
 *
 *  1. Nothing that would have alerted may reach IMMEDIATE_OWNER_ALERT.
 *  2. EVERYTHING ELSE MUST BE UNCHANGED. The pause must not suppress the
 *     evaluation, alter a rejection reason, hide a case, or change what a
 *     non-qualifying candidate was already going to do. A pause that changed
 *     the population would destroy the evidence the audit is being run to
 *     collect, and the journal would then be unable to say what the pause cost.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  decideNotification, resolveNotificationStrength, resolveStrategyNotificationStrength,
  immediateAlertsPaused, IMMEDIATE_ALERTS_ENABLED_ENV, IMMEDIATE_ALERTS_PAUSED_REASON,
  DEFAULT_NOTIFICATION_STRENGTH,
} from "../lib/research/asymmetry/notification-gate.ts";

const OCC = "O:NVDA260807C00200000";
const T0 = Date.parse("2026-08-06T14:00:00.000Z");

/** A candidate that passes every gate and would genuinely alert. */
const qualifying = (over = {}) => ({
  state: "HIGH_ASYMMETRY", optionSymbol: OCC, bid: 1.9, ask: 2.0, quoteAtMs: T0,
  underlyingPrice: 198.4, spreadPct: 5, premiumChasePct: 3,
  openInterest: 4200, contractVolume: 900, missingEvidence: [],
  trigger: "reclaims 200", invalidation: "loses 196",
  nowMs: T0 + 1_000, firstDetectedAtMs: T0 - 5_000,
  ...over,
});

const paused = { ...DEFAULT_NOTIFICATION_STRENGTH, immediateAlertsPaused: true };
const running = { ...DEFAULT_NOTIFICATION_STRENGTH, immediateAlertsPaused: false };

// ── The switch itself ───────────────────────────────────────────────────────

test("UNSET means enabled — a fresh deploy is never silently paused", () => {
  assert.equal(immediateAlertsPaused({}), false);
});

test("only an explicit off value pauses", () => {
  for (const off of ["0", "false", "FALSE", "off", "no"]) {
    assert.equal(immediateAlertsPaused({ [IMMEDIATE_ALERTS_ENABLED_ENV]: off }), true, off);
  }
  for (const on of ["1", "true", "yes", "on"]) {
    assert.equal(immediateAlertsPaused({ [IMMEDIATE_ALERTS_ENABLED_ENV]: on }), false, on);
  }
});

test("the resolved config carries the pause, including through the strategy resolver", () => {
  const env = { [IMMEDIATE_ALERTS_ENABLED_ENV]: "0" };
  assert.equal(resolveNotificationStrength(env).immediateAlertsPaused, true);
  assert.equal(resolveStrategyNotificationStrength("pullback_continuation", env).immediateAlertsPaused, true,
    "a known strategy must not spread away the pause");
  assert.equal(resolveStrategyNotificationStrength("no_such_strategy", env).immediateAlertsPaused, true,
    "an unknown strategy must not spread away the pause either");
});

test("the shipped default is not paused", () => {
  assert.equal(DEFAULT_NOTIFICATION_STRENGTH.immediateAlertsPaused, false);
});

// ── Half one: nothing qualifying may speak ──────────────────────────────────

test("a fully qualifying candidate alerts when the pause is OFF", () => {
  const d = decideNotification(qualifying(), running);
  assert.equal(d.notify, true);
  assert.equal(d.action, "HIGH_ASYMMETRY_ALERT");
  assert.equal(d.deliveryLevel, "IMMEDIATE_OWNER_ALERT");
});

test("the SAME candidate is held to OWNER_WATCH when the pause is ON", () => {
  const d = decideNotification(qualifying(), paused);
  assert.equal(d.notify, false, "the pause must stop the message");
  assert.equal(d.action, "HIGH_ASYMMETRY_OWNER_WATCH");
  assert.equal(d.deliveryLevel, "OWNER_WATCH");
  assert.equal(d.reason, IMMEDIATE_ALERTS_PAUSED_REASON,
    "the reason must name the pause, so the audit can count what it cost");
});

test("no evidence shape can reach IMMEDIATE_OWNER_ALERT while paused", () => {
  const variants = [
    qualifying(),
    qualifying({ state: "TRIGGERED" }),
    qualifying({ spreadPct: 0.5, openInterest: 90_000, contractVolume: 50_000 }),
    qualifying({ premiumChasePct: 0 }),
  ];
  for (const e of variants) {
    const d = decideNotification(e, paused);
    assert.equal(d.notify, false);
    assert.notEqual(d.deliveryLevel, "IMMEDIATE_OWNER_ALERT");
  }
});

// ── Half two: everything else is untouched ──────────────────────────────────

test("the held case is still CAPTURED and TRACKED, not discarded", () => {
  const d = decideNotification(qualifying(), paused);
  assert.equal(d.silentCapture, true, "silent means captured-and-tracked");
  assert.equal(d.timing, "ON_TIME", "the timing verdict is evidence and must survive the pause");
});

test("the pause runs LAST — the full evaluation still happens", () => {
  const on = decideNotification(qualifying(), running);
  const off = decideNotification(qualifying(), paused);
  // Every measured metric is computed before the pause and must be identical.
  for (const k of [
    "candidateAgeMs", "optionQuoteAgeMs", "underlyingQuoteAgeMs",
    "underlyingMoveBeforeEntryPct", "rewardRemainingPct", "distanceToInvalidationPct",
    "qualityScore", "strategyKey", "version",
  ]) {
    assert.deepEqual(off[k], on[k], `${k} must not change because of the pause`);
  }
});

test("a candidate that was ALREADY going to be rejected is unchanged by the pause", () => {
  const cases = [
    ["spread", qualifying({ bid: 1.0, ask: 2.0, spreadPct: 66 })],
    ["chase", qualifying({ premiumChasePct: 95 })],
    ["open interest", qualifying({ openInterest: 3 })],
    ["early state", qualifying({ state: "EARLY_ASYMMETRY" })],
    ["invalidated", qualifying({ state: "INVALIDATED" })],
    ["stale quote", qualifying({ quoteAtMs: T0 - 20 * 60_000 })],
  ];
  for (const [label, e] of cases) {
    const on = decideNotification(e, running);
    const off = decideNotification(e, paused);
    assert.equal(on.notify, false, `${label}: precondition — this case must not alert anyway`);
    assert.deepEqual(off, on, `${label}: the pause must not alter an already-suppressed decision`);
    assert.notEqual(off.reason, IMMEDIATE_ALERTS_PAUSED_REASON,
      `${label}: the pause must not claim credit for a rejection it did not make`);
  }
});

test("the pause never LOOSENS anything", () => {
  // Any decision that did not notify while running must still not notify while
  // paused. The gate may only ever get stricter.
  const shapes = [
    qualifying({ state: "CONFIRMING", missingEvidence: ["a", "b", "c", "d"] }),
    qualifying({ bid: null, ask: null }),
    qualifying({ contractVolume: 0 }),
  ];
  for (const e of shapes) {
    if (decideNotification(e, running).notify === false) {
      assert.equal(decideNotification(e, paused).notify, false);
    }
  }
});
