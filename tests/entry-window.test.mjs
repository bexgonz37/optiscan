import test from "node:test";
import assert from "node:assert/strict";
import { assessEntryWindow, entryStateToCandidateStatus, entryWindowConfig } from "../lib/entry-window.ts";
import { summarizeAlertTiming } from "../lib/alert-timing.ts";

const CFG = entryWindowConfig({});
const base = {
  side: "call", regularSession: true, quoteAgeMs: 1000, spreadPct: 2, maxSpreadPct: 8, cfg: CFG,
};
/** A confirmed, in-zone, accelerating call on volume. */
const goodCallMomentum = { shortRate: 0.2, accel: 0.05, aboveVwap: true, vwapDistPct: 0.3, movePct: 0.5, relVol: 1.5 };

// ── forward-looking states ───────────────────────────────────────────────────
test("trigger just confirmed inside the entry zone → ACTIONABLE", () => {
  const r = assessEntryWindow({ ...base, momentum: goodCallMomentum });
  assert.equal(r.state, "ACTIONABLE");
  assert.equal(r.actionable, true);
  assert.match(r.waitFor, /enter now/i);
  assert.equal(entryStateToCandidateStatus(r.state), "ACTIONABLE_NOW");
});

test("a CALL while the underlying is FALLING → INVALIDATED (the NVDA bug)", () => {
  const r = assessEntryWindow({ ...base, momentum: { shortRate: -0.3, accel: -0.05, aboveVwap: false, vwapDistPct: -0.5, movePct: -1.2, relVol: 1.5 } });
  assert.equal(r.state, "INVALIDATED");
  assert.equal(r.actionable, false);
  assert.match(r.doNotEnter, /moving down|wrong side/i);
});

test("price materially beyond the trigger → EXTENDED / WAIT_FOR_PULLBACK / MISSED, never actionable", () => {
  // Extended + decelerating + already moved → MISSED.
  const missed = assessEntryWindow({ ...base, momentum: { shortRate: 0.1, accel: -0.02, aboveVwap: true, vwapDistPct: 1.8, movePct: 1.5, relVol: 1.5 } });
  assert.equal(missed.state, "MISSED");
  assert.equal(missed.actionable, false);
  // Extended but still accelerating → wait for a pullback.
  const wait = assessEntryWindow({ ...base, momentum: { shortRate: 0.3, accel: 0.05, aboveVwap: true, vwapDistPct: 1.8, movePct: 1.5, relVol: 1.5 } });
  assert.equal(wait.state, "WAIT_FOR_PULLBACK");
  assert.match(wait.doNotEnter, /do not chase/i);
});

test("past the ideal entry zone but not extended → WAIT_FOR_PULLBACK", () => {
  const r = assessEntryWindow({ ...base, momentum: { ...goodCallMomentum, vwapDistPct: 0.9 } });
  assert.equal(r.state, "WAIT_FOR_PULLBACK");
  assert.equal(r.actionable, false);
});

test("fresh, approaching, weak volume → NEAR_TRIGGER (not actionable yet)", () => {
  const r = assessEntryWindow({ ...base, momentum: { ...goodCallMomentum, relVol: 0.8 } });
  assert.equal(r.state, "NEAR_TRIGGER");
  assert.equal(r.actionable, false);
  assert.match(r.waitFor, /confirmed/i);
});

test("stale option quote → BLOCKED (never actionable)", () => {
  const r = assessEntryWindow({ ...base, quoteAgeMs: 60_000, momentum: goodCallMomentum });
  assert.equal(r.state, "BLOCKED");
  assert.equal(r.actionable, false);
});

test("spread beyond the limit → BLOCKED", () => {
  const r = assessEntryWindow({ ...base, spreadPct: 25, momentum: goodCallMomentum });
  assert.equal(r.state, "BLOCKED");
});

test("no live momentum snapshot → EARLY, never actionable (no confirmation)", () => {
  const r = assessEntryWindow({ ...base, momentum: null });
  assert.equal(r.state, "EARLY");
  assert.equal(r.actionable, false);
  assert.match(r.waitFor, /confirmation/i);
});

test("outside regular hours a confirmed setup is NEAR_TRIGGER, not ACTIONABLE", () => {
  const r = assessEntryWindow({ ...base, regularSession: false, momentum: goodCallMomentum });
  assert.notEqual(r.state, "ACTIONABLE");
});

test("PUT mirror: falling underlying below VWAP inside zone → ACTIONABLE", () => {
  const r = assessEntryWindow({ ...base, side: "put", momentum: { shortRate: -0.2, accel: -0.05, aboveVwap: false, vwapDistPct: -0.3, movePct: -0.6, relVol: 1.5 } });
  assert.equal(r.state, "ACTIONABLE");
});

// ── forward-looking language separates context from action ───────────────────
test("late states carry ALREADY-HAPPENED context distinct from the entry", () => {
  const r = assessEntryWindow({ ...base, momentum: { shortRate: 0.1, accel: -0.02, aboveVwap: true, vwapDistPct: 1.8, movePct: 1.5, relVol: 1.5 } });
  assert.ok(r.alreadyHappened, "has historical context");
  assert.match(r.currently, /passed|extended|stand aside/i);
});

// ── metrics (§9) ─────────────────────────────────────────────────────────────
test("alert-timing summary computes (never fabricates) the quality metrics", () => {
  const recs = [
    { entryState: "ACTIONABLE", secondsSinceTrigger: 3, distanceFromTriggerPct: 0.2, entryWindowValid: true, sent: true, triggerToDiscordMs: 4000, downgradedMissed: false, rejectedForExtension: false, paperFilledInsideWindow: true },
    { entryState: "NEAR_TRIGGER", secondsSinceTrigger: null, distanceFromTriggerPct: null, entryWindowValid: false, sent: true, triggerToDiscordMs: null, downgradedMissed: false, rejectedForExtension: false, paperFilledInsideWindow: null },
    { entryState: "EXTENDED", secondsSinceTrigger: 200, distanceFromTriggerPct: 1.8, entryWindowValid: false, sent: false, triggerToDiscordMs: null, downgradedMissed: false, rejectedForExtension: true, paperFilledInsideWindow: null },
    { entryState: "MISSED", secondsSinceTrigger: 400, distanceFromTriggerPct: 2.2, entryWindowValid: false, sent: false, triggerToDiscordMs: null, downgradedMissed: true, rejectedForExtension: true, paperFilledInsideWindow: false },
  ];
  const s = summarizeAlertTiming(recs);
  assert.equal(s.total, 4);
  assert.equal(s.sentAtTrigger, 1);
  assert.equal(s.sentBeforeTrigger, 1);
  assert.equal(s.sentLate, 0, "late states were not sent");
  assert.equal(s.downgradedToMissed, 1);
  assert.equal(s.rejectedForExtension, 2);
  assert.equal(s.avgTriggerToDiscordMs, 4000);
  assert.equal(s.pctValidWindowAtSend, 50); // 1 of 2 sent had a valid window
  assert.equal(s.paperFillsInsideWindow, 1);
  assert.equal(s.paperFillsOutsideWindow, 1);
  // Empty input → nulls, not fabricated numbers.
  const empty = summarizeAlertTiming([]);
  assert.equal(empty.avgTriggerToDiscordMs, null);
  assert.equal(empty.pctValidWindowAtSend, null);
});
