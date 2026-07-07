import test from "node:test";
import assert from "node:assert/strict";
import { computeWatchScore, sortTape } from "../lib/watch-score.ts";

const hot = {
  symbol: "NVDA",
  price: 140,
  movePct: 3.2,
  volume: 8_000_000,
  shortRate: 0.35,
  accel: 0.05,
  surge: 2.4,
  efficiency: 0.75,
  relVol: 2.8,
  aboveVwap: true,
  vwapDistPct: 0.8,
  hodBreak: true,
  lodBreak: false,
  direction: "bullish",
  confidence: 80,
};

test("computeWatchScore: fast mover scores high", () => {
  const s = computeWatchScore(hot);
  assert.ok(s >= 70);
});

test("computeWatchScore: flat stock scores low", () => {
  const s = computeWatchScore({
    ...hot,
    shortRate: 0.01,
    surge: 1.0,
    relVol: 0.8,
    movePct: 0.1,
    hodBreak: false,
    efficiency: 0.2,
  });
  assert.ok(s < 40);
});

test("sortTape: default watch sort orders by score", () => {
  const sorted = sortTape([
    { ...hot, symbol: "LOW" },
    { ...hot, symbol: "HIGH", shortRate: 0.5, surge: 3 },
  ], "watch", -1);
  assert.equal(sorted[0].symbol, "HIGH");
});

test("sortTape: level break ranks breaks first and symbol sort is alphabetical", () => {
  const rows = [
    { ...hot, symbol: "ZZZ", hodBreak: false, lodBreak: false },
    { ...hot, symbol: "AAA", hodBreak: true, lodBreak: false },
  ];
  assert.equal(sortTape(rows, "level", -1)[0].symbol, "AAA");
  assert.deepEqual(sortTape(rows, "symbol", 1).map((row) => row.symbol), ["AAA", "ZZZ"]);
});
