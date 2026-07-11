import test from "node:test";
import assert from "node:assert/strict";
import { checkCapital, defaultCapitalConfig } from "../lib/paper-capital.ts";

const cfg = { ...defaultCapitalConfig({}), startingBalance: 5000, maxBuyingPowerUtilization: 1, maxPositionDollars: 2000, maxConcurrentPositions: 5, maxPerStrategyDailyEntries: 10 };
const ctx = (over = {}) => ({
  equityDollars: 5000, reservedOpenDollars: 0, openPositions: 0,
  openContractSymbols: new Set(), todayStrategyEntries: 0, ...over,
});
const prop = (over = {}) => ({ ticker: "SPY", optionSymbol: "O:SPY_C500", strategy: "zero_dte_momentum", costDollars: 120, units: 1, ...over });

test("clean proposal passes with buying power remaining", () => {
  const v = checkCapital(prop(), ctx(), cfg);
  assert.equal(v.allowed, true);
  assert.equal(v.buyingPowerRemaining, 4880);
});

test("insufficient buying power blocks entry", () => {
  const v = checkCapital(prop({ costDollars: 900 }), ctx({ reservedOpenDollars: 4500 }), cfg);
  assert.equal(v.allowed, false);
  assert.ok(v.failures.some((f) => /buying power/.test(f)));
});

test("max position dollars caps a single trade", () => {
  const v = checkCapital(prop({ costDollars: 2500 }), ctx(), cfg);
  assert.ok(v.failures.some((f) => /max position size/.test(f)));
});

test("max concurrent positions enforced", () => {
  const v = checkCapital(prop(), ctx({ openPositions: 5 }), cfg);
  assert.ok(v.failures.some((f) => /open positions/.test(f)));
});

test("duplicate contract exposure blocked", () => {
  const v = checkCapital(prop(), ctx({ openContractSymbols: new Set(["O:SPY_C500"]) }), cfg);
  assert.ok(v.failures.some((f) => /duplicate contract/.test(f)));
});

test("per-strategy daily entry cap enforced", () => {
  const v = checkCapital(prop(), ctx({ todayStrategyEntries: 10 }), cfg);
  assert.ok(v.failures.some((f) => /entries today/.test(f)));
});

test("invalid cost (NaN / negative / Infinity) is rejected outright", () => {
  for (const bad of [NaN, -5, Infinity, 0]) {
    const v = checkCapital(prop({ costDollars: bad }), ctx(), cfg);
    assert.equal(v.allowed, false, `cost ${bad}`);
    assert.ok(v.failures.some((f) => /invalid position cost/.test(f)));
  }
});

test("invalid unit count is rejected", () => {
  const v = checkCapital(prop({ units: 0 }), ctx(), cfg);
  assert.ok(v.failures.some((f) => /invalid unit count/.test(f)));
});
