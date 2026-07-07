import test from "node:test";
import assert from "node:assert/strict";
import {
  acceleration,
  volumeSurge,
  pathEfficiency,
  detectLevels,
  directionRead,
  moveStatus,
  MOVE_STATUS_LABEL,
  expectedRemainingMovePct,
  zeroDteContractScore,
  watchScores,
  optionStillWorthIt,
  tradeBias,
  TRADE_BIAS_LABEL,
  riskFlags0dte,
  shouldTrigger,
  rankZeroDteContracts,
  speedPersistentFromRing,
  contractEntryGate,
  trendAlignedForTrade,
  nearTheMoneyPair,
} from "../lib/zero-dte.js";

const T0 = Date.parse("2026-07-06T15:00:00Z");
/** Build a per-second ring: priceFn(i) and cumulative volume volFn(i). */
function ring(n, priceFn, volPerSec = 1000) {
  return Array.from({ length: n }, (_, i) => ({ t: T0 + i * 1000, p: priceFn(i), v: (i + 1) * volPerSec }));
}

test("acceleration: speeding-up tape reads accel > 0, steady reads ~0", () => {
  // flat first minute, then ripping: short rate >> long rate
  const r = ring(120, (i) => (i < 90 ? 100 : 100 + (i - 90) * 0.05));
  const a = acceleration(r, { nowMs: T0 + 119000 });
  assert.ok(a.shortRate > a.longRate, JSON.stringify(a));
  assert.ok(a.accel > 0);
  const steady = acceleration(ring(120, (i) => 100 + i * 0.01), { nowMs: T0 + 119000 });
  assert.ok(Math.abs(steady.accel) < 0.2, JSON.stringify(steady));
});

test("volumeSurge: burst in recent volume -> ratio > 1", () => {
  const r = Array.from({ length: 180 }, (_, i) => ({
    t: T0 + i * 1000, p: 100, v: i < 150 ? i * 500 : 150 * 500 + (i - 150) * 3000,
  }));
  assert.ok(volumeSurge(r, { nowMs: T0 + 179000 }) > 2);
});

test("pathEfficiency: straight line ~1, sawtooth chop near 0", () => {
  assert.ok(pathEfficiency(ring(120, (i) => 100 + i * 0.02)) > 0.9);
  assert.ok(pathEfficiency(ring(120, (i) => 100 + (i % 2 === 0 ? 0.3 : 0))) < 0.1);
});

test("detectLevels: HOD/LOD breaks and VWAP side", () => {
  const l = detectLevels({ price: 101, dayHigh: 100.9, dayLow: 98, vwap: 100 });
  assert.equal(l.hodBreak, true);
  assert.equal(l.aboveVwap, true);
  const s = detectLevels({ price: 97.9, dayHigh: 101, dayLow: 98, vwap: 99 });
  assert.equal(s.lodBreak, true);
  assert.equal(s.aboveVwap, false);
});

test("directionRead: the call-vs-put answer is explicit", () => {
  const up = directionRead({ movePct: 2.4, shortRate: 0.3, accel: 0.1, aboveVwap: true, hodBreak: true, lodBreak: false, efficiency: 0.7 });
  assert.equal(up.direction, "bullish");
  assert.ok(up.confidence >= 70);
  const down = directionRead({ movePct: -3.1, shortRate: -0.4, accel: -0.1, aboveVwap: false, hodBreak: false, lodBreak: true, efficiency: 0.6 });
  assert.equal(down.direction, "bearish");
  const chop = directionRead({ movePct: 0.1, shortRate: 0.02, accel: 0, aboveVwap: true, hodBreak: false, lodBreak: true, efficiency: 0.2 });
  assert.equal(chop.direction, "choppy");
});

test("SPEC: a stock up 15%+ is NOT auto-rejected — still 'continuing' while accelerating", () => {
  const status = moveStatus({
    movePct: 16.4, shortRate: 0.5, accel: 0.15, direction: "bullish",
    aboveVwap: true, hodBreak: true, lodBreak: false, surge: 1.8, efficiency: 0.65,
  });
  assert.equal(status, "continuing");
  assert.equal(MOVE_STATUS_LABEL[status], "Continuation Setup");
});

