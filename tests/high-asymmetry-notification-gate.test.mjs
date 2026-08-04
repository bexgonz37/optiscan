/**
 * tests/high-asymmetry-notification-gate.test.mjs
 *
 * Backend-first capture: the decision to SPEAK is separate from the decision to
 * CAPTURE.
 *
 * Production sent 39 owner-private messages from 62 captures — a ~63%
 * alert-to-capture ratio, which is noise rather than research. The fix must
 * reduce MESSAGES without reducing what the backend sees, and the tests that
 * matter most here are the ones proving capture is untouched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decideNotification, alertToCaptureRatio, resolveNotificationStrength,
  NOTIFY_ELIGIBLE_STATES, NOTIFY_GATED_STATES, NOTIFICATION_GATE_VERSION,
  DEFAULT_NOTIFICATION_STRENGTH,
} from "../lib/research/asymmetry/notification-gate.ts";

const OCC = "O:NVDA260807C00200000";
const T0 = Date.parse("2026-07-31T14:00:00.000Z");

const ev = (over = {}) => ({
  state: "HIGH_ASYMMETRY", optionSymbol: OCC, bid: 1.9, ask: 2.0, quoteAtMs: T0,
  underlyingPrice: 198.4, spreadPct: 5, premiumChasePct: 3,
  openInterest: 4200, contractVolume: 900, missingEvidence: [],
  trigger: "reclaims 200", invalidation: "loses 196", ...over,
});

// ── State defaults ──────────────────────────────────────────────────────────

test("EARLY_ASYMMETRY is SILENT by default", () => {
  const d = decideNotification(ev({ state: "EARLY_ASYMMETRY" }));
  assert.equal(d.notify, false);
  assert.equal(d.reason, "SILENT_EARLY_ASYMMETRY");
  assert.equal(d.silentCapture, true, "silent means captured-and-tracked, not discarded");
});

test("HIGH_ASYMMETRY and TRIGGERED may notify", () => {
  for (const state of NOTIFY_ELIGIBLE_STATES) {
    const d = decideNotification(ev({ state }));
    assert.equal(d.notify, true, `${state} must be eligible`);
    assert.equal(d.action, "HIGH_ASYMMETRY_ALERT");
  }
});

test("CONFIRMING is silent unless it is well described", () => {
  assert.deepEqual([...NOTIFY_GATED_STATES], ["CONFIRMING"]);
  // Complete enough: passes.
  assert.equal(decideNotification(ev({ state: "CONFIRMING", missingEvidence: ["vwap"] })).notify, true);
  // Too many gaps: silent.
  const thin = decideNotification(ev({
    state: "CONFIRMING", missingEvidence: ["vwap", "relativeVolume", "openInterest", "delta"],
  }));
  assert.equal(thin.notify, false);
  assert.match(thin.reason, /CONFIRMING_EVIDENCE_INCOMPLETE_4/);
  // The SAME evidence at HIGH_ASYMMETRY still notifies — the extra bar is
  // specific to the weaker state.
  assert.equal(decideNotification(ev({
    state: "HIGH_ASYMMETRY", missingEvidence: ["vwap", "relativeVolume", "openInterest", "delta"],
  })).notify, true);
});

test("chased, failed and invalid states never open a notification", () => {
  for (const state of ["PREMIUM_CHASE", "LIQUIDITY_FAILURE", "INVALIDATED", "INSUFFICIENT_EVIDENCE"]) {
    const d = decideNotification(ev({ state }));
    assert.equal(d.notify, false, `${state} must never notify`);
    assert.match(d.reason, /STATE_NOT_NOTIFIABLE/);
  }
});

// ── Minimum presentation payload ────────────────────────────────────────────

test("a message nobody can act on is suppressed, not sent", () => {
  for (const [over, expected] of [
    [{ optionSymbol: null }, /NO_OCC/],
    [{ optionSymbol: "NVDA" }, /NO_OCC/],
    [{ ask: null }, /NO_ENTRY_QUOTE/],
    [{ ask: 0 }, /NO_ENTRY_QUOTE/],
    [{ quoteAtMs: null }, /NO_QUOTE_TIMESTAMP/],
    [{ underlyingPrice: null }, /NO_UNDERLYING/],
  ]) {
    const d = decideNotification(ev(over));
    assert.equal(d.notify, false);
    assert.match(d.reason, /INSUFFICIENT_NOTIFICATION_EVIDENCE/);
    assert.match(d.reason, expected);
    assert.equal(d.silentCapture, true, "the case is still captured and tracked");
  }
});

// ── Hard blockers ───────────────────────────────────────────────────────────

test("LIQUIDITY AND PREMIUM CHASE CAN NEVER BE BYPASSED", () => {
  assert.match(decideNotification(ev({ spreadPct: 40 })).reason, /UNUSABLE_SPREAD_40/);
  const chased = decideNotification(ev({ premiumChasePct: 25 }));
  assert.match(chased.reason, /PREMIUM_CHASE_25/);
  assert.equal(chased.action, "HIGH_ASYMMETRY_PAPER_ONLY");
  assert.match(decideNotification(ev({ openInterest: 10 })).reason, /WEAK_OPEN_INTEREST_10/);
  assert.match(decideNotification(ev({ contractVolume: 3 })).reason, /WEAK_CONTRACT_VOLUME_3/);
  // Not even the strongest state overrides them.
  assert.equal(decideNotification(ev({ state: "TRIGGERED", spreadPct: 40 })).notify, false);
});

test("an unmeasured blocker does not block — missing stays missing", () => {
  const d = decideNotification(ev({ spreadPct: null, openInterest: null, contractVolume: null, premiumChasePct: null }));
  assert.equal(d.notify, true, "absent evidence must not be treated as a failing value");
});

// ── The gate only ever tightens ─────────────────────────────────────────────

test("the gate is versioned and configurable within clamps", () => {
  assert.equal(NOTIFICATION_GATE_VERSION, "ASYM_NOTIFY_V2");
  assert.equal(decideNotification(ev()).version, "ASYM_NOTIFY_V2");
  const cfg = resolveNotificationStrength({ ASYM_NOTIFY_MAX_SPREAD_PCT: "8" });
  assert.equal(cfg.maxSpreadPct, 8);
  assert.equal(resolveNotificationStrength({ ASYM_NOTIFY_MAX_SPREAD_PCT: "junk" }).maxSpreadPct,
    DEFAULT_NOTIFICATION_STRENGTH.maxSpreadPct);
  assert.ok(resolveNotificationStrength({ ASYM_NOTIFY_MAX_SPREAD_PCT: "9999" }).maxSpreadPct <= 100);
  assert.equal(resolveNotificationStrength({ ASYM_NOTIFY_MAX_CAPTURE_TO_NOTIFY_MS: "600000" }).maxCaptureToNotifyMs, 600000);
});

test("the alert-to-capture ratio is unknown on an empty population, never 0", () => {
  assert.equal(alertToCaptureRatio(0, 0), null);
  assert.equal(alertToCaptureRatio(62, 39), 62.9, "the production ratio that motivated this");
  assert.equal(alertToCaptureRatio(62, 6), 9.7);
});

test("the gate cannot reach a subscriber path, a broker, or AI", () => {
  const src = readFileSync("lib/research/asymmetry/notification-gate.ts", "utf8");
  for (const forbidden of [/\/ai\//, /\bfetch\s*\(/, /\/broker\//, /\/execution\//, /DISCORD_WEBHOOK/, /canSendSubscriber\s*=\s*true/]) {
    assert.equal(forbidden.test(src), false, `must not reference ${forbidden}`);
  }
});

// ── Capture is untouched — the load-bearing claim ───────────────────────────

test("SUPPRESSING A MESSAGE MUST NOT SUPPRESS CAPTURE", () => {
  // Scope to the sweep body: the header comment and the import list both
  // mention these names before any code runs.
  const raw = readFileSync("lib/research/asymmetry/transition-runner.ts", "utf8");
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^import[^\n]*$/gm, "");
  const body = src.slice(src.indexOf("for (const c of cases)"));
  const gateIdx = body.indexOf("decideNotification");
  const recordIdx = body.indexOf("recordTransitionOnDb");
  assert.ok(gateIdx >= 0 && recordIdx > gateIdx,
    "the transition must still be persisted AFTER the gate decides");
  // The gate must gate `eligible`, never `continue`/`return` out of the loop.
  assert.equal(/if\s*\(\s*!gate\.notify\s*\)\s*(continue|return)/.test(src), false,
    "a suppressed notification must not skip persistence");
  assert.match(src, /const eligible = gate\.notify && PRIVATE_NOTIFIABLE_STATES/);
});

test("the runner counts silent captures so the ratio is measurable", () => {
  const src = readFileSync("lib/research/asymmetry/transition-runner.ts", "utf8");
  assert.match(src, /silentCaptures/);
  assert.match(src, /notifyOutcome = gate\.reason/, "the suppression reason is persisted, not discarded");
});

test("the underlying price is read from persisted evidence, not refetched", () => {
  const store = readFileSync("lib/research/asymmetry/case-store.ts", "utf8");
  assert.match(store, /underlyingPrice: evidenceNumber\(r\.evidence_json, "underlyingPrice"\)/,
    "it was already captured; surfacing it must cost zero provider calls");
  const runner = readFileSync("lib/research/asymmetry/transition-runner.ts", "utf8");
  assert.match(runner, /underlyingPrice: c\.underlyingPrice/, "and must not be hardcoded null");
  // No provider call was added anywhere in the notification path.
  assert.equal(/fetchOptionChain|buildLiveGradeDeps/.test(readFileSync("lib/research/asymmetry/notification-gate.ts", "utf8")), false);
});

// ── Current-validity revalidation (ASYM_NOTIFY_V2) ──────────────────────────

test("A PROMOTED STATE MUST NOT SPEAK ON STALE EVIDENCE", () => {
  // The NVDA complaint: an alert arrived describing a move that was already
  // over. A stored state is a record of the past; sending is a claim about now.
  const d = decideNotification(ev({ nowMs: T0 + 5 * 60_000, quoteAtMs: T0 }));
  assert.equal(d.notify, false);
  assert.equal(d.timing, "STALE_EVIDENCE");
  assert.equal(d.action, "HIGH_ASYMMETRY_TOO_LATE");
  assert.match(d.reason, /LATE_OR_ROLLOVER_SUPPRESSION_STALE_300S/);
  assert.equal(d.silentCapture, true, "the case is still captured and tracked");
});

test("A FRESH QUOTE DOES NOT MAKE AN OLD CAPTURE AN EARLY ENTRY", () => {
  const d = decideNotification(ev({
    nowMs: T0 + 42 * 60_000,
    quoteAtMs: T0 + 42 * 60_000 - 1_000,
    firstDetectedAtMs: T0,
  }));
  assert.equal(d.notify, false);
  assert.equal(d.timing, "ENTRY_TOO_LATE");
  assert.equal(d.action, "HIGH_ASYMMETRY_TOO_LATE");
  assert.match(d.reason, /ENTRY_TOO_LATE_42M/);
  assert.equal(d.silentCapture, true, "late cases are retained for research, not discarded");
});

test("a fresh quote at send time still notifies", () => {
  assert.equal(decideNotification(ev({ nowMs: T0 + 30_000, quoteAtMs: T0 })).notify, true);
});

test("NOT EVEN TRIGGERED CAN BYPASS THE CURRENT-VALIDITY CHECKS", () => {
  const stale = decideNotification(ev({ state: "TRIGGERED", nowMs: T0 + 10 * 60_000, quoteAtMs: T0 }));
  assert.equal(stale.notify, false);
  assert.equal(stale.timing, "STALE_EVIDENCE");
});

test("a contract that ran and gave the move back is suppressed as ROLLOVER", () => {
  // Captured at 2.00, peaked at 4.00, now back to 2.50: 75% of the gain gone.
  const d = decideNotification(ev({
    nowMs: T0 + 30_000, quoteAtMs: T0,
    entryAskAtCapture: 2.0, peakAskSinceCapture: 4.0, ask: 2.5, premiumChasePct: 25,
  }));
  assert.equal(d.notify, false);
  // Chase is checked first and is the more fundamental problem here.
  assert.ok(["MOMENTUM_ROLLOVER", "PREMIUM_CHASE"].includes(d.timing));
});

test("rollover is measured even when the premium is not chased", () => {
  const d = decideNotification(ev({
    nowMs: T0 + 30_000, quoteAtMs: T0,
    entryAskAtCapture: 2.0, peakAskSinceCapture: 4.0, ask: 2.1, premiumChasePct: 5,
  }));
  assert.equal(d.notify, false);
  assert.equal(d.timing, "MOMENTUM_ROLLOVER");
  assert.equal(d.action, "HIGH_ASYMMETRY_TOO_LATE");
  assert.match(d.reason, /GAVE_BACK_95PCT/);
});

test("a contract still near its peak is NOT called a rollover", () => {
  const d = decideNotification(ev({
    nowMs: T0 + 30_000, quoteAtMs: T0,
    entryAskAtCapture: 2.0, peakAskSinceCapture: 2.2, ask: 2.15, premiumChasePct: 7.5,
  }));
  assert.equal(d.notify, true);
  assert.equal(d.timing, "ON_TIME");
});

test("absent rollover evidence is not treated as rollover", () => {
  // Nothing marked yet: unknown, not "it rolled over".
  const d = decideNotification(ev({ nowMs: T0 + 30_000, quoteAtMs: T0, peakAskSinceCapture: null }));
  assert.equal(d.notify, true, "missing marks must not fabricate a rollover verdict");
});

test("the rollover input comes from persisted marks, not a new provider call", () => {
  const src = readFileSync("lib/research/asymmetry/transition-runner.ts", "utf8");
  assert.match(src, /peakAskFromMarks/);
  assert.match(src, /FROM asymmetry_marks/, "read from rows already written");
  assert.equal(/fetchOptionChain|buildLiveGradeDeps/.test(src), false,
    "no provider call may be added to decide whether to speak");
});

test("every decision carries exactly one timing classification", () => {
  for (const e of [ev(), ev({ state: "EARLY_ASYMMETRY" }), ev({ spreadPct: 40 }), ev({ nowMs: T0 + 9e5, quoteAtMs: T0 })]) {
    const d = decideNotification(e);
    assert.ok(["ON_TIME", "ENTRY_TOO_LATE", "STALE_EVIDENCE", "MOMENTUM_ROLLOVER", "PREMIUM_CHASE", "INSUFFICIENT_TIMING_EVIDENCE"].includes(d.timing));
    assert.ok(["HIGH_ASYMMETRY_ALERT", "HIGH_ASYMMETRY_OWNER_WATCH", "HIGH_ASYMMETRY_PAPER_ONLY", "HIGH_ASYMMETRY_TOO_LATE", "HIGH_ASYMMETRY_ARCHIVE", "REJECTED"].includes(d.action));
    assert.equal(d.notify, d.action === "HIGH_ASYMMETRY_ALERT");
  }
  assert.equal(decideNotification(ev()).version, "ASYM_NOTIFY_V2", "the gate version must advance with the rules");
});
