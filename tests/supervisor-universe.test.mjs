import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCycleUniverse,
  parseTickerList,
  isValidTicker,
  DEFAULT_SUPERVISOR_CORE_TICKERS,
} from "../lib/supervisor-universe.ts";
import { getOwnerCoreUniverse, isCoreSymbol } from "../lib/universe.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CORE = "SPY,QQQ,NVDA,AAPL,META,TSLA,AMD,AMZN,MSFT,GOOGL,NFLX,AVGO,IWM,SPCX";
const CORE_LIST = ["SPY", "QQQ", "NVDA", "AAPL", "META", "TSLA", "AMD", "AMZN", "MSFT", "GOOGL", "NFLX", "AVGO", "IWM", "SPCX"];
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("default core universe is the required options core list", () => {
  assert.equal(DEFAULT_SUPERVISOR_CORE_TICKERS, CORE);
  assert.deepEqual(parseTickerList(DEFAULT_SUPERVISOR_CORE_TICKERS), CORE_LIST);
});

for (const ticker of CORE_LIST) {
  test(`${ticker} receives owner-core impulse priority membership`, () => {
    const env = { OWNER_CORE_TICKERS: CORE };
    assert.equal(isCoreSymbol(ticker, env), true);
    assert.ok(getOwnerCoreUniverse(env).includes(ticker));
  });
}

test("non-core ticker does not receive owner-core priority unless configured", () => {
  assert.equal(isCoreSymbol("SMCI", { OWNER_CORE_TICKERS: CORE }), false);
  assert.equal(isCoreSymbol("SMCI", { OWNER_CORE_TICKERS: `${CORE},SMCI` }), true);
});

test("scanner impulse path is core-driven, not AAPL-specific", () => {
  const scanner = readFileSync(join(root, "lib/scanner-loop.ts"), "utf8");
  const impulseBody = scanner.slice(scanner.indexOf("const coreBullishImpulse"), scanner.indexOf("const fired ="));
  assert.ok(/core\s*&&/.test(impulseBody), "impulse gate is keyed to isCoreSymbol()");
  assert.ok(!/AAPL/.test(impulseBody), "no AAPL-specific impulse behavior");
  assert.ok(!/q\.symbol\s*={2,3}\s*["']AAPL["']/.test(scanner), "no direct AAPL symbol check");
});

test("all core symbols are prioritized before dynamic movers (cap 16)", () => {
  const movers = ["SMCI", "HOOD", "COIN", "PLTR"];
  const uni = buildCycleUniverse(CORE, movers, 16);
  assert.equal(uni.length, 16);
  assert.deepEqual(uni.slice(0, 14), CORE_LIST);
  assert.deepEqual(uni.slice(14), ["SMCI", "HOOD"]);
});

test("duplicates are removed across core and movers (and mover self-overlap)", () => {
  const movers = ["NVDA", "SMCI", "SMCI", "SPY", "HOOD"];
  const uni = buildCycleUniverse(CORE, movers, 16);
  assert.equal(new Set(uni).size, uni.length, "no duplicate symbols");
  assert.deepEqual(uni, [...CORE_LIST, "SMCI", "HOOD"]);
});

test("dynamic movers fill the remaining capacity in strongest-first order", () => {
  const movers = ["TSLA", "AMD", "COIN", "PLTR", "MU", "ARM"];
  const uni = buildCycleUniverse(CORE, movers, 18);
  assert.equal(uni.length, 18);
  assert.deepEqual(uni.slice(14), ["COIN", "PLTR", "MU", "ARM"]);
});

test("total never exceeds the cap; core rotates fairly when cap < core count", () => {
  const movers = ["SMCI", "HOOD"];
  assert.equal(buildCycleUniverse(CORE, movers, 16).length, 16);
  assert.equal(buildCycleUniverse(CORE, movers, 6).length, 6);
  assert.deepEqual(buildCycleUniverse(CORE, movers, 3), ["SPY", "QQQ", "NVDA"]);
  assert.deepEqual(buildCycleUniverse(CORE, movers, 3, { rotationOffset: 3 }), ["AAPL", "META", "TSLA"]);
  assert.deepEqual(buildCycleUniverse(CORE, movers, 3, { rotationOffset: 13 }), ["SPCX", "SPY", "QQQ"]);
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
