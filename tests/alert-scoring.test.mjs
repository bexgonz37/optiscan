import test from "node:test";
import assert from "node:assert/strict";
import {
  optionsLiquidityScore,
  riskScore,
  signalQualityScore,
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
    movePct: 2, shareVolume: 5_000_000, iv: 0.4,
  });
  assert.ok(clean.score <= 5, `clean=${clean.score}`);

  const ugly = riskScore({
    spreadPct: 30, openInterest: 10, catalystType: "no_clear_catalyst", catalystQuality: "unknown",
    movePct: 18, shareVolume: 50_000, iv: 2.0,
  });
  assert.ok(ugly.score >= 85 && ugly.score <= 100, `ugly=${ugly.score}`);
  assert.ok(ugly.reasons.some((r) => r.includes("No clear catalyst")));
  assert.ok(ugly.reasons.some((r) => r.includes("Very high IV")));
});

test("riskScore: unknown inputs are not penalized except catalyst", () => {
  const bare = riskScore({ catalystType: "earnings", catalystQuality: "strong" });
  assert.equal(bare.score, 0);
  const noCat = riskScore({});
  assert.equal(noCat.score, 15);
});

test("signalQualityScore: strong confirmed setup beats bare mover", () => {
  const strong = signalQualityScore({
    relVol: 3.5, movePct: 3.5, catalystType: "earnings", catalystQuality: "strong",
    liquidityScore: 90, hasUnusualFlow: true,
  });
  const bare = signalQualityScore({ relVol: 1.1, movePct: 1.0, catalystQuality: "unknown", liquidityScore: 20 });
  assert.ok(strong.score >= 85, `strong=${strong.score}`);
  assert.ok(bare.score <= 25, `bare=${bare.score}`);
});

test("signalQualityScore: overextension penalty kicks in above 8%", () => {
  const base = { relVol: 2, catalystQuality: "medium", liquidityScore: 60 };
  const at4 = signalQualityScore({ ...base, movePct: 4 });
  const at13 = signalQualityScore({ ...base, movePct: 13 });
  // both max the move part (20), but 13% eats a -15 penalty
  assert.equal(at4.score - at13.score, 15);
  assert.ok(at13.reasons.some((r) => r.includes("Overextended")));
});

test("signalQualityScore bounded 0-100", () => {
  const max = signalQualityScore({ relVol: 10, movePct: 4, catalystQuality: "strong", liquidityScore: 100, hasUnusualFlow: true });
  assert.ok(max.score <= 100);
  const min = signalQualityScore({ movePct: 20, catalystQuality: "unknown", liquidityScore: 0 });
  assert.ok(min.score >= 0);
});

test("isFalsePositive: needs BOTH no-follow-through and unfavorable close", () => {
  assert.equal(isFalsePositive({ maxFavorablePct: 0.4, eodFavorablePct: -2.1 }), true);
  // ran 3% then faded: timing miss, not a false positive
  assert.equal(isFalsePositive({ maxFavorablePct: 3.0, eodFavorablePct: -1.0 }), false);
  // never ran but closed favorable
  assert.equal(isFalsePositive({ maxFavorablePct: 0.8, eodFavorablePct: 0.5 }), false);
  assert.equal(isFalsePositive({ maxFavorablePct: null, eodFavorablePct: -1 }), false);
});
