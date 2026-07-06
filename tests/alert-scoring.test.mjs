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
});

test("SPEC: riskScore has NO catalyst input — no news is not a red flag", () => {
  const clean = riskScore({
    spreadPct: 3, optionVolume: 4000, openInterest: 2000, efficiency: 0.7,
    moveStatus: "continuing", iv: 0.9, minsToClose: 200, shareVolume: 30_000_000,
  });
  assert.ok(clean.score <= 5, `clean=${clean.score}`);
  // identical input with catalyst fields present changes nothing:
  const withCat = riskScore({
    spreadPct: 3, optionVolume: 4000, openInterest: 2000, efficiency: 0.7,
    moveStatus: "continuing", iv: 0.9, minsToClose: 200, shareVolume: 30_000_000,
    catalystType: "no_clear_catalyst", catalystQuality: "unknown",
  });
  assert.equal(clean.score, withCat.score);
});

test("SPEC: riskScore does not penalize big moves — structure does the work", () => {
  const bigCleanMove = riskScore({
    spreadPct: 3, optionVolume: 4000, openInterest: 2000, efficiency: 0.7,
    moveStatus: "continuing", movePct: 17, iv: 0.9, minsToClose: 200, shareVolume: 30_000_000,
  });
  assert.ok(bigCleanMove.score <= 5, `bigClean=${bigCleanMove.score}`);
  const exhausted = riskScore({ ...{}, moveStatus: "exhausted", efficiency: 0.2, spreadPct: 22, minsToClose: 20 });
  assert.ok(exhausted.score >= 55, `exhausted=${exhausted.score}`);
  assert.ok(exhausted.reasons.some((r) => r.includes("exhausted")));
  assert.ok(exhausted.reasons.some((r) => r.includes("Late-day")));
});

test("SPEC: setupScore has no catalyst term and rewards continuation at ANY size", () => {
  const bigContinuing = setupScore({
    momentum01: 0.9, relVol: 4, surge: 1.8, vwapAligned: true, levelBreak: true,
    optionVolume: 3000, openInterest: 1500, spreadPct: 3, zeroDteScore: 85,
    moveStatus: "continuing", riskScore: 10,
  });
  assert.ok(bigContinuing.score >= 85, `score=${bigContinuing.score}`);
  assert.equal(bigContinuing.breakdown.timing, 10); // continuation = full timing points
  assert.ok(!("catalyst" in bigContinuing.breakdown));

  const exhausted = setupScore({
    momentum01: 0.3, relVol: 1.2, vwapAligned: false, levelBreak: false,
    optionVolume: 50, openInterest: 30, spreadPct: 15, zeroDteScore: 20,
    moveStatus: "exhausted", riskScore: 80,
  });
  assert.ok(exhausted.score <= 15, `exhausted=${exhausted.score}`);
  assert.equal(exhausted.breakdown.timing, 0);
  assert.equal(exhausted.breakdown.riskPenalty, -20);
});

test("setupScore component caps: momentum 20, volume 15, levels 15, liquidity 25, spread 10, 0dte 10, timing 10, penalty -25", () => {
  const max = setupScore({
    momentum01: 1, relVol: 10, surge: 5, vwapAligned: true, levelBreak: true,
    optionVolume: 99999, openInterest: 99999, spreadPct: 0, zeroDteScore: 100,
    moveStatus: "continuing", riskScore: 0,
  });
  assert.equal(max.score, 100);
  assert.equal(max.breakdown.momentum, 20);
  assert.equal(max.breakdown.volume, 15);
  assert.equal(max.breakdown.vwapLevels, 15);
  assert.equal(max.breakdown.liquidity, 25);
  assert.equal(max.breakdown.spread, 10);
  assert.equal(max.breakdown.zeroDteFit, 10);
  assert.equal(max.breakdown.timing, 10);
  const pen = setupScore({ momentum01: 0, riskScore: 100 });
  assert.equal(pen.breakdown.riskPenalty, -25);
  assert.ok(pen.score >= 0);
});

test("isFalsePositive: needs BOTH no-follow-through and unfavorable close", () => {
  assert.equal(isFalsePositive({ maxFavorablePct: 0.4, eodFavorablePct: -2.1 }), true);
  assert.equal(isFalsePositive({ maxFavorablePct: 3.0, eodFavorablePct: -1.0 }), false);
  assert.equal(isFalsePositive({ maxFavorablePct: 0.8, eodFavorablePct: 0.5 }), false);
  assert.equal(isFalsePositive({ maxFavorablePct: null, eodFavorablePct: -1 }), false);
});
