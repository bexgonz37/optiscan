import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCycleUniverse,
  parseTickerList,
  isValidTicker,
  DEFAULT_SUPERVISOR_CORE_TICKERS,
} from "../lib/supervisor-universe.ts";

const CORE = "NVDA,META,SPCX,SPY,AAPL,AMZN";

test("default core universe is the required six-symbol list", () => {
  assert.equal(DEFAULT_SUPERVISOR_CORE_TICKERS, CORE);
  assert.deepEqual(parseTickerList(DEFAULT_SUPERVISOR_CORE_TICKERS), [
    "NVDA", "META", "SPCX", "SPY", "AAPL", "AMZN",
  ]);
});

test("all six core symbols are prioritized before any dynamic mover (cap 8)", () => {
  const movers = ["TSLA", "AMD", "COIN", "PLTR"];
  const uni = buildCycleUniverse(CORE, movers, 8);
  assert.equal(uni.length, 8);
  // First six are exactly the core symbols, in order.
  assert.deepEqual(uni.slice(0, 6), ["NVDA", "META", "SPCX", "SPY", "AAPL", "AMZN"]);
  // Remaining two slots are the strongest dynamic candidates, in rank order.
  assert.deepEqual(uni.slice(6), ["TSLA", "AMD"]);
});

test("duplicates are removed across core and movers (and mover self-overlap)", () => {
  // NVDA/SPY duplicate the core; AMD is repeated among movers.
  const movers = ["NVDA", "AMD", "AMD", "SPY", "TSLA"];
  const uni = buildCycleUniverse(CORE, movers, 8);
  assert.equal(new Set(uni).size, uni.length, "no duplicate symbols");
  assert.deepEqual(uni, ["NVDA", "META", "SPCX", "SPY", "AAPL", "AMZN", "AMD", "TSLA"]);
});

test("dynamic movers fill the remaining capacity in strongest-first order", () => {
  const movers = ["TSLA", "AMD", "COIN", "PLTR", "MU", "ARM"];
  const uni = buildCycleUniverse(CORE, movers, 10);
  assert.equal(uni.length, 10);
  assert.deepEqual(uni.slice(6), ["TSLA", "AMD", "COIN", "PLTR"]);
});

test("total never exceeds the cap; core is truncated when cap < core count", () => {
  const movers = ["TSLA", "AMD"];
  assert.equal(buildCycleUniverse(CORE, movers, 8).length, 8);
  assert.equal(buildCycleUniverse(CORE, movers, 6).length, 6);
  // cap smaller than the core list — core takes priority, no movers.
  assert.deepEqual(buildCycleUniverse(CORE, movers, 3), ["NVDA", "META", "SPCX"]);
  // A falsy/degenerate cap (0, NaN) falls back to the default 8 → the six core
  // symbols with no movers supplied.
  assert.equal(buildCycleUniverse(CORE, [], 0).length, 6);
  assert.equal(buildCycleUniverse(CORE, [], NaN).length, 6);
  // A too-large cap is clamped to 50.
  assert.equal(buildCycleUniverse(CORE, Array.from({ length: 100 }, (_, i) => `T${i}A`), 999).length, 50);
});

test("invalid / garbage core symbols are dropped and never crash the cycle", () => {
  const dirty = "NVDA, , 123, $$$, sp y, META,,  aapl , BRK.B, TOO.LONG";
  const parsed = parseTickerList(dirty);
  // "123" (no leading letter), "$$$", "sp y" (split → "SP"/"Y" both valid),
  // "TOO.LONG" (multi-letter suffix) are the interesting cases.
  assert.ok(parsed.includes("NVDA"));
  assert.ok(parsed.includes("META"));
  assert.ok(parsed.includes("AAPL"), "lowercase is upcased");
  assert.ok(parsed.includes("BRK.B"), "class suffix allowed");
  assert.ok(!parsed.includes("123"), "no leading letter rejected");
  assert.ok(!parsed.includes("$$$"), "symbols rejected");
  assert.ok(!parsed.includes("TOO.LONG"), "multi-letter class suffix rejected");
  // buildCycleUniverse tolerates undefined/null/garbage without throwing.
  assert.doesNotThrow(() => buildCycleUniverse(undefined, [], 8));
  assert.doesNotThrow(() => buildCycleUniverse(null, ["", "  ", 123, {}], 8));
  assert.deepEqual(buildCycleUniverse("", ["TSLA"], 8), ["TSLA"]);
});

test("isValidTicker accepts real tickers and rejects garbage", () => {
  for (const s of ["NVDA", "SPY", "BRK.B", "F", "A"]) assert.ok(isValidTicker(s), s);
  for (const s of ["", "1NVDA", "NV DA", "$$$", "NVDA.", "BRK.BB", ".B"]) assert.ok(!isValidTicker(s), s);
});
