/**
 * Post-hoc timing verdicts.
 *
 * The classifier is total and single-valued by contract: every input maps to
 * exactly one of eight labels. These tests pin the precedence order, because a
 * silent reordering would change every historical verdict at once and nothing
 * would fail loudly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyTiming, gateWouldSuppress, capturedFractionOfPeak, giveBackAtAlert,
  pullbackFromLocalHighPct, TIMING_VERDICTS, DEFAULT_TIMING_THRESHOLDS,
  TIMING_CLASSIFIER_VERSION,
} from "../lib/research/asymmetry/timing-classification.ts";

/** A clean ON_TIME baseline that every test perturbs one field at a time. */
const ok = (over = {}) => ({
  quoteAgeAtAlertMs: 5_000,
  premiumChasePctAtAlert: 5,
  entryAskAtCapture: 2.00,
  askAtAlert: 2.10,
  peakAskBeforeAlert: 2.15,
  peakAskSession: 4.00,
  shortWindowMomentumPct: 0.4,
  localHighBeforeAlert: 100,
  underlyingAtAlert: 99.9,
  aboveVwapAtAlert: true,
  triggerReclaimedThenLost: false,
  unconfirmedAtAlert: false,
  observations: 50,
  ...over,
});

test("the clean baseline is ON_TIME", () => {
  const r = classifyTiming(ok());
  assert.equal(r.verdict, "ON_TIME");
  assert.equal(r.version, TIMING_CLASSIFIER_VERSION);
});

test("every verdict returned is a member of the declared set", () => {
  const cases = [
    ok(), ok({ askAtAlert: null }), ok({ quoteAgeAtAlertMs: 300_000 }),
    ok({ triggerReclaimedThenLost: true }), ok({ premiumChasePctAtAlert: 60 }),
    ok({ observations: 1 }), ok({ unconfirmedAtAlert: true, aboveVwapAtAlert: false }),
    ok({ askAtAlert: 2.9, peakAskSession: 3.0 }),
  ];
  for (const c of cases) assert.ok(TIMING_VERDICTS.includes(classifyTiming(c).verdict));
});

test("no ask at the alert is INSUFFICIENT with its own distinct code", () => {
  const r = classifyTiming(ok({ askAtAlert: null }));
  assert.equal(r.verdict, "INSUFFICIENT_TIMING_EVIDENCE");
  assert.equal(r.code, "NO_ASK_AT_ALERT", "distinct from a thin sample — different failure, different fix");
});

test("too few observations is INSUFFICIENT with its own code", () => {
  const r = classifyTiming(ok({ observations: 1 }));
  assert.equal(r.verdict, "INSUFFICIENT_TIMING_EVIDENCE");
  assert.equal(r.code, "TOO_FEW_OBSERVATIONS");
});

test("INSUFFICIENT is never silently downgraded to ON_TIME", () => {
  const r = classifyTiming(ok({ observations: 0, askAtAlert: null }));
  assert.notEqual(r.verdict, "ON_TIME");
  assert.equal(r.verdict, "INSUFFICIENT_TIMING_EVIDENCE");
});

test("a stale quote outranks every other defect measured at the same instant", () => {
  // Simultaneously stale, chased, rolled over and a failed breakout.
  const r = classifyTiming(ok({
    quoteAgeAtAlertMs: 300_000,
    premiumChasePctAtAlert: 80,
    peakAskBeforeAlert: 5.0, askAtAlert: 2.05,
    triggerReclaimedThenLost: true,
  }));
  assert.equal(r.verdict, "STALE_EVIDENCE",
    "numbers we know were out of date cannot support any other verdict");
});

test("a failed breakout outranks rollover, chase and lateness", () => {
  const r = classifyTiming(ok({
    triggerReclaimedThenLost: true,
    premiumChasePctAtAlert: 80,
    peakAskBeforeAlert: 5.0, askAtAlert: 2.05,
  }));
  assert.equal(r.verdict, "FAILED_BREAKOUT");
});

