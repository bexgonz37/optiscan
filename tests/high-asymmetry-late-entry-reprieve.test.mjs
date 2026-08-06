/**
 * tests/high-asymmetry-late-entry-reprieve.test.mjs
 *
 * The late-entry reprieve: candidate AGE is not quote STALENESS.
 *
 * EVIDENCE THIS ENCODES. Across 5,562 journal rows and five sessions,
 * ENTRY_TOO_LATE rejected 111 candidates on candidate age alone. Of those, 82%
 * still had >=10% reward remaining and 91% had seen premium expand <=10% — the
 * clock was rejecting entries the system's own measurements called early. The
 * worked example is SPY O:SPY260806P00774000 on 2026-08-05: rejected at
 * 10:09:01 ET on ENTRY_TOO_LATE_6M with an ask of 2.58 and a 1.16% spread, then
 * NBBO-verified to a peak bid of 5.08 at 12:09 — +97% MFE against a -15% MAE,
 * from the exact instant it was called too late.
 *
 * The ceiling it violated was 30 SECONDS, because pullback_continuation's
 * `freshnessMaxMs` (a quote-staleness constant) was being used as the
 * candidate-age ceiling — for a strategy whose declared holding horizon is
 * "hours–2 days".
 *
 * The rule must therefore be narrow: OFF by default, and when on it may only
 * fire if three independent measures all agree and all are PRESENT.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  decideNotification, resolveNotificationStrength, resolveStrategyNotificationStrength,
  LATE_ENTRY_REPRIEVE_ENV, LATE_ENTRY_REPRIEVED_REASON, DEFAULT_NOTIFICATION_STRENGTH,
} from "../lib/research/asymmetry/notification-gate.ts";

const OCC = "O:SPY260806P00774000";
const T0 = Date.parse("2026-08-05T14:09:01.000Z");

/** A strategy config shaped like pullback_continuation: 30s freshness ceiling. */
const cfg = (over = {}) => ({
  ...DEFAULT_NOTIFICATION_STRENGTH,
  strategyKey: "pullback_continuation",
  freshnessSource: "STRATEGY_CATALOG",
  maxCaptureToNotifyMs: 30_000,
  maxQuoteAgeAtNotifyMs: 30_000,
  maxUnderlyingQuoteAgeAtNotifyMs: 30_000,
  maxUnderlyingMoveBeforeEntryPct: 0.6,
  minRewardRemainingPct: 10,
  minDistanceFromInvalidationPct: 5,
  preferredDteBands: ["1-7dte", "8-14dte"],
  preferredDelta: [0.35, 0.55],
  requireStrategyEvidence: true,
  ...over,
});

/** The real SPY put, six minutes old, cheap, unextended, with room left. */
const sixMinutesOld = (over = {}) => ({
  state: "HIGH_ASYMMETRY", setupFamily: "pullback_continuation", direction: "PUT",
  optionSymbol: OCC, bid: 2.55, ask: 2.58, quoteAtMs: T0 - 1_000,
  underlyingPrice: 775.0, currentUnderlyingPrice: 774.2,
  underlyingQuoteAtMs: T0 - 1_000,
  spreadPct: 1.16, premiumChasePct: 5, openInterest: 8000, contractVolume: 5000,
  missingEvidence: [], trigger: null, invalidation: null,
  nowMs: T0, firstDetectedAtMs: T0 - 6 * 60_000,
  dte: 1, delta: -0.45,
  targetT1: 4.0, targetStop: 2.0,
  ...over,
});

// ── Default is unchanged behaviour ──────────────────────────────────────────

test("OFF by default — the shipped config does not reprieve", () => {
  assert.equal(DEFAULT_NOTIFICATION_STRENGTH.lateEntryReprieveEnabled, false);
  assert.equal(resolveNotificationStrength({}).lateEntryReprieveEnabled, false);
});

test("with the flag unset the six-minute-old SPY put is still ENTRY_TOO_LATE_6M", () => {
  const d = decideNotification(sixMinutesOld(), cfg());
  assert.equal(d.notify, false);
  assert.equal(d.reason, "ENTRY_TOO_LATE_6M");
  assert.equal(d.action, "HIGH_ASYMMETRY_TOO_LATE");
});

test("the flag is read from the environment", () => {
  assert.equal(resolveNotificationStrength({ [LATE_ENTRY_REPRIEVE_ENV]: "1" }).lateEntryReprieveEnabled, true);
  assert.equal(resolveStrategyNotificationStrength("pullback_continuation",
    { [LATE_ENTRY_REPRIEVE_ENV]: "1" }).lateEntryReprieveEnabled, true);
  assert.equal(resolveNotificationStrength({ [LATE_ENTRY_REPRIEVE_ENV]: "0" }).lateEntryReprieveEnabled, false);
});

// ── With the flag on, the proven case is recovered ──────────────────────────

