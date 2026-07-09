import test from "node:test";
import assert from "node:assert/strict";
import { holdVerdict, makeHoldStore, DOWNGRADE_HOLD_MS } from "../lib/verdict-hold.ts";

const T = 1_800_000_000_000;
const trade = (reason = "tape pushing") => ({ action: "TRADE", reason });
const wait = (reason = "momentum stalled") => ({ action: "WAIT", reason });
const skip = (reason = "tape died") => ({ action: "SKIP", reason });

test("first verdict shows as-is", () => {
  const s = makeHoldStore();
  const r = holdVerdict(s, "SPY", trade(), T);
  assert.equal(r.shown.action, "TRADE");
  assert.equal(r.weakening, false);
});

test("momentary downgrade does NOT flip the display (the flip-flop fix)", () => {
  const s = makeHoldStore();
  holdVerdict(s, "SPY", trade(), T);
  const dip = holdVerdict(s, "SPY", wait(), T + 3000);
  assert.equal(dip.shown.action, "TRADE", "still showing TRADE during the hold window");
  assert.equal(dip.weakening, true, "but the UI warns it's weakening");
  assert.equal(dip.weakeningReason, "momentum stalled");
  // recovers before the hold expires → back to normal, no downgrade ever shown
  const back = holdVerdict(s, "SPY", trade(), T + 8000);
  assert.equal(back.shown.action, "TRADE");
  assert.equal(back.weakening, false);
  assert.equal(back.downgradedFrom, null);
});

test("sustained downgrade commits after the hold window, with reason", () => {
  const s = makeHoldStore();
  holdVerdict(s, "SPY", trade(), T);
  holdVerdict(s, "SPY", wait("fell below VWAP"), T + 1000);
  const committed = holdVerdict(s, "SPY", wait("fell below VWAP"), T + 1000 + DOWNGRADE_HOLD_MS);
  assert.equal(committed.shown.action, "WAIT");
  assert.equal(committed.downgradedFrom, "TRADE");
  assert.equal(committed.weakeningReason, "fell below VWAP");
});

test("upgrades always show instantly", () => {
  const s = makeHoldStore();
  holdVerdict(s, "SPY", wait(), T);
  const up = holdVerdict(s, "SPY", trade(), T + 100);
  assert.equal(up.shown.action, "TRADE");
  assert.equal(up.weakening, false);
});

test("downgrade note persists on subsequent same-tier renders, then upgrades clear it", () => {
  const s = makeHoldStore();
  holdVerdict(s, "SPY", trade(), T);
  holdVerdict(s, "SPY", wait("stalled"), T + 1000);
  holdVerdict(s, "SPY", wait("stalled"), T + 1000 + DOWNGRADE_HOLD_MS); // committed
  const later = holdVerdict(s, "SPY", wait("stalled"), T + 2000 + DOWNGRADE_HOLD_MS);
  assert.equal(later.downgradedFrom, "TRADE", "note still visible");
  const up = holdVerdict(s, "SPY", trade(), T + 3000 + DOWNGRADE_HOLD_MS);
  assert.equal(up.downgradedFrom, null, "upgrade clears the note");
});

test("a deeper downgrade during the window restarts the clock at the new tier", () => {
  const s = makeHoldStore();
  holdVerdict(s, "SPY", trade(), T);
  holdVerdict(s, "SPY", wait(), T + 1000);
  holdVerdict(s, "SPY", skip(), T + 2000); // deeper — pending restarts
  const stillHeld = holdVerdict(s, "SPY", skip(), T + 2000 + DOWNGRADE_HOLD_MS - 1);
  assert.equal(stillHeld.shown.action, "TRADE");
  const committed = holdVerdict(s, "SPY", skip(), T + 2000 + DOWNGRADE_HOLD_MS);
  assert.equal(committed.shown.action, "SKIP");
  assert.equal(committed.downgradedFrom, "TRADE");
});

test("keys are independent (one symbol's downgrade doesn't touch another)", () => {
  const s = makeHoldStore();
  holdVerdict(s, "SPY", trade(), T);
  holdVerdict(s, "TSLA", trade(), T);
  holdVerdict(s, "SPY", wait(), T + 1000);
  const tsla = holdVerdict(s, "TSLA", trade(), T + 1000);
  assert.equal(tsla.weakening, false);
});