test("moveStatus: extended + decelerating + fading volume -> chase risk; against-VWAP -> exhausted", () => {
  const risky = moveStatus({ movePct: 12, shortRate: 0.05, accel: -0.2, direction: "bullish", aboveVwap: true, hodBreak: false, lodBreak: false, surge: 0.6, efficiency: 0.5 });
  assert.equal(risky, "extended_risky");
  const dead = moveStatus({ movePct: 9, shortRate: -0.2, accel: -0.3, direction: "bullish", aboveVwap: false, hodBreak: false, lodBreak: false, surge: 0.5, efficiency: 0.5 });
  assert.equal(dead, "exhausted");
});

const CALL = { side: "call", mid: 1.2, spreadPct: 3, volume: 5000, openInterest: 1200, delta: 0.45, iv: 0.9, underlyingPrice: 500, dte: 0 };

test("zeroDteContractScore: liquid ATM 0DTE scores high; wide/dead/lotto scores low with flags", () => {
  const good = zeroDteContractScore(CALL, { minsToClose: 200, expRemainPct: 0.8 });
  assert.ok(good.score >= 80, `good=${good.score}`);
  const bad = zeroDteContractScore(
    { side: "call", mid: 0.05, spreadPct: 25, volume: 10, openInterest: 5, delta: 0.05, iv: 4.8, underlyingPrice: 500 },
    { minsToClose: 30, expRemainPct: 0.4 },
  );
  assert.ok(bad.score <= 15, `bad=${bad.score}`);
  assert.equal(bad.flags.spreadTooWide, true);
  assert.equal(bad.flags.ivTooHot, true);
  assert.equal(bad.flags.lowLiquidity, true);
  assert.equal(bad.flags.thetaRiskHigh, true);
});

test("zeroDteContractScore: premium bigger than plausible remaining move is flagged", () => {
  const rich = zeroDteContractScore({ ...CALL, mid: 9 }, { minsToClose: 200, expRemainPct: 0.5 }); // 1.8% breakeven vs 0.5% left
  assert.equal(rich.flags.premiumTooExpensive, true);
});

test("SPEC: call and put watch scores are separate and directional", () => {
  const bull = watchScores({
    shortRate: 0.4, accel: 0.1, aboveVwap: true, hodBreak: true, lodBreak: false,
    surge: 1.6, relVol: 3, efficiency: 0.7, callContract: CALL, putContract: { ...CALL, side: "put", delta: -0.4 },
    minsToClose: 200, expRemainPct: 0.8,
  });
  assert.ok(bull.callWatch >= 75, `call=${bull.callWatch}`);
  assert.ok(bull.putWatch <= 40, `put=${bull.putWatch}`);
  assert.ok(bull.callWatch - bull.putWatch >= 30);
});

test("optionStillWorthIt: continuation+liquid = yes; exhausted = Too Late / Skip", () => {
  const yes = optionStillWorthIt({ status: "continuing", contractScore: 85, minsToClose: 200, spreadPct: 3, efficiency: 0.7 });
  assert.ok(yes.score >= 75);
  assert.equal(yes.verdict, "Continuation Setup");
  const late = optionStillWorthIt({ status: "exhausted", contractScore: 85, minsToClose: 200, spreadPct: 3, efficiency: 0.7 });
  assert.equal(late.verdict, "Too Late / Skip");
  const chop = optionStillWorthIt({ status: "continuing", contractScore: 60, minsToClose: 100, spreadPct: 6, efficiency: 0.2 });
  assert.equal(chop.verdict, "Too Choppy / Skip");
});

test("tradeBias: explicit long-call/long-put answers, chop and exhaustion never get a side", () => {
  assert.equal(tradeBias({ direction: "bullish", status: "continuing", callWatch: 85, putWatch: 20, contractScore: 80, worthItScore: 80 }), "long_call_candidate");
  assert.equal(tradeBias({ direction: "bearish", status: "continuing", callWatch: 20, putWatch: 85, contractScore: 80, worthItScore: 80 }), "long_put_candidate");
  assert.equal(tradeBias({ direction: "choppy", status: "continuing", callWatch: 50, putWatch: 50, contractScore: 80, worthItScore: 80 }), "no_clean_setup");
  assert.equal(tradeBias({ direction: "bullish", status: "exhausted", callWatch: 85, putWatch: 20, contractScore: 80, worthItScore: 80 }), "skip");
  assert.equal(tradeBias({ direction: "bullish", status: "continuing", callWatch: 85, putWatch: 20, contractScore: 20, worthItScore: 80 }), "watch_only");
  assert.equal(TRADE_BIAS_LABEL.long_call_candidate, "0DTE Call Watch");
  assert.equal(TRADE_BIAS_LABEL.long_put_candidate, "0DTE Put Watch");
});

