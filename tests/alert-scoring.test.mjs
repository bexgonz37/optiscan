import test from "node:test";
import assert from "node:assert/strict";
import {
  optionsLiquidityScore,
  riskScore,
  setupScore,
  isFalsePositive,
  ivToPct,
} from "../lib/alert-scoring.js";

test("ivToPct normalizes decimals and percents", () => {
  assert.equal(ivToPct(0.45), 45);
  assert.equal(ivToPct(45), 45);
  assert.equal(ivToPct(null), null);
});

test("optionsLiquidityScore: liquid contract scores high, dead one low", () => {
  const liquid = optionsLiquidityScore({ spreadPct: 2, volume: 3000, openInterest: 8000, dte: 14 });
  const dead = optionsLiquidityScore({ spreadPct: 22, volume: 3, openInterest: 40, dte: 60 });
  assert.ok(liquid.score >= 90, `liquid=${liquid.score}`);
  assert.ok(dead.score <= 10, `dead=${dead.score}`);
  assert.ok(liquid.score <= 100 && dead.score >= 0);
});

test("optionsLiquidityScore: missing quote zeroes the spread part", () => {
  const noQuote = optionsLiquidityScore({ spreadPct: null, volume: 3000, openInterest: 8000, dte: 14 });
  const quoted = optionsLiquidityScore({ spreadPct: 0, volume: 3000, openInterest: 8000, dte: 14 });
  assert.equal(quoted.score - noQuote.score, 40);
  assert.ok(noQuote.reasons.some((r) => r.includes("spread unknown")));
});

test("riskScore: clean liquid setup ~0, flag pile-up climbs and caps at 100", () => {
  const clean = riskScore({
    spreadPct: 3, openInterest: 5000, catalystType: "earnings", catalystQuality: "strong",
    movePct: 2, shareVolume: 5_000_000, iv: 0.4, minsToClose: 300,
  });
  assert.ok(clean.score <= 5, `clean=${clean.score}`);

  const ugly = riskScore({
    spreadPct: 30, openInterest: 10, catalystType: "no_clear_catalyst", catalystQuality: "unknown",
    movePct: 18, shareVolume: 50_000, iv: 2.0, minsToClose: 10,
  });
  assert.ok(ugly.score >= 85 && ugly.score <= 100, `ugly=${ugly.score}`);
  assert.ok(ugly.reasons.some((r) => r.includes("No clear catalyst")));
  assert.ok(ugly.reasons.some((r) => r.includes("Very high IV")));
  assert.ok(ugly.reasons.some((r) => r.includes("Near market close")));
});

test("riskScore: stale catalyst counts as a catalyst red flag", () => {
  const stale = riskScore({ catalystType: "earnings", catalystQuality: "stale" });
  assert.equal(stale.score, 15);
  assert.ok(stale.reasons.some((r) => r.includes("stale")));
});

test("setupScore: components sum per spec weights and are capped", () => {
  const strong = setupScore({
    relVol: 4, movePct: 3.5, catalystType: "earnings", catalystQuality: "strong",
    liquidityScore: 100, riskScore: 0, trendAligned: true, vwapAligned: true,
  });
  // 20 + 10.5 + 20 + 20 + 10 + 10 - 0 = 90.5 -> 91
  assert.equal(strong.score, 91);
  assert.equal(strong.breakdown.relVol, 20);
  assert.equal(strong.breakdown.catalyst, 20);
  assert.equal(strong.breakdown.timing, 10);
  assert.equal(strong.breakdown.technical, 10);
  assert.equal(strong.breakdown.riskPenalty, 0);

  const weak = setupScore({ relVol: 1, movePct: 0.5, catalystQuality: "unknown", liquidityScore: 10, riskScore: 80 });
  assert.ok(weak.score <= 10, `weak=${weak.score}`);
  assert.equal(weak.breakdown.riskPenalty, -20);
});

test("setupScore: extended moves lose the timing points", () => {
  const base = { relVol: 2, catalystQuality: "medium", liquidityScore: 60, riskScore: 20 };
  const early = setupScore({ ...base, movePct: 3 });
  const late = setupScore({ ...base, movePct: 12 });
  assert.equal(early.breakdown.timing, 10);
  assert.equal(late.breakdown.timing, 0);
  assert.ok(late.reasons.some((r) => r.includes("extended")));
});

test("setupScore bounded 0-100 and risk penalty caps at 25", () => {
  const max = setupScore({ relVol: 10, movePct: 5, catalystQuality: "strong", liquidityScore: 100, riskScore: 0, trendAligned: true, vwapAligned: true });
  assert.ok(max.score <= 100);
  const pen = setupScore({ relVol: 1, movePct: 0, catalystQuality: "unknown", liquidityScore: 0, riskScore: 100 });
  assert.equal(pen.breakdown.riskPenalty, -25);
  assert.ok(pen.score >= 0);
});

test("isFalsePositive: needs BOTH no-follow-through and unfavorable close", () => {
  assert.equal(isFalsePositive({ maxFavorablePct: 0.4, eodFavorablePct: -2.1 }), true);
  assert.equal(isFalsePositive({ maxFavorablePct: 3.0, eodFavorablePct: -1.0 }), false);
  assert.equal(isFalsePositive({ maxFavorablePct: 0.8, eodFavorablePct: 0.5 }), false);
  assert.equal(isFalsePositive({ maxFavorablePct: null, eodFavorablePct: -1 }), false);
});