test("with the flag ON the same SPY put notifies, and says WHY", () => {
  const d = decideNotification(sixMinutesOld(), cfg({ lateEntryReprieveEnabled: true }));
  assert.equal(d.notify, true, "this contract went +97% from this instant");
  assert.equal(d.reason, LATE_ENTRY_REPRIEVED_REASON,
    "a reprieved alert must be countable separately from a normal one");
  assert.equal(d.action, "HIGH_ASYMMETRY_ALERT");
});

// ── The reprieve is narrow ──────────────────────────────────────────────────

test("premium expansion beyond HALF the chase limit blocks the reprieve", () => {
  // maxPremiumChasePct is 20, so the reprieve requires <=10.
  const d = decideNotification(sixMinutesOld({ premiumChasePct: 12 }), cfg({ lateEntryReprieveEnabled: true }));
  assert.equal(d.notify, false);
  assert.match(d.reason, /^ENTRY_TOO_LATE_/);
});

test("an extended underlying blocks the reprieve", () => {
  const d = decideNotification(
    sixMinutesOld({ underlyingPrice: 775.0, currentUnderlyingPrice: 768.0 }), // ~0.9% favourable
    cfg({ lateEntryReprieveEnabled: true }),
  );
  assert.equal(d.notify, false);
});

test("exhausted reward blocks the reprieve", () => {
  // targetT1 barely above the ask leaves under the 10% minimum.
  const d = decideNotification(sixMinutesOld({ targetT1: 2.6 }), cfg({ lateEntryReprieveEnabled: true }));
  assert.equal(d.notify, false);
});

test("the hard ceiling is absolute — an hour-old candidate is never reprieved", () => {
  const d = decideNotification(
    sixMinutesOld({ firstDetectedAtMs: T0 - 45 * 60_000 }),
    cfg({ lateEntryReprieveEnabled: true, maxCandidateAgeHardMs: 15 * 60_000 }),
  );
  assert.equal(d.notify, false);
  assert.equal(d.reason, "ENTRY_TOO_LATE_45M");
});

test("MISSING evidence never reprieves — absence is not agreement", () => {
  const on = cfg({ lateEntryReprieveEnabled: true });
  for (const [label, over] of [
    ["no chase measure", { premiumChasePct: null }],
    ["no current underlying", { currentUnderlyingPrice: null }],
    ["no target", { targetT1: null, roomToNextLevelPct: null }],
  ]) {
    assert.equal(decideNotification(sixMinutesOld(over), on).notify, false, label);
  }
});

test("no extension or reward POLICY means no reprieve — a legacy config cannot drift into it", () => {
  const legacy = cfg({
    lateEntryReprieveEnabled: true,
    freshnessSource: "LEGACY_GLOBAL",
    maxUnderlyingMoveBeforeEntryPct: null,
    minRewardRemainingPct: null,
  });
  assert.equal(decideNotification(sixMinutesOld(), legacy).notify, false);
});

// ── Execution quality is never relaxed ──────────────────────────────────────

test("the reprieve NEVER relaxes quote staleness", () => {
  const d = decideNotification(
    sixMinutesOld({ quoteAtMs: T0 - 120_000 }),
    cfg({ lateEntryReprieveEnabled: true }),
  );
  assert.equal(d.notify, false);
  assert.match(d.reason, /STALE/);
});

test("the reprieve NEVER relaxes spread, liquidity or chase gates", () => {
  const on = cfg({ lateEntryReprieveEnabled: true });
  for (const [label, over] of [
    ["wide spread", { bid: 1.5, ask: 2.58, spreadPct: 42 }],
    ["thin open interest", { openInterest: 5 }],
    ["thin volume", { contractVolume: 0 }],
    ["premium chased", { premiumChasePct: 80 }],
  ]) {
    assert.equal(decideNotification(sixMinutesOld(over), on).notify, false, label);
  }
});

test("the reprieve cannot resurrect a non-eligible state", () => {
  const on = cfg({ lateEntryReprieveEnabled: true });
  for (const state of ["EARLY_ASYMMETRY", "INVALIDATED", "LIQUIDITY_FAILURE", "PREMIUM_CHASE"]) {
    assert.equal(decideNotification(sixMinutesOld({ state }), on).notify, false, state);
  }
});

test("the audit pause still wins over a reprieved alert", () => {
  const d = decideNotification(sixMinutesOld(),
    cfg({ lateEntryReprieveEnabled: true, immediateAlertsPaused: true }));
  assert.equal(d.notify, false);
  assert.equal(d.action, "HIGH_ASYMMETRY_OWNER_WATCH");
});

test("a candidate INSIDE the age ceiling is untouched by the flag either way", () => {
  const fresh = sixMinutesOld({ firstDetectedAtMs: T0 - 10_000 });
  const off = decideNotification(fresh, cfg());
  const on = decideNotification(fresh, cfg({ lateEntryReprieveEnabled: true }));
  assert.equal(off.reason, "NOTIFY");
  assert.deepEqual(on, off, "the flag must be inert for candidates that were never late");
});
