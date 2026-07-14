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
  // Extended (beyond the 3% cap) + decelerating + already moved → MISSED.
  const missed = assessEntryWindow({ ...base, momentum: { shortRate: 0.1, accel: -0.02, aboveVwap: true, vwapDistPct: 3.5, movePct: 1.5, relVol: 1.5 } });
  assert.equal(missed.state, "MISSED");
  assert.equal(missed.actionable, false);
  // Extended but still accelerating → wait for a pullback (do not chase).
  const wait = assessEntryWindow({ ...base, momentum: { shortRate: 0.3, accel: 0.05, aboveVwap: true, vwapDistPct: 3.5, movePct: 1.5, relVol: 1.5 } });
  assert.equal(wait.state, "WAIT_FOR_PULLBACK");
  assert.match(wait.doNotEnter, /do not chase/i);
});

test("an accelerating breakout ~0.9% above VWAP is ACTIONABLE (momentum calibration, the NVDA-breakout fix)", () => {
  const r = assessEntryWindow({ ...base, momentum: { ...goodCallMomentum, vwapDistPct: 0.9 } });
  assert.equal(r.state, "ACTIONABLE");
  assert.equal(r.actionable, true);
});

test("past the (widened) entry zone but not extended → WAIT_FOR_PULLBACK", () => {
  const r = assessEntryWindow({ ...base, momentum: { ...goodCallMomentum, vwapDistPct: 2.0 } });
  assert.equal(r.state, "WAIT_FOR_PULLBACK");
  assert.equal(r.actionable, false);
  assert.equal(r.crossingLatched, false);
});

// ── deterministic breakout-crossing latch (the between-cycle NVDA fix) ────────
const ACTIVE = { active: true, alreadyFired: false, crossToleranceVwapDistPct: 0.6 };

test("a confirmed breakout that crossed the band between cycles is RESCUED to ACTIONABLE", () => {
  // Just past the 1.5% band (1.9% ≤ 1.5 + 0.6 crossing ceiling), still confirmed
  // on volume + accelerating, with an active prior developing stamp.
  const r = assessEntryWindow({ ...base, momentum: { ...goodCallMomentum, vwapDistPct: 1.9 }, crossing: ACTIVE });
  assert.equal(r.state, "ACTIONABLE");
  assert.equal(r.actionable, true);
  assert.equal(r.crossingLatched, true);
  assert.match(r.reasons.join(" "), /crossed the entry zone between checks/i);
});

test("crossing WITHOUT confirmation (weak volume) is NOT rescued — stays WAIT_FOR_PULLBACK", () => {
  const r = assessEntryWindow({ ...base, momentum: { ...goodCallMomentum, vwapDistPct: 1.9, relVol: 0.8 }, crossing: ACTIVE });
  assert.equal(r.state, "WAIT_FOR_PULLBACK");
  assert.equal(r.actionable, false);
  assert.equal(r.crossingLatched, false);
});

test("anti-chase: a crossing beyond the crossing ceiling is NOT rescued (no top-of-candle chase)", () => {
  // 2.3% is past 1.5 + 0.6 = 2.1% ceiling → not a rescue, wait for pullback.
  const r = assessEntryWindow({ ...base, momentum: { ...goodCallMomentum, vwapDistPct: 2.3 }, crossing: ACTIVE });
  assert.equal(r.state, "WAIT_FOR_PULLBACK");
  assert.equal(r.crossingLatched, false);
});

test("anti-chase: an extended move (≥3%) is EXTENDED and never rescued even with an active latch", () => {
  const r = assessEntryWindow({ ...base, momentum: { shortRate: 0.3, accel: 0.05, aboveVwap: true, vwapDistPct: 3.5, movePct: 1.5, relVol: 1.5 }, crossing: ACTIVE });
  assert.notEqual(r.state, "ACTIONABLE");
  assert.equal(r.crossingLatched, false);
});

test("dedup: an already-fired crossing signal does NOT rescue again", () => {
  const r = assessEntryWindow({ ...base, momentum: { ...goodCallMomentum, vwapDistPct: 1.9 }, crossing: { active: false, alreadyFired: true, crossToleranceVwapDistPct: 0.6 } });
  assert.equal(r.state, "WAIT_FOR_PULLBACK");
  assert.equal(r.crossingLatched, false);
});

test("a stale/inactive crossing signal does NOT rescue (restart & TTL safety)", () => {
  const r = assessEntryWindow({ ...base, momentum: { ...goodCallMomentum, vwapDistPct: 1.9 }, crossing: { active: false, alreadyFired: false, crossToleranceVwapDistPct: 0.6 } });
  assert.equal(r.state, "WAIT_FOR_PULLBACK");
  // No crossing input at all behaves identically (no regression).
  const r2 = assessEntryWindow({ ...base, momentum: { ...goodCallMomentum, vwapDistPct: 1.9 } });
  assert.equal(r2.state, "WAIT_FOR_PULLBACK");
});

test("crossing that has reversed is INVALIDATED, never rescued", () => {
  const r = assessEntryWindow({ ...base, momentum: { shortRate: -0.3, accel: -0.05, aboveVwap: false, vwapDistPct: -0.5, movePct: -1.2, relVol: 1.5 }, crossing: ACTIVE });
  assert.equal(r.state, "INVALIDATED");
  assert.equal(r.crossingLatched, false);
});

test("developing flag: NEAR_TRIGGER and ACTIONABLE are stampable; WAIT/EARLY are not", () => {
  assert.equal(assessEntryWindow({ ...base, momentum: goodCallMomentum }).developing, true);            // ACTIONABLE
  assert.equal(assessEntryWindow({ ...base, momentum: { ...goodCallMomentum, relVol: 0.8 } }).developing, true); // NEAR_TRIGGER
  assert.equal(assessEntryWindow({ ...base, momentum: { ...goodCallMomentum, vwapDistPct: 2.0 } }).developing, false); // WAIT
  assert.equal(assessEntryWindow({ ...base, momentum: null }).developing, false);                       // EARLY
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
  const r = assessEntryWindow({ ...base, momentum: { shortRate: 0.1, accel: -0.02, aboveVwap: true, vwapDistPct: 3.5, movePct: 1.5, relVol: 1.5 } });
  assert.ok(r.alreadyHappened, "has historical context");
  assert.match(r.currently, /passed|extended|stand aside/i);
});

// ── metrics (§9) ─────────────────────────────────────────────────────────────
test("alert-timing summary computes (never fabricates) the quality metrics", () => {
  const recs = [
    { entryState: "ACTIONABLE", secondsSinceTrigger: 3, distanceFromTriggerPct: 0.2, entryWindowValid: true, sent: true, triggerToDiscordMs: 4000, downgradedMissed: false, rejectedForExtension: false, paperFilledInsideWindow: true, crossingRescued: true },
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
  assert.equal(s.crossingRescues, 1); // one callout was rescued by the crossing latch
  // Empty input → nulls, not fabricated numbers.
  const empty = summarizeAlertTiming([]);
  assert.equal(empty.avgTriggerToDiscordMs, null);
  assert.equal(empty.pctValidWindowAtSend, null);
  assert.equal(empty.crossingRescues, 0);
});
