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
  assert.equal(v.headline, "BUY LONG");
});

test("computeStockVerdict: BUY SHORT on downside speed", () => {
  const v = computeStockVerdict({
    ...strongLong, direction: "bearish", shortRate: -0.5,
    aboveVwap: false, hodBreak: false, lodBreak: true,
  });
  assert.equal(v.action, "BUY");
  assert.equal(v.headline, "BUY SHORT");
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