test("premium give-back past the threshold is MOMENTUM_ROLLOVER", () => {
  // entry 2.00, peak 4.00 (gain 2.00), alert 2.50 → gave back 1.50 = 75%.
  const r = classifyTiming(ok({ entryAskAtCapture: 2, peakAskBeforeAlert: 4, askAtAlert: 2.5, premiumChasePctAtAlert: 25 }));
  assert.equal(r.verdict, "MOMENTUM_ROLLOVER");
  assert.equal(r.code, "PREMIUM_GAVE_BACK");
  assert.equal(r.measures.giveBackFractionAtAlert, 0.75);
});

test("give-back exactly at the threshold does NOT trip rollover", () => {
  // entry 2, peak 4, alert 3 → gave back exactly 50%.
  const r = classifyTiming(ok({ entryAskAtCapture: 2, peakAskBeforeAlert: 4, askAtAlert: 3, peakAskSession: 100 }));
  assert.equal(r.measures.giveBackFractionAtAlert, 0.5);
  assert.notEqual(r.verdict, "MOMENTUM_ROLLOVER", "strictly greater-than, matching the gate");
});

test("negative momentum off the local high is MOMENTUM_ROLLOVER", () => {
  const r = classifyTiming(ok({
    shortWindowMomentumPct: -0.8, localHighBeforeAlert: 100, underlyingAtAlert: 99.0,
    peakAskBeforeAlert: 2.10,
  }));
  assert.equal(r.verdict, "MOMENTUM_ROLLOVER");
  assert.equal(r.code, "MOMENTUM_NEGATIVE_OFF_HIGH");
});

test("negative momentum alone, still at the high, is not rollover", () => {
  const r = classifyTiming(ok({
    shortWindowMomentumPct: -0.1, localHighBeforeAlert: 100, underlyingAtAlert: 99.99,
  }));
  assert.notEqual(r.verdict, "MOMENTUM_ROLLOVER", "a shallow dip at the high is not a turn");
});

test("premium expansion past the threshold is PREMIUM_CHASE", () => {
  const r = classifyTiming(ok({ premiumChasePctAtAlert: 47.2, peakAskBeforeAlert: 2.10, peakAskSession: 100 }));
  assert.equal(r.verdict, "PREMIUM_CHASE");
});

test("most of the move already priced is LATE_CONFIRMATION", () => {
  // entry 2.00, session peak 4.00 (gain 2.00), alert 3.80 → captured 90%.
  const r = classifyTiming(ok({
    entryAskAtCapture: 2, askAtAlert: 3.8, peakAskSession: 4, peakAskBeforeAlert: 3.85,
    premiumChasePctAtAlert: 5,
  }));
  assert.equal(r.verdict, "LATE_CONFIRMATION");
  assert.equal(r.measures.capturedFractionOfPeak, 0.9);
});

test("unconfirmed and below VWAP is EARLY", () => {
  const r = classifyTiming(ok({ unconfirmedAtAlert: true, aboveVwapAtAlert: false }));
  assert.equal(r.verdict, "EARLY");
});

test("unconfirmed but above VWAP is not EARLY", () => {
  const r = classifyTiming(ok({ unconfirmedAtAlert: true, aboveVwapAtAlert: true }));
  assert.equal(r.verdict, "ON_TIME", "structure was reclaimed, so it is not premature");
});

test("nulls are treated as unknown, never as passing values", () => {
  const r = classifyTiming(ok({
    quoteAgeAtAlertMs: null, premiumChasePctAtAlert: null,
    shortWindowMomentumPct: null, aboveVwapAtAlert: null,
    triggerReclaimedThenLost: null, unconfirmedAtAlert: null,
    localHighBeforeAlert: null, peakAskBeforeAlert: null, peakAskSession: null,
  }));
  assert.equal(r.verdict, "ON_TIME", "unmeasurable defects cannot be asserted");
  assert.equal(r.measures.giveBackFractionAtAlert, null);
  assert.equal(r.measures.capturedFractionOfPeak, null);
});

test("classification is deterministic", () => {
  const input = ok({ premiumChasePctAtAlert: 47.2, peakAskSession: 100 });
  const a = classifyTiming(input), b = classifyTiming(input);
  assert.equal(a.verdict, b.verdict);
  assert.equal(a.code, b.code);
});

test("thresholds are reported on every result so a verdict can be re-run", () => {
  const r = classifyTiming(ok());
  assert.equal(r.thresholds.staleQuoteMs, DEFAULT_TIMING_THRESHOLDS.staleQuoteMs);
  assert.equal(r.thresholds.rolloverGiveBackFraction, DEFAULT_TIMING_THRESHOLDS.rolloverGiveBackFraction);
});