test("riskFlags0dte covers the label set incl. fake breakout", () => {
  const flags = riskFlags0dte({
    flags: { spreadTooWide: true, premiumTooExpensive: true, ivTooHot: true, thetaRiskHigh: true, lowLiquidity: true },
    status: "extended_risky", efficiency: 0.2, minsToClose: 30, hodBreak: true, surge: 1.0, direction: "bullish",
  });
  for (const want of ["Spread Too Wide", "Premium Too Expensive", "IV Too Hot", "Theta Risk High", "Too Choppy", "Late-Day Risk", "Low Liquidity", "Reversal Risk", "Fake Breakout Risk"]) {
    assert.ok(flags.includes(want), want);
  }
});

test("SPEC: trigger rule — velocity + volume or level break with surge, chop and cooldown suppress", () => {
  assert.equal(shouldTrigger({ shortRate: 0.4, surge: 1.8, efficiency: 0.6, nowMs: T0 }), true);
  assert.equal(shouldTrigger({ shortRate: 0.4, surge: 1.2, hodBreak: true, efficiency: 0.6, nowMs: T0 }), true);
  assert.equal(shouldTrigger({ shortRate: 0.4, surge: 1.0, hodBreak: true, efficiency: 0.6, nowMs: T0 }), false); // level break needs surge ≥1.2
  assert.equal(shouldTrigger({ shortRate: 0.05, surge: 3, efficiency: 0.6, nowMs: T0 }), false); // too slow
  assert.equal(shouldTrigger({ shortRate: 0.5, surge: 2, efficiency: 0.1, nowMs: T0 }), false); // too choppy
  assert.equal(shouldTrigger({ shortRate: 0.5, surge: 2, efficiency: 0.6, nowMs: T0, cooldownUntil: T0 + 60000 }), false); // cooldown
});

test("speedPersistentFromRing: requires sustained direction-aligned speed", () => {
  const fastRing = ring(12, (i) => 100 + i * 0.08);
  assert.equal(speedPersistentFromRing(fastRing, { minRate: 0.15, direction: "bullish", nowMs: T0 + 11000 }), true);
  const spikeRing = ring(12, (i) => (i < 10 ? 100 : 100 + (i - 10) * 2));
  assert.equal(speedPersistentFromRing(spikeRing, { minRate: 0.15, direction: "bullish", nowMs: T0 + 11000 }), false);
});

test("rankZeroDteContracts: composite ranking beats cheapest/most-volume heuristics", () => {
  const chain = [
    { side: "call", mid: 0.03, spreadPct: 30, volume: 9000, openInterest: 50, delta: 0.03, underlyingPrice: 500 }, // lotto, most volume
    { side: "call", mid: 1.1, spreadPct: 3, volume: 4000, openInterest: 900, delta: 0.42, underlyingPrice: 500 }, // the right one
    { side: "call", mid: 6.0, spreadPct: 2, volume: 300, openInterest: 2000, delta: 0.93, underlyingPrice: 500 }, // deep ITM
    { side: "put", mid: 1.0, spreadPct: 3, volume: 4000, openInterest: 900, delta: -0.4, underlyingPrice: 500 },
  ];
  const ranked = rankZeroDteContracts(chain, "call", { minsToClose: 200, expRemainPct: 0.8 });
  assert.equal(ranked[0].contract.delta, 0.42);
  assert.ok(ranked.every((r) => r.contract.side === "call"));
});

test("expectedRemainingMovePct is conservative and bounded", () => {
  assert.ok(expectedRemainingMovePct({ shortRate: 0.4, minsToClose: 120 }) <= 3);
  assert.ok(expectedRemainingMovePct({ shortRate: 0.01, minsToClose: 200 }) >= 0.15);
});

// ── accuracy-audit gates (2026-07-07): order economics + trend alignment ────

test("contractEntryGate: passes a tight near-ATM contract", () => {
  const g = contractEntryGate(
    { mid: 1.2, spreadPct: 3, delta: 0.5 },
    { underlying: 100, expRemainPct: 1.5 },
  );
  assert.equal(g.ok, true);
});

test("contractEntryGate: blocks wide spreads (the -31% audit ticket was 9.2%)", () => {
  const g = contractEntryGate({ mid: 1.2, spreadPct: 9.2, delta: 0.5 }, { underlying: 100, expRemainPct: 2 });
  assert.equal(g.ok, false);
  assert.ok(g.failures.some((f) => f.includes("spread")));
});

