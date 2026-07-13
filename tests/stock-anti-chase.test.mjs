import test from "node:test";
import assert from "node:assert/strict";
import { stockGateConfig, stockNowOnlyEligible } from "../lib/stock-callout.ts";

const NOW = Date.parse("2026-07-13T17:00:00Z"); // 1pm ET, regular session

/** A stock setup that passes EVERY gate except whatever the test varies. */
function base(over = {}) {
  return {
    ticker: "TEST", direction: "bullish", price: 100, bid: 99.98, ask: 100.02,
    quoteAsOfMs: NOW - 1000, confidence: 82, actionableNow: true, session: "regular",
    nowMs: NOW, vwap: 99.8, dayChangePct: 2.0, ...over,
  };
}

test("config exposes the anti-chase thresholds with sane defaults", () => {
  const cfg = stockGateConfig({});
  assert.equal(cfg.maxVwapExtensionPct, 2.5);
  assert.equal(cfg.maxDayRunPct, 6);
});

test("a clean, near-VWAP momentum setup still passes", () => {
  const r = stockNowOnlyEligible(base(), stockGateConfig({}));
  assert.equal(r.ok, true, r.reason);
});

test("a name that has already run too far on the day is blocked as a chase (USO case)", () => {
  // USO-like: up ~+10% on the day, price pushed to the after-hours high.
  const r = stockNowOnlyEligible(base({ dayChangePct: 10.2, session: "afterhours" }), stockGateConfig({ STOCK_EXTENDED_HOURS: "1" }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /extended: already \+10\.2% on the day/);
});

test("price too far above VWAP is blocked as a top-of-candle chase", () => {
  // price 100 vs VWAP 96 = +4.17% extended (> 2.5% default).
  const r = stockNowOnlyEligible(base({ vwap: 96, dayChangePct: 3 }), stockGateConfig({}));
  assert.equal(r.ok, false);
  assert.match(r.reason, /above VWAP/);
});

test("the gate is exactly at the threshold boundary (>= blocks)", () => {
  // dayChangePct exactly 6 → blocked; 5.9 → allowed.
  assert.equal(stockNowOnlyEligible(base({ dayChangePct: 6 }), stockGateConfig({})).ok, false);
  assert.equal(stockNowOnlyEligible(base({ dayChangePct: 5.9 }), stockGateConfig({})).ok, true);
});

test("missing VWAP / day-change does NOT fabricate an extension block (fail-open per dimension)", () => {
  // No vwap and no dayChangePct → extension guards skipped; other gates still pass.
  const r = stockNowOnlyEligible(base({ vwap: null, dayChangePct: null }), stockGateConfig({}));
  assert.equal(r.ok, true, r.reason);
});

test("thresholds set to 0 disable the anti-chase gate (fully overridable)", () => {
  const cfg = stockGateConfig({ STOCK_MAX_DAY_RUN_PCT: "0", STOCK_MAX_VWAP_EXT_PCT: "0" });
  const r = stockNowOnlyEligible(base({ dayChangePct: 25, vwap: 80 }), cfg);
  assert.equal(r.ok, true, "with the gate disabled even a huge run passes the other gates");
});

test("custom thresholds are honored", () => {
  // Tighten day-run to 3% → a +4% day is now a chase.
  const cfg = stockGateConfig({ STOCK_MAX_DAY_RUN_PCT: "3" });
  assert.equal(stockNowOnlyEligible(base({ dayChangePct: 4 }), cfg).ok, false);
});
