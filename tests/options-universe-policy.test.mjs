import test from "node:test";
import assert from "node:assert/strict";
import {
  OPTIONS_CORE_SYMBOLS,
  dynamicOptionsSymbolEligible,
  isCoreOptionsSymbol,
  summarizeOptionsChainUsability,
  optionsChainUsabilityConfig,
} from "../lib/options-universe-policy.ts";

test("options core matches the confirmed private options universe including SPCX", () => {
  assert.deepEqual(OPTIONS_CORE_SYMBOLS, ["SPY", "QQQ", "NVDA", "AAPL", "META", "TSLA", "AMD", "AMZN", "MSFT", "GOOGL", "NFLX", "AVGO", "IWM", "SPCX"]);
  assert.equal(isCoreOptionsSymbol("spcx"), true);
  assert.equal(isCoreOptionsSymbol("HOOD"), false);
});

test("dynamic option additions need real two-sided usable chain depth", () => {
  const cfg = optionsChainUsabilityConfig({});
  const usable = Array.from({ length: 4 }, () => ({ bid: 1.00, ask: 1.08, volume: 150, openInterest: 50 }));
  const twoSided = Array.from({ length: 8 }, () => ({ bid: 0.50, ask: 0.70, volume: 1, openInterest: 1 }));
  const filler = Array.from({ length: 10 }, () => ({ bid: null, ask: null, volume: 0, openInterest: 0 }));
  const summary = summarizeOptionsChainUsability([...usable, ...twoSided, ...filler], cfg);
  assert.equal(summary.usable, true, summary.reason);
  assert.equal(summary.usableContracts, 4);
  assert.equal(summary.twoSidedContracts, 12);
});

test("dynamic option additions reject fake/thin chains", () => {
  const cfg = optionsChainUsabilityConfig({});
  assert.equal(summarizeOptionsChainUsability([{ bid: 1, ask: 1.2, volume: 500, openInterest: 500 }], cfg).usable, false);

  const wide = Array.from({ length: 25 }, () => ({ bid: 1.00, ask: 1.50, volume: 500, openInterest: 500 }));
  const dead = summarizeOptionsChainUsability(wide, cfg);
  assert.equal(dead.usable, false);
  assert.match(dead.reason, /two-sided|usable/);
});

test("core symbols can be scanned while dynamic symbols are chain-gated", () => {
  assert.equal(dynamicOptionsSymbolEligible("SPCX", []).usable, true);
  assert.equal(dynamicOptionsSymbolEligible("RANDOM", []).usable, false);
});
