import test from "node:test";
import assert from "node:assert/strict";
import { analyzeExitPolicies } from "../lib/research/options/exit-policy-research.ts";

const START = Date.parse("2026-07-29T14:30:00.000Z"); // 10:30 a.m. ET

function mark(minutes, bid, ask = bid + 0.04, quoteAgeMs = 500) {
  const markAtMs = START + minutes * 60_000;
  return { markAtMs, bid, ask, quoteAgeMs, createdAtMs: markAtMs + quoteAgeMs };
}

function trade(overrides = {}) {
  return {
    tradeId: 1,
    alertId: "oa_exit_research",
    symbol: "NVDA",
    side: "call",
    optionSymbol: "O:NVDA260731C00180000",
    dte: 2,
    strategyFamily: "vwap_reclaim",
    marketRegime: "bullish",
    timeBucket: "midday",
    entryQuality: "good",
    entryFill: 1,
    enteredAtMs: START,
    targetT1: 1.4,
    targetT2: 1.8,
    stop: 0.75,
    status: "EXITED",
    exitFill: 0.8,
    exitAtMs: START + 30 * 60_000,
    canonicalReturnPct: -20,
    exitReason: "stop_hit",
    marks: [
      mark(1, 1.1),
      mark(3, 1.4),
      mark(5, 1.42),
      mark(10, 1),
      mark(11, 1),
      mark(30, 0.8),
    ],
    ...overrides,
  };
}

function policy(report, name) {
  return report.trades[0].policies.find((candidate) => candidate.policy === name);
}

test("a +40% winner later stopped at a loss is classified as profit given back", () => {
  const report = analyzeExitPolicies([trade()], { minimumSupportedSample: 5 });
  const result = report.trades[0];
  assert.equal(result.bestGainPct, 42);
  assert.equal(result.finalResultPct, -20);
  assert.equal(result.gaveBackProfit, true);
  assert.equal(result.lossClassification, "PROFIT_GIVEN_BACK");
  assert.equal(report.profitableThenLostCount, 1);
  assert.equal(report.bestSupportedPolicy, null, "one trade cannot support a production recommendation");
  assert.equal(report.productionBehaviorChanged, false);
  assert.equal(report.advisoryOnly, true);
});

test("partial T1 preserves profit without changing the canonical recorded result", () => {
  const original = trade();
  const before = structuredClone(original);
  const report = analyzeExitPolicies([original], { minimumSupportedSample: 5 });
  assert.equal(policy(report, "Partial at T1").returnPct, 20);
  assert.equal(policy(report, "Current policy").returnPct, -20);
  assert.deepEqual(original, before, "shadow replay is pure and cannot rewrite canonical data");
});

test("break-even protection prevents a winner becoming a loser after confirmation", () => {
  const report = analyzeExitPolicies([trade()], { minimumSupportedSample: 5 });
  const protectedResult = policy(report, "Break-even +10%");
  assert.equal(protectedResult.returnPct, 0);
  assert.match(protectedResult.reason, /two verified bids/);
});

test("trailing stop uses verified bid and requires two observations", () => {
  const report = analyzeExitPolicies([
    trade({
      marks: [
        mark(1, 1.4, 9),
        mark(2, 1.2, 10),
        mark(3, 1.2, 12),
        mark(30, 0.8, 0.84),
      ],
    }),
  ], { minimumSupportedSample: 5 });
  const trailed = policy(report, "Trail 10%");
  assert.equal(trailed.returnPct, 20);
  assert.equal(trailed.exitBid, 1.2);

  const noisy = analyzeExitPolicies([
    trade({
      marks: [
        mark(1, 1.4),
        mark(2, 1.2),
        mark(3, 1.5),
        mark(30, 0.8),
      ],
    }),
  ], { minimumSupportedSample: 5 });
  assert.equal(policy(noisy, "Trail 10%").returnPct, -20, "one noisy weakening tick does not force an exit");
});

test("timestamped underlying invalidation exits only after two observations", () => {
  const report = analyzeExitPolicies([
    trade({
      underlyingObservations: [
        { observedAtMs: START + 60_000, setupValid: true, momentumScore: 80 },
        { observedAtMs: START + 2 * 60_000, setupValid: false, momentumScore: 60 },
        { observedAtMs: START + 3 * 60_000, setupValid: false, momentumScore: 55 },
      ],
    }),
  ], { minimumSupportedSample: 5 });
  const result = policy(report, "Underlying thesis exit");
  assert.equal(result.evidenceValid, true);
  assert.equal(result.returnPct, 40);
  assert.match(result.reason, /two consecutive/);
});

test("0DTE protection and time stops remain shadow-only", () => {
  const report = analyzeExitPolicies([
    trade({
      dte: 0,
      marks: [
        mark(1, 1.12),
        mark(2, 1),
        mark(3, 1),
        mark(10, 0.85),
        mark(30, 0.8),
      ],
    }),
  ], { minimumSupportedSample: 5 });
  assert.ok(policy(report, "0DTE protection"));
  assert.equal(policy(report, "0DTE protection").returnPct, 0);
  assert.equal(report.productionBehaviorChanged, false);
});

test("stale quote is excluded and cannot trigger a shadow exit", () => {
  const report = analyzeExitPolicies([
    trade({
      marks: [
        mark(1, 1.4),
        mark(2, 0.7, 0.75, 120_000),
      ],
    }),
  ], { maxQuoteAgeMs: 60_000, minimumSupportedSample: 5 });
  assert.equal(report.trades[0].mfePct, 40);
  assert.equal(policy(report, "Break-even +10%").returnPct, -20);
  assert.doesNotMatch(policy(report, "Break-even +10%").reason, /two verified bids/);
});

// Regression: the trailing simulation re-armed on every new high, which moved its scan window to
// the GLOBAL peak. It could therefore only ever exit after the best price of the whole trade --
// structurally incapable of clipping a winner. Every winner in the delivered cohort came back
// "condition not confirmed", making a trailing stop look free. A real trail exits at the FIRST
// confirmed retracement, which on a convex winner happens long before the peak.
test("trailing stop exits at the first confirmed retracement, not after the global peak", () => {
  const runner = {
    ...trade({ tradeId: 77 }),
    entryFill: 1,
    targetT1: 9, targetT2: 12, stop: 0.55,
    status: "EXITED",
    exitFill: 5,
    exitAtMs: START + 200 * 60_000,
    canonicalReturnPct: 400,
    exitReason: "target_hit",
    marks: [
      mark(1, 1.20),   // +20%
      mark(2, 1.30),   // +30% -- running high
      mark(3, 1.05),   // -19% off the high: a 10% trail is breached
      mark(4, 1.04),   // second consecutive breach -> confirmed exit here
      mark(5, 1.50),
      mark(60, 3.00),
      mark(150, 5.00), // global peak comes much later
      mark(200, 5.00),
    ],
  };

  const out = analyzeExitPolicies([runner], { maxQuoteAgeMs: 60_000, minimumSupportedSample: 1 });
  const t10 = out.trades[0].policies.find((p) => p.policy === "Trail 10%");

  assert.equal(t10.evidenceValid, true, "the retracement is evidenced; the policy must not fall back");
  assert.equal(t10.exitBid, 1.04, "exits on the second confirmed bid below the lock");
  assert.equal(t10.returnPct, 4, "+4%, not the +400% the trade eventually reached");
  assert.ok(
    t10.returnPct < runner.canonicalReturnPct,
    "a trailing stop MUST be able to clip a convex winner -- otherwise the backtest is not measuring risk",
  );
});