test("a custom threshold set changes the verdict over identical evidence", () => {
  const evidence = ok({ quoteAgeAtAlertMs: 150_000 });
  assert.equal(classifyTiming(evidence).verdict, "STALE_EVIDENCE", "at the 120s default");
  const relaxed = classifyTiming(evidence, { ...DEFAULT_TIMING_THRESHOLDS, staleQuoteMs: 180_000 });
  assert.notEqual(relaxed.verdict, "STALE_EVIDENCE", "counterfactual evaluation is possible without touching production");
});

test("gateWouldSuppress reports unknown for verdicts the gate cannot see", () => {
  assert.equal(gateWouldSuppress("STALE_EVIDENCE"), true);
  assert.equal(gateWouldSuppress("MOMENTUM_ROLLOVER"), true);
  assert.equal(gateWouldSuppress("PREMIUM_CHASE"), true);
  assert.equal(gateWouldSuppress("ON_TIME"), false);
  assert.equal(gateWouldSuppress("LATE_CONFIRMATION"), null, "requires lookahead the gate does not have");
  assert.equal(gateWouldSuppress("FAILED_BREAKOUT"), null);
  assert.equal(gateWouldSuppress("INSUFFICIENT_TIMING_EVIDENCE"), null);
});

test("derived measures return null rather than a misleading number", () => {
  assert.equal(capturedFractionOfPeak(null, 1, 2), null);
  assert.equal(capturedFractionOfPeak(0, 1, 2), null, "a zero entry cannot be a denominator");
  assert.equal(capturedFractionOfPeak(2, 3, 2), null, "no peak gain means no fraction of it");
  assert.equal(giveBackAtAlert(2, 2, 2), null, "peak equal to entry is not a gain");
  assert.equal(pullbackFromLocalHighPct(0, 1), null);
  assert.equal(pullbackFromLocalHighPct(100, 99), 1);
});

test("the real NVDA 197.5C reconstruction classifies as PREMIUM_CHASE", () => {
  // Measured 2026-07-31 from historical NBBO: captured 15:38:24 at ask 1.78,
  // HIGH_ASYMMETRY sweep 16:52:00 at ask 2.62 — +47.2% before the alert.
  const r = classifyTiming({
    quoteAgeAtAlertMs: 0, premiumChasePctAtAlert: 47.19,
    entryAskAtCapture: 1.78, askAtAlert: 2.62,
    peakAskBeforeAlert: 2.67, peakAskSession: 2.84,
    shortWindowMomentumPct: 0.09, localHighBeforeAlert: 198.43, underlyingAtAlert: 198.10,
    aboveVwapAtAlert: true, triggerReclaimedThenLost: null, unconfirmedAtAlert: false,
    observations: 154,
  });
  assert.equal(r.verdict, "PREMIUM_CHASE");
  assert.equal(gateWouldSuppress(r.verdict), true);
});

test("the real NVDA 200C reconstruction classifies as LATE_CONFIRMATION", () => {
  // Measured 2026-07-31: captured 16:23:47 at ask 3.25, alert sweep 16:52:00 at
  // ask 3.65 (+12.3%, under the 20% chase bar), session peak 3.75. The alert
  // arrived with 80% of the eventual premium gain already realized — a failure
  // mode ASYM_NOTIFY_V2 has no check for.
  const r = classifyTiming({
    quoteAgeAtAlertMs: 0, premiumChasePctAtAlert: 12.31,
    entryAskAtCapture: 3.25, askAtAlert: 3.65,
    peakAskBeforeAlert: 3.65, peakAskSession: 3.75,
    shortWindowMomentumPct: 0.09, localHighBeforeAlert: 198.43, underlyingAtAlert: 198.10,
    aboveVwapAtAlert: true, triggerReclaimedThenLost: null, unconfirmedAtAlert: false,
    observations: 108,
  });
  assert.equal(r.verdict, "LATE_CONFIRMATION");
  assert.equal(r.measures.capturedFractionOfPeak, 0.8);
  assert.equal(gateWouldSuppress(r.verdict), null,
    "the gate cannot see this without lookahead — the honest answer is unknown, not 'approved'");
});
