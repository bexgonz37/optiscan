import test from "node:test";
import assert from "node:assert/strict";

const mod = await import("../lib/stock-momentum-policy.ts");

const cfg = mod.stockMomentumPolicyConfig({});

test("broad stock eligibility requires price band, cumulative day volume, and +10% gain", () => {
  assert.equal(mod.broadStockEligibility({ symbol: "RUNR", price: 8.5, dayVolume: 510_000, gainFromPrevClosePct: 10.2 }, cfg).ok, true);
  assert.equal(mod.broadStockEligibility({ symbol: "LOWV", price: 8.5, dayVolume: 499_999, gainFromPrevClosePct: 12 }, cfg).failedGate, "volume");
  assert.equal(mod.broadStockEligibility({ symbol: "BIG", price: 136, dayVolume: 10_000_000, gainFromPrevClosePct: 15 }, cfg).failedGate, "price");
  assert.equal(mod.broadStockEligibility({ symbol: "FLAT", price: 7, dayVolume: 900_000, gainFromPrevClosePct: 9.9 }, cfg).failedGate, "gain");
});

test("standard fast mover uses percent units and passes deterministic evidence", () => {
  const decision = mod.fastStockMomentumEligibility({
    symbol: "RUNR",
    price: 7.25,
    dayVolume: 1_200_000,
    gainFromPrevClosePct: 18,
    direction: "bullish",
    ret10sPct: 0.42,
    ret30sPct: 1.08,
    ret60sPct: 1.7,
    velocityPctPerMin: 2.1,
    volumeAcceleration: 12,
    volumeRate: 5500,
    spreadPct: 0.4,
    quoteAgeMs: 1400,
    aboveVwap: true,
    hodBreak: false,
    vwapDistPct: 1.2,
    classification: "FRESH_ACCELERATION",
  }, cfg);
  assert.equal(decision.ok, true);
});

test("exceptional fast mover can pass without every return window", () => {
  const decision = mod.fastStockMomentumEligibility({
    symbol: "BURST",
    price: 4.2,
    dayVolume: 5_000_000,
    gainFromPrevClosePct: 30,
    direction: "bullish",
    ret10sPct: 0.55,
    ret30sPct: 0.62,
    ret60sPct: null,
    velocityPctPerMin: 3.4,
    volumeAcceleration: 0,
    volumeRate: 9400,
    spreadPct: 0.8,
    quoteAgeMs: 500,
    aboveVwap: true,
    hodBreak: true,
    vwapDistPct: 1.9,
    classification: "CONTINUATION",
  }, cfg);
  assert.equal(decision.ok, true);
  assert.match(decision.reason, /exceptional/);
});

test("falling, stale, wide, and extended names are rejected before stock alerts", () => {
  const base = {
    symbol: "BAD",
    price: 5,
    dayVolume: 900_000,
    gainFromPrevClosePct: 14,
    direction: "bullish",
    ret10sPct: 0.5,
    ret30sPct: 1.2,
    ret60sPct: 2,
    velocityPctPerMin: 2.2,
    volumeAcceleration: 10,
    volumeRate: 3200,
    spreadPct: 0.6,
    quoteAgeMs: 1000,
    aboveVwap: true,
    hodBreak: false,
    vwapDistPct: 1,
    classification: "FRESH_ACCELERATION",
  };
  assert.equal(mod.fastStockMomentumEligibility({ ...base, direction: "bearish" }, cfg).failedGate, "direction");
  assert.equal(mod.fastStockMomentumEligibility({ ...base, quoteAgeMs: 20_000 }, cfg).failedGate, "freshness");
  assert.equal(mod.fastStockMomentumEligibility({ ...base, spreadPct: 2.1 }, cfg).failedGate, "spread");
  assert.equal(mod.fastStockMomentumEligibility({ ...base, vwapDistPct: 3.0 }, cfg).failedGate, "vwap_extension");
});
