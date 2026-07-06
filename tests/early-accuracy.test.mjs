import test from "node:test";
import assert from "node:assert/strict";
import {
  pickEarlyMove,
  isEarlyOnTrack,
  earlyMoveWin,
  EARLY_MOVE_WIN_PCT,
} from "../lib/early-accuracy.ts";

test("pickEarlyMove prefers 5m over 1m", () => {
  const p = pickEarlyMove({ move_1m: 0.3, move_5m: 1.2 });
  assert.equal(p?.checkpoint, "5m");
  assert.equal(p?.move, 1.2);
});

test("isEarlyOnTrack: 5m move above threshold", () => {
  assert.equal(isEarlyOnTrack({ move_5m: 0.6 }), true);
  assert.equal(isEarlyOnTrack({ move_5m: 0.1 }), false);
});

test("isEarlyOnTrack: 1m fallback when 5m missing", () => {
  assert.equal(isEarlyOnTrack({ move_1m: 0.3 }), true);
  assert.equal(isEarlyOnTrack({ move_1m: 0.1 }), false);
});

test("earlyMoveWin at 5m threshold", () => {
  assert.equal(earlyMoveWin(EARLY_MOVE_WIN_PCT), true);
  assert.equal(earlyMoveWin(EARLY_MOVE_WIN_PCT - 0.1), false);
  assert.equal(earlyMoveWin(null), null);
});
