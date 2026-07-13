import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCycleUniverse,
  parseTickerList,
  isValidTicker,
  DEFAULT_SUPERVISOR_CORE_TICKERS,
} from "../lib/supervisor-universe.ts";

const CORE = "NVDA,META,SPY,QQQ,AAPL,AMZN,MSFT,TSLA,AMD,GOOGL";

test("default core universe is the required ten-symbol owner list", () => {
  assert.equal(DEFAULT_SUPERVISOR_CORE_TICKERS, CORE);
  assert.deepEqual(parseTickerList(DEFAULT_SUPERVISOR_CORE_TICKERS), [
    "NVDA", "META", "SPY", "QQQ", "AAPL", "AMZN", "MSFT", "TSLA", "AMD", "GOOGL",
  ]);
});

test("all ten core symbols are prioritized before dynamic movers (cap 12)", () => {
  const movers = ["SMCI", "HOOD", "COIN", "PLTR"];
  const uni = buildCycleUniverse(CORE, movers, 12);
  assert.equal(uni.length, 12);
  assert.deepEqual(uni.slice(0, 10), ["NVDA", "META", "SPY", "QQQ", "AAPL", "AMZN", "MSFT", "TSLA", "AMD", "GOOGL"]);
  assert.deepEqual(uni.slice(10), ["SMCI", "HOOD"]);
});

test("duplicates are removed across core and movers (and mover self-overlap)", () => {
  const movers = ["NVDA", "SMCI", "SMCI", "SPY", "HOOD"];
  const uni = buildCycleUniverse(CORE, movers, 12);
  assert.equal(new Set(uni).size, uni.length, "no duplicate symbols");
  assert.deepEqual(uni, ["NVDA", "META", "SPY", "QQQ", "AAPL", "AMZN", "MSFT", "TSLA", "AMD", "GOOGL", "SMCI", "HOOD"]);
});

test("dynamic movers fill the remaining capacity in strongest-first order", () => {
  const movers = ["TSLA", "AMD", "COIN", "PLTR", "MU", "ARM"];
  const uni = buildCycleUniverse(CORE, movers, 14);
  assert.equal(uni.length, 14);
  assert.deepEqual(uni.slice(10), ["COIN", "PLTR", "MU", "ARM"]);
});

test("total never exceeds the cap; core rotates fairly when cap < core count", () => {
  const movers = ["SMCI", "HOOD"];
  assert.equal(buildCycleUniverse(CORE, movers, 12).length, 12);
  assert.equal(buildCycleUniverse(CORE, movers, 6).length, 6);
  assert.deepEqual(buildCycleUniverse(CORE, movers, 3), ["NVDA", "META", "SPY"]);
  assert.deepEqual(buildCycleUniverse(CORE, movers, 3, { rotationOffset: 3 }), ["QQQ", "AAPL", "AMZN"]);
  assert.deepEqual(buildCycleUniverse(CORE, movers, 3, { rotationOffset: 9 }), ["GOOGL", "NVDA", "META"]);
  assert.equal(buildCycleUniverse(CORE, [], 0).length, 8);
  assert.equal(buildCycleUniverse(CORE, [], NaN).length, 8);
  assert.equal(buildCycleUniverse(CORE, Array.from({ length: 100 }, (_, i) => `T${i}A`), 999).length, 50);
});

test("invalid / garbage core symbols are dropped and never crash the cycle", () => {
  const dirty = "NVDA, , 123, $$$, sp y, META,,  aapl , BRK.B, TOO.LONG";
  const parsed = parseTickerList(dirty);
  assert.ok(parsed.includes("NVDA"));
  assert.ok(parsed.includes("META"));
  assert.ok(parsed.includes("AAPL"), "lowercase is upcased");
  assert.ok(parsed.includes("BRK.B"), "class suffix allowed");
  assert.ok(!parsed.includes("123"), "no leading letter rejected");
  assert.ok(!parsed.includes("$$$"), "symbols rejected");
  assert.ok(!parsed.includes("TOO.LONG"), "multi-letter class suffix rejected");
  assert.doesNotThrow(() => buildCycleUniverse(undefined, [], 8));
  assert.doesNotThrow(() => buildCycleUniverse(null, ["", "  ", 123, {}], 8));
  assert.deepEqual(buildCycleUniverse("", ["TSLA"], 8), ["TSLA"]);
});

test("isValidTicker accepts real tickers and rejects garbage", () => {
  for (const s of ["NVDA", "SPY", "BRK.B", "F", "A"]) assert.ok(isValidTicker(s), s);
  for (const s of ["", "1NVDA", "NV DA", "$$$", "NVDA.", "BRK.BB", ".B"]) assert.ok(!isValidTicker(s), s);
});
