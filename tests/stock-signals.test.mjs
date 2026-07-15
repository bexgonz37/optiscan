import test from "node:test";
import assert from "node:assert/strict";
import {
  stockSetupScore,
  computeStockVerdict,
  STOCK_MIN_SPEED_PCT_PER_MIN,
} from "../lib/stock-signals.ts";

const strongLong = {
  direction: "bullish", directionConfidence: 80,
  shortRate: 0.45, accel: 0.1, surge: 2.4, relVol: 3,
  efficiency: 0.7, aboveVwap: true, hodBreak: true, lodBreak: false, movePct: 4.2,
};

test("stockSetupScore: strong aligned tape scores high, dead tape scores low", () => {
  const hi = stockSetupScore(strongLong);
  assert.ok(hi.score >= 80, `expected >=80, got ${hi.score}`);
  const lo = stockSetupScore({ direction: "choppy", shortRate: 0.02, surge: 1, efficiency: 0.3 });
  assert.ok(lo.score < 40, `expected <40, got ${lo.score}`);
});

test("computeStockVerdict: BUY LONG needs aligned speed + volume + score", () => {
  const v = computeStockVerdict(strongLong);
  assert.equal(v.action, "BUY");
  assert.equal(v.side, "LONG");
  assert.equal(v.headline, "Buy stock ↑");
});

test("computeStockVerdict: SHORT is research-only while the bearish gate is active (2026-07-10)", () => {
  // The old contract (BUY SHORT on downside speed) is intentionally disabled:
  // inverted-bullish shorts produced low-quality callouts. The old logic is
  // preserved behind BEARISH_ACTIONABLE=1 for the post-rebuild re-enable.
  delete process.env.BEARISH_ACTIONABLE;
  const input = {
    ...strongLong, direction: "bearish", shortRate: -0.5,
    aboveVwap: false, hodBreak: false, lodBreak: true, movePct: -2.5,
  };
  const gated = computeStockVerdict(input);
  assert.equal(gated.action, "WAIT");
  assert.match(gated.reason, /BEARISH_TRADING_OFF/);
  process.env.BEARISH_ACTIONABLE = "1";
  const enabled = computeStockVerdict(input);
  assert.equal(enabled.action, "BUY", "old path preserved behind the flag");
  assert.equal(enabled.headline, "Bet stock ↓");
  delete process.env.BEARISH_ACTIONABLE;
});

test("computeStockVerdict: speed below the bar never BUYs (day move is context only)", () => {
  const v = computeStockVerdict({ ...strongLong, shortRate: STOCK_MIN_SPEED_PCT_PER_MIN * 0.5, movePct: 9 });
  assert.notEqual(v.action, "BUY");
});

test("computeStockVerdict: misaligned speed never BUYs", () => {
  const v = computeStockVerdict({ ...strongLong, direction: "bearish", shortRate: 0.5 });
  assert.notEqual(v.action, "BUY"); // bearish call with tape ripping UP
});

test("computeStockVerdict: speed without volume waits", () => {
  const v = computeStockVerdict({ ...strongLong, surge: 1.0, relVol: 1.0 });
  assert.equal(v.action, "WAIT");
});

test("computeStockVerdict: choppy tape skips (fake-move filter)", () => {
  assert.equal(computeStockVerdict({ ...strongLong, direction: "choppy" }).action, "SKIP");
  assert.equal(computeStockVerdict({ ...strongLong, efficiency: 0.2 }).action, "SKIP");
});

test("computeStockVerdict: slow grinders wait instead of notifying", () => {
  const v = computeStockVerdict({
    ...strongLong,
    shortRate: 0.08,
    instantRate: 0.06,
    accel: 0.0,
    surge: 1.05,
    relVol: 1.1,
    hodBreak: false,
    movePct: 2.0,
  });
  assert.equal(v.classification, "SLOW_GRINDER");
  assert.equal(v.action, "WAIT");
});

test("computeStockVerdict: late exhaustion waits even with a big day move", () => {
  const v = computeStockVerdict({
    ...strongLong,
    shortRate: 0.16,
    instantRate: 0.1,
    accel: -0.08,
    surge: 1.0,
    relVol: 1.0,
    hodBreak: false,
    movePct: 8.2,
    vwapDistPct: 3.0,
  });
  assert.equal(v.classification, "LATE_EXHAUSTION");
  assert.equal(v.action, "WAIT");
});