test("contractEntryGate: blocks lotto deltas and deep ITM", () => {
  assert.equal(contractEntryGate({ mid: 0.2, spreadPct: 2, delta: 0.12 }, { underlying: 100, expRemainPct: 2 }).ok, false);
  assert.equal(contractEntryGate({ mid: 8, spreadPct: 2, delta: 0.92 }, { underlying: 100, expRemainPct: 2 }).ok, false);
});

test("contractEntryGate: blocks premium that prices in more move than remains", () => {
  // mid 3 on a $100 stock = 3% breakeven vs ~1% plausibly left
  const g = contractEntryGate({ mid: 3, spreadPct: 2, delta: 0.5 }, { underlying: 100, expRemainPct: 1 });
  assert.equal(g.ok, false);
  assert.ok(g.failures.some((f) => f.includes("breakeven")));
});

test("contractEntryGate: no quote = no BUY", () => {
  assert.equal(contractEntryGate(null, {}).ok, false);
  assert.equal(contractEntryGate({ mid: 0 }, {}).ok, false);
});

test("trendAlignedForTrade: blocks counter-trend flickers (MU call on a -6.8% day)", () => {
  assert.equal(trendAlignedForTrade({ direction: "bullish", movePct: -6.8 }).ok, false);
  // +1.25% day is inside the 1.5% tolerance — small reversals are tradeable
  assert.equal(trendAlignedForTrade({ direction: "bearish", movePct: 1.25 }).ok, true);
});

test("trendAlignedForTrade: tolerance and level-break exception", () => {
  // small counter-move is fine
  assert.equal(trendAlignedForTrade({ direction: "bullish", movePct: -1.0 }).ok, true);
  // hard counter needs an aligned break
  assert.equal(trendAlignedForTrade({ direction: "bullish", movePct: -3, hodBreak: false }).ok, false);
  assert.equal(trendAlignedForTrade({ direction: "bullish", movePct: -3, hodBreak: true }).ok, true);
  // extended day move needs a fresh aligned break (late-chase guard)
  assert.equal(trendAlignedForTrade({ direction: "bearish", movePct: -9, lodBreak: false }).ok, false);
  assert.equal(trendAlignedForTrade({ direction: "bearish", movePct: -9, lodBreak: true }).ok, true);
});

test("rankZeroDteContracts: prefers delta-zone strikes closest to spot, not score alone", () => {
  const contracts = [
    { side: "call", strike: 110, mid: 0.3, spreadPct: 1, volume: 5000, openInterest: 2000, delta: 0.15 }, // far OTM, great liquidity
    { side: "call", strike: 101, mid: 1.4, spreadPct: 4, volume: 800, openInterest: 300, delta: 0.48 },   // near spot, usable delta
    { side: "call", strike: 100, mid: 1.8, spreadPct: 5, volume: 500, openInterest: 200, delta: 0.55 },   // at spot
  ];
  const ranked = rankZeroDteContracts(contracts, "call", { minsToClose: 200, expRemainPct: 2, max: 3, underlying: 100.2 });
  assert.equal(ranked[0].contract.strike, 100);
  assert.equal(ranked[1].contract.strike, 101);
  assert.equal(ranked[2].contract.strike, 110); // lotto wing last even with best liquidity
});

test("nearTheMoneyPair: closest usable strike each side with entry economics", () => {
  const contracts = [
    { side: "call", strike: 100, mid: 1.5, bid: 1.45, ask: 1.55, spreadPct: 6.6, delta: 0.52, optionSymbol: "C100" },
    { side: "call", strike: 105, mid: 0.4, bid: 0.35, ask: 0.45, spreadPct: 25, delta: 0.18, optionSymbol: "C105" },
    { side: "put", strike: 100, mid: 1.6, bid: 1.5, ask: 1.7, spreadPct: 12.5, delta: -0.48, optionSymbol: "P100" },
  ];
  const pair = nearTheMoneyPair(contracts, 100.5);
  assert.equal(pair.call.strike, 100);
  assert.equal(pair.put.strike, 100);
  assert.equal(pair.call.breakevenPct, +((1.5 / 100.5) * 100).toFixed(2));
  assert.ok(pair.put.distFromSpotPct < 1);
});

test("nearTheMoneyPair: null side when nothing usable", () => {
  const pair = nearTheMoneyPair([{ side: "call", strike: 100, mid: 0, delta: 0.5 }], 100);
  assert.equal(pair.call, null);
  assert.equal(pair.put, null);
});
