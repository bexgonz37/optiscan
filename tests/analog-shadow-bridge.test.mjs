import test from "node:test";
import assert from "node:assert/strict";
import { buildDecisionSnapshot, queryAnalogShadow } from "../lib/research/shadow/analog-bridge.ts";
import { computeEarliness, compareLanes } from "../lib/research/shadow/earliness.ts";
import { buildMarketContext } from "../lib/research/context/market-context.ts";

const feats = (over = {}) => ({ velPct: 1.2, accelPct: 0.3, rvol: 4, realizedVol: 0.02, atrPct: 1.5, posInRange: 0.8, gapPct: 0.5, liquidityTier: "high", direction: "bullish", symbol: "ASTS", ...over });
const explain = (over = {}) => ({ abstain: false, reason: null, p: 0.62, nAnalogs: 40, effectiveSample: 30, winRate: 0.6, expectancy: 0.1, dispersion: 0.4, contradiction: 0.4, p10: -0.5, p50: 0.3, p90: 1.1, nearest: [{ id: "n1", distance: 0.2, win: true, outcome: 0.5 }], nearestWin: null, nearestLoss: null, ...over });

test("buildDecisionSnapshot emits the same feature keys the episode library uses", () => {
  const s = buildDecisionSnapshot(feats(), 1000, "ASTS_1000");
  for (const k of ["velPct", "rvol", "atrPct", "cmp_liquidity", "cmp_direction", "cmp_symbol"]) assert.ok(k in s.features, `has ${k}`);
  assert.equal(s.features.cmp_liquidity, 2);
  assert.equal(s.features.cmp_direction, 1);
});

test("queryAnalogShadow records evidence, agreement, and a measured latency; never actionable", () => {
  let t = 1000;
  const clock = () => (t += 5); // 5ms lookup
  const scorer = { explain: () => explain() };
  const r = queryAnalogShadow(scorer, feats(), 1000, { actionable: true, direction: "bullish" }, clock);
  assert.equal(r.tag, "ANALOG_SHADOW_ONLY");
  assert.equal(r.comparableCount, 40);
  assert.equal(r.agreesWithLive, true);
  assert.equal(r.agreement, "agree_strong");
  assert.equal(r.forwardReturn.p50, 0.3);
  assert.equal(r.lookupMs, 5);
});

test("shadow analog disagrees when it is bearish on a live-actionable long, and abstains cleanly", () => {
  const disagree = queryAnalogShadow({ explain: () => explain({ p: 0.3 }) }, feats(), 1, { actionable: true, direction: "bullish" });
  assert.equal(disagree.agreesWithLive, false);
  assert.equal(disagree.agreement, "disagree");
  const abst = queryAnalogShadow({ explain: () => explain({ abstain: true, reason: "comparable pool 3 < 15" }) }, feats(), 1, { actionable: true, direction: "bullish" });
  assert.equal(abst.abstain, true);
  assert.equal(abst.agreement, "abstain");
  assert.equal(abst.agreesWithLive, null);
});

test("a throwing scorer is isolated (shadow failure never affects the live path)", () => {
  const r = queryAnalogShadow({ explain: () => { throw new Error("boom"); } }, feats(), 1, { actionable: true, direction: "bullish" });
  assert.equal(r.abstain, true);
  assert.match(r.abstainReason, /error/);
});

// ── earliness ──
test("computeEarliness: detected before expansion is 'before' with lead time", () => {
  const e = computeEarliness({ preMovePrice: 100, detectPrice: 101, breakoutLevel: 103, peakPrice: 110, troughPrice: 99, side: "call", detectAtMs: 0, firstExpansionAtMs: 5000, momentumBaselineDetectPrice: 104 });
  assert.equal(e.phase, "before");
  assert.equal(e.timeLeadMs, 5000);
  assert.ok(e.fractionOfMoveComplete < 0.2, "most of the move still ahead");
  assert.ok(e.priceImprovementPct > 0, "entered cheaper than the momentum baseline");
});

test("compareLanes aggregates broad-only finds + analog rank effect + latency", () => {
  const c = compareLanes([
    { symbol: "A", detectedByBaseline: false, detectedByBroad: true, analogImprovedRank: true, tooLate: false, falsePositive: false, analogLookupMs: 4 },
    { symbol: "B", detectedByBaseline: true, detectedByBroad: true, analogImprovedRank: false, tooLate: true, falsePositive: false, analogLookupMs: 6 },
    { symbol: "C", detectedByBaseline: false, detectedByBroad: true, analogImprovedRank: null, tooLate: false, falsePositive: true, analogLookupMs: null },
  ]);
  assert.equal(c.n, 3);
  assert.ok(c.pctFoundOnlyByBroad > 0);
  assert.ok(c.pctAnalogImprovedRank > 0 && c.pctAnalogWorsenedRank > 0);
  assert.equal(c.avgAnalogLookupMs, 5);
});

// ── market context ──
test("buildMarketContext derives regime and tracks missing fields", () => {
  const c = buildMarketContext({ asOfMs: 1000, spy: { trend: "up", observedAtMs: 900 }, qqq: { trend: "up", observedAtMs: 900 }, iwm: { trend: "flat", observedAtMs: 900 }, vix: { value: 13, observedAtMs: 900 }, sector: "Technology", industry: "Semis", sectorRelStrengthPct: 2, breadthAdvDeclRatio: 2.1, catalystCategory: "earnings", earningsInDays: 1, session: "regular", underlyingLiquidityTier: "high", optionsLiquidityTier: null, optionSpreadPct: 5, ivRankPct: null });
  assert.equal(c.regime, "risk_on");
  assert.equal(c.volRegime, "low");
  assert.ok(c.missing.includes("iv") && c.missing.includes("optionsLiquidity"));
});

test("market context REFUSES look-ahead (a component observed after asOf throws)", () => {
  assert.throws(() => buildMarketContext({ asOfMs: 1000, spy: { trend: "up", observedAtMs: 2000 }, qqq: null, iwm: null, vix: null, sector: null, industry: null, sectorRelStrengthPct: null, breadthAdvDeclRatio: null, catalystCategory: null, earningsInDays: null, session: "regular", underlyingLiquidityTier: null, optionsLiquidityTier: null, optionSpreadPct: null, ivRankPct: null }), /leakage/);
});
