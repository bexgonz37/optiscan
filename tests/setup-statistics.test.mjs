import test from "node:test";
import assert from "node:assert/strict";
import {
  summarizeOutcomes,
  evidenceState,
  wilsonInterval,
  aggregateBy,
  defaultEvidenceThresholds,
} from "../lib/setup-statistics.ts";

let seq = 0;
function outcome(grade, netPnl, over = {}) {
  seq += 1;
  return {
    grade,
    gradingStatus: grade === "UNGRADABLE" ? "UNGRADABLE" : "GRADED",
    dataQualityStatus: "OK",
    netPnl,
    grossPnl: netPnl,
    returnPct: null,
    rMultiple: netPnl == null ? null : netPnl / 50,
    entryFees: 0.65,
    exitFees: 0.65,
    entrySlippage: 0.02,
    exitSlippage: 0.02,
    holdMinutes: 10,
    mfePct: 20,
    maePct: -8,
    exitTimeMs: seq,
    ...over,
  };
}

test("wilson interval is within [0,1] and brackets the point estimate", () => {
  const ci = wilsonInterval(6, 10);
  assert.ok(ci.low >= 0 && ci.high <= 1);
  assert.ok(ci.low < 0.6 && ci.high > 0.6);
  assert.equal(wilsonInterval(0, 0), null);
});

test("summarize counts wins/losses/breakevens and computes net stats", () => {
  const s = summarizeOutcomes([
    outcome("WIN", 100), outcome("WIN", 50), outcome("LOSS", -40), outcome("BREAKEVEN", 0),
  ]);
  assert.equal(s.gradedSampleSize, 4);
  assert.equal(s.wins, 2);
  assert.equal(s.losses, 1);
  assert.equal(s.breakevens, 1);
  assert.equal(s.decisive, 3);
  assert.equal(s.winRate, 66.7); // 2/3
  assert.equal(s.netPnl, 110);
  assert.equal(s.profitFactor, 3.75); // gross win 150 / gross loss 40
  assert.ok(s.winRateInterval && s.winRateInterval.low < 0.667 && s.winRateInterval.high > 0.667);
});

test("ungradable outcomes are excluded from performance but counted for coverage", () => {
  const s = summarizeOutcomes([outcome("WIN", 100), outcome("UNGRADABLE", null), outcome("LOSS", -50)]);
  assert.equal(s.gradedSampleSize, 2);
  assert.equal(s.ungradableCount, 1);
  assert.equal(s.dataQualityCoverage, +(2 / 3).toFixed(4));
  assert.equal(s.netPnl, 50); // ungradable's null pnl not included
});

test("max drawdown and streaks use chronological completion order", () => {
  // order: +100, -60, -60, +40  → equity 100,40,-20,20 → peak 100, maxDd 120
  const s = summarizeOutcomes([
    outcome("WIN", 100), outcome("LOSS", -60), outcome("LOSS", -60), outcome("WIN", 40),
  ]);
  assert.equal(s.maxDrawdown, 120);
  assert.equal(s.maxConsecutiveLosses, 2);
  assert.equal(s.maxConsecutiveWins, 1);
  assert.equal(s.currentStreak, 1); // last was a win
});

test("expectancy in dollars and R are net-based", () => {
  const s = summarizeOutcomes([outcome("WIN", 100), outcome("LOSS", -50)]);
  assert.equal(s.expectancyDollars, 25); // (100 + -50)/2
  assert.equal(s.expectancyR, +(((100 / 50) + (-50 / 50)) / 2).toFixed(3)); // (2 + -1)/2 = 0.5
});

// Evidence thresholds
test("evidence state: NOT_TRACKED at zero graded", () => {
  const s = summarizeOutcomes([outcome("UNGRADABLE", null)]);
  assert.equal(s.evidenceState, "NOT_TRACKED");
});

test("evidence state: INSUFFICIENT_HISTORY below early threshold", () => {
  const s = summarizeOutcomes(Array.from({ length: 5 }, () => outcome("WIN", 10)));
  assert.equal(s.evidenceState, "INSUFFICIENT_HISTORY");
});

test("evidence state: EARLY_EVIDENCE between early and established", () => {
  const s = summarizeOutcomes(Array.from({ length: 30 }, (_, i) => outcome(i % 2 ? "WIN" : "LOSS", i % 2 ? 10 : -10)));
  assert.equal(s.evidenceState, "EARLY_EVIDENCE");
});

test("evidence state: ESTABLISHED requires sample AND wins AND losses AND coverage", () => {
  const many = [
    ...Array.from({ length: 60 }, () => outcome("WIN", 10)),
    ...Array.from({ length: 60 }, () => outcome("LOSS", -10)),
  ];
  const s = summarizeOutcomes(many);
  assert.equal(s.evidenceState, "ESTABLISHED_EVIDENCE");
});

test("high win rate on a thin sample is NEVER established", () => {
  const s = summarizeOutcomes(Array.from({ length: 15 }, () => outcome("WIN", 100)));
  assert.notEqual(s.evidenceState, "ESTABLISHED_EVIDENCE");
  assert.equal(s.winRate, 100);
});

test("established requires enough losses even at 100+ sample", () => {
  const lopsided = [
    ...Array.from({ length: 105 }, () => outcome("WIN", 10)),
    ...Array.from({ length: 5 }, () => outcome("LOSS", -10)), // only 5 losses < 20
  ];
  const s = summarizeOutcomes(lopsided);
  assert.equal(s.gradedSampleSize, 110);
  assert.notEqual(s.evidenceState, "ESTABLISHED_EVIDENCE");
});

test("thresholds are configurable", () => {
  const s = summarizeOutcomes(Array.from({ length: 3 }, () => outcome("WIN", 10)), { ...defaultEvidenceThresholds(), earlyMin: 2, establishedMin: 3, establishedMinWins: 1, establishedMinLosses: 0, establishedMinCoverage: 0 });
  assert.equal(s.evidenceState, "ESTABLISHED_EVIDENCE");
});

test("aggregateBy groups and summarizes independently", () => {
  const rows = [
    { ...outcome("WIN", 10), k: "a" }, { ...outcome("LOSS", -10), k: "a" }, { ...outcome("WIN", 20), k: "b" },
  ];
  const groups = aggregateBy(rows, (o) => o.k);
  assert.equal(groups.length, 2);
  const a = groups.find((g) => g.key === "a");
  assert.equal(a.stats.gradedSampleSize, 2);
});

test("summarize is deterministic", () => {
  const rows = [outcome("WIN", 10), outcome("LOSS", -5), outcome("BREAKEVEN", 0)];
  assert.deepEqual(summarizeOutcomes(rows), summarizeOutcomes(rows));
});
