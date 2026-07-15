import test from "node:test";
import assert from "node:assert/strict";
import { optionsPerformance, durationBucket, etSessionPhase } from "../lib/paper-options-analytics.ts";

const opt = (over = {}) => ({
  optionSymbol: "O:SPY260716C500", optionType: "call", status: "EXITED",
  dteAtEntry: 3, contracts: 2, entryPrice: 1.0, exitPrice: 1.5, lastMark: 1.5,
  entryAtMs: Date.UTC(2026, 6, 16, 14, 0), exitAtMs: Date.UTC(2026, 6, 16, 15, 0),
  strategy: "zero_dte_momentum", entrySlippage: 0.02, exitSlippage: 0.02,
  entryFees: 1.3, exitFees: 1.3, opportunityPeakPct: 60, ...over,
});
const stock = (over = {}) => ({ ...opt(), optionSymbol: null, ...over });

test("options analytics ignores stock (optionSymbol null) — never blends", () => {
  const p = optionsPerformance([opt(), stock({ entryPrice: 10, exitPrice: 12 })]);
  assert.equal(p.overall.count, 1); // only the option is graded
  assert.equal(p.realizedDollars, 100); // (1.5-1.0)*100*2
});

test("duration buckets: 0DTE / weekly / longer", () => {
  assert.equal(durationBucket(0), "0DTE");
  assert.equal(durationBucket(3), "weekly");
  assert.equal(durationBucket(30), "longer");
  assert.equal(durationBucket(null), "unknown");
  const p = optionsPerformance([opt({ dteAtEntry: 0 }), opt({ dteAtEntry: 3 }), opt({ dteAtEntry: 30 })]);
  assert.equal(p.byDuration["0DTE"].count, 1);
  assert.equal(p.byDuration.weekly.count, 1);
  assert.equal(p.byDuration.longer.count, 1);
});

test("CALL vs PUT are reported separately", () => {
  const p = optionsPerformance([opt({ optionType: "call" }), opt({ optionType: "put", exitPrice: 0.5 })]);
  assert.equal(p.byType.call.count, 1);
  assert.equal(p.byType.put.count, 1);
  assert.ok(p.byType.call.realizedDollars > 0);
  assert.ok(p.byType.put.realizedDollars < 0);
});

test("return on premium, profit factor, expectancy computed on option $", () => {
  const p = optionsPerformance([
    opt({ entryPrice: 1.0, exitPrice: 1.5, contracts: 1 }), // +50, premium 100
    opt({ entryPrice: 1.0, exitPrice: 0.5, contracts: 1 }), // -50, premium 100
  ]);
  assert.equal(p.realizedDollars, 0);
  assert.equal(p.returnOnPremiumPct, 0); // 0 / 200
  assert.equal(p.profitFactor, 1);
  assert.equal(p.winRatePct, 50);
});

test("opportunity audit: HIT vs exit-missed vs signal-failed", () => {
  const p = optionsPerformance([
    opt({ exitPrice: 1.5, opportunityPeakPct: 60 }),   // realized win → hitAndCaptured
    opt({ exitPrice: 0.9, opportunityPeakPct: 45 }),   // lost but offered ≥30% → exit missed
    opt({ exitPrice: 0.7, opportunityPeakPct: 5 }),    // lost, never offered → signal failed
  ], 30);
  assert.equal(p.opportunity.hitAndCaptured, 1);
  assert.equal(p.opportunity.signalHitExitMissed, 1);
  assert.equal(p.opportunity.signalFailed, 1);
  assert.equal(p.opportunity.thresholdPct, 30);
});

test("slippage and fees are summed and separated from P&L", () => {
  const p = optionsPerformance([opt({ contracts: 2 })]);
  // entry+exit slip 0.02 each × 100 × 2 = 8; fees 1.3+1.3
  assert.equal(p.totalSlippageDollars, 8);
  assert.equal(p.totalFeesDollars, 2.6);
  assert.ok(p.note.includes("never blended"));
});

test("open positions contribute unrealized only", () => {
  const p = optionsPerformance([opt({ status: "ENTERED", exitPrice: null, lastMark: 1.3, contracts: 1 })]);
  assert.equal(p.openCount, 1);
  assert.equal(p.overall.count, 0);           // not graded
  assert.equal(p.unrealizedDollars, 30);      // (1.3-1.0)*100
});

test("time-of-day bucketing uses ET phases", () => {
  assert.equal(etSessionPhase(Date.UTC(2026, 6, 16, 13, 45)), "open (9:30–10:30)"); // 9:45 ET
  assert.equal(etSessionPhase(Date.UTC(2026, 6, 16, 19, 30)), "power hour (15:00–16:00)"); // 15:30 ET
  const p = optionsPerformance([opt()]);
  assert.ok(p.byTimeOfDay.length >= 1);
});

test("avg contracts/premium/position value", () => {
  const p = optionsPerformance([opt({ contracts: 2, entryPrice: 1.0 }), opt({ contracts: 4, entryPrice: 2.0 })]);
  assert.equal(p.avgContractsPerTrade, 3);        // (2+4)/2
  assert.equal(p.avgPremiumPaid, 1.5);            // (1.0+2.0)/2
  assert.equal(p.avgPositionValueDollars, 500);   // (200 + 800)/2
});
