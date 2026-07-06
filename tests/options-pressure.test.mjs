import test from "node:test";
import assert from "node:assert/strict";
import { optionsPressure, pressureConfirms } from "../lib/options-pressure.js";

const mk = (side, strike, volume, mid, spreadPct = 4) => ({ side, strike, volume, mid, spreadPct });

test("call-heavy volume AND premium -> Call pressure building", () => {
  const p = optionsPressure([
    mk("call", 500, 8000, 1.2), mk("call", 501, 5000, 0.8), mk("put", 499, 3000, 0.9),
  ]);
  assert.equal(p.label, "Call pressure building");
  assert.ok(p.score >= 50);
  assert.equal(pressureConfirms(p.label, "bullish"), true);
  assert.equal(pressureConfirms(p.label, "bearish"), false);
});

test("put-heavy -> Put pressure building; balanced -> mixed/no-clear", () => {
  const put = optionsPressure([mk("put", 499, 9000, 1.1), mk("call", 500, 3000, 0.9)]);
  assert.equal(put.label, "Put pressure building");
  const flat = optionsPressure([mk("call", 500, 5000, 1.0), mk("put", 499, 5000, 1.0)]);
  assert.equal(flat.label, "No clear options confirmation");
});

test("volume and premium disagreeing never claims a side", () => {
  // calls dominate volume but puts dominate dollars (big put premium)
  const p = optionsPressure([mk("call", 500, 8000, 0.1), mk("put", 499, 4000, 3.0)]);
  assert.ok(p.label === "Mixed flow" || p.label === "No clear options confirmation", p.label);
});

test("dead chain -> Liquidity too poor; refresh stall + widening -> Flow fading", () => {
  assert.equal(optionsPressure([mk("call", 500, 100, 1.0), mk("put", 499, 80, 1.0)]).label, "Liquidity too poor");
  const fading = optionsPressure(
    [mk("call", 500, 6000, 1.0, 12), mk("put", 499, 4000, 1.0, 12)],
    { prev: { totalVolume: 9990, avgSpreadPct: 5 } },
  );
  assert.equal(fading.label, "Flow fading");
});
