import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveZeroDteStripSymbols,
  nearestKeyLevel,
  stripNearLevel,
} from "../lib/zero-dte-context.ts";
import { applyFastFilterHysteresis } from "../lib/tape-filter-hysteresis.ts";
import { buildVerdictPreview } from "../lib/verdict-preview.ts";

const UNIVERSE = ["SPY", "QQQ", "IWM", "DIA", "TQQQ", "SQQQ", "NVDA", "TSLA"];

test("resolveZeroDteStripSymbols: chart first then universe to 6", () => {
  const syms = resolveZeroDteStripSymbols({
    chartSymbol: "NVDA",
    universe: UNIVERSE,
    max: 6,
  });
  assert.equal(syms.length, 6);
  assert.equal(syms[0], "NVDA");
  assert.deepEqual(syms.slice(1), ["SPY", "QQQ", "IWM", "DIA", "TQQQ"]);
});

test("resolveZeroDteStripSymbols: override fills slots 2-6 then universe", () => {
  const syms = resolveZeroDteStripSymbols({
    chartSymbol: "TSLA",
    override: ["SPY", "QQQ"],
    universe: UNIVERSE,
    max: 6,
  });
  assert.equal(syms.length, 6);
  assert.equal(syms[0], "TSLA");
  assert.ok(syms.includes("SPY"));
  assert.ok(syms.includes("QQQ"));
  assert.ok(syms.includes("IWM"));
});

test("nearestKeyLevel picks closest level", () => {
  const nearest = nearestKeyLevel(100.5, [
    { id: "hod", label: "HOD", price: 102 },
    { id: "vwap", label: "VWAP", price: 100.2 },
  ]);
  assert.equal(nearest?.label, "VWAP");
  assert.ok((nearest?.distPct ?? 99) < 1);
});

test("stripNearLevel within 0.2%", () => {
  assert.equal(stripNearLevel(0.15), true);
  assert.equal(stripNearLevel(0.25), false);
});

test("applyFastFilterHysteresis requires sustained speed", () => {
  const state = new Map();
  const row = { symbol: "SPY", shortRate: 0.2 };
  const t0 = 1_000_000;
  assert.equal(applyFastFilterHysteresis([row], state, t0).length, 0);
  assert.equal(applyFastFilterHysteresis([row], state, t0 + 2000).length, 1);
  const slow = { symbol: "SPY", shortRate: 0.05 };
  assert.equal(applyFastFilterHysteresis([slow], state, t0 + 3000).length, 1);
  assert.equal(applyFastFilterHysteresis([slow], state, t0 + 5100).length, 0);
});

test("buildVerdictPreview returns null without contract", () => {
  assert.equal(buildVerdictPreview({ symbol: "SPY", momentum: null }), null);
});

test("buildVerdictPreview builds WAIT/SKIP verdict from momentum row", () => {
  const preview = buildVerdictPreview({
    symbol: "NVDA",
    momentum: {
      symbol: "NVDA",
      bias: "bullish",
      side: "call",
      score: 72,
      grade: "GOOD",
      momentumScore: 68,
      underlyingPrice: 140,
      movePct: 2.1,
      priceVsVwapPct: 0.4,
      rsi: 58,
      relVol: 1.8,
      trend: "up",
      contract: {
        optionSymbol: "O:NVDA",
        side: "call",
        strike: 140,
        expiration: "2026-07-06",
        dte: 0,
        entry: 1.25,
        mid: 1.25,
        bid: 1.2,
        ask: 1.3,
        delta: 0.52,
        iv: 0.45,
        openInterest: 5000,
        volume: 1200,
        spreadPct: 4,
      },
      reason: "Momentum",
      reasons: ["Above VWAP"],
      warnings: [],
    },
    live: null,
  });
  assert.ok(preview);
  assert.ok(["TRADE", "WAIT", "SKIP"].includes(preview.verdict.action));
  assert.equal(preview.entryPremium, 1.25);
  assert.equal(preview.alertInput.ticker, "NVDA");
});
