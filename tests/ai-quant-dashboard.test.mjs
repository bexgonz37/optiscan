import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildQuantDashboard } from "../lib/ai/quant-dashboard.ts";

const DAY = "2026-07-14";

function report(periodKey, summary, over = {}) {
  return {
    id: Math.floor(Math.random() * 10000),
    reportType: "nightly",
    periodKey,
    periodStartMs: null,
    periodEndMs: null,
    summary,
    narrative: null,
    narrativeStatus: "OK",
    model: null,
    diagnostic: null,
    aiJobRunId: null,
    createdAtMs: Date.parse(`${periodKey}T22:00:00Z`),
    updatedAtMs: Date.parse(`${periodKey}T22:00:00Z`),
    ...over,
  };
}

const summary = {
  tradingDay: DAY,
  counts: { outcomesGraded: 10, rejected: 4, created: 3, candidates: 12, lateCallouts: 1 },
  overall: { n: 10, wins: 5, losses: 2, breakeven: 3, winRate: 50, avgReturnPct: 4.2, opportunityHitRate: 70 },
  callsVsPuts: {
    call: { n: 7, wins: 4, losses: 1, winRate: 57.1, avgReturnPct: 6, opportunityHitRate: 80 },
    put: { n: 3, wins: 1, losses: 1, winRate: 33.3, avgReturnPct: -1, opportunityHitRate: 50 },
  },
  zeroDteVsLonger: {
    zeroDte: { n: 5, wins: 3, losses: 1, winRate: 60, avgReturnPct: 8, opportunityHitRate: 80 },
    longer: { n: 5, wins: 2, losses: 1, winRate: 40, avgReturnPct: 1, opportunityHitRate: 60 },
  },
  byStrategy: { swing_momentum: { n: 10, wins: 5, losses: 2, winRate: 50, avgReturnPct: 4.2, opportunityHitRate: 70 } },
  byTimeOfDay: {},
  rejectionReasons: { "spread too wide": 3, "VWAP extended": 1 },
  waitWatchReasons: { WAIT_FOR_PULLBACK: 2 },
  signalCorrectExitFailed: 2,
  prioritizedIssue: "liquidity",
  momentum: {
    total: 10,
    sent: 4,
    nearMisses: 2,
    extendedRejections: 1,
    staleRejected: 1,
    avgLatencyMs: 30000,
    earliness: { pctEarly: 75, counts: { LATE: 1 } },
  },
  options: { delivered: 3, canonical: 4, configBlockedCycles: 1, topDeliveryGateReason: "discord disabled", diagnosis: "delivery disabled" },
  dataGaps: [],
};

test("buildQuantDashboard computes Scanner Health deterministically from stored summaries", () => {
  const q = buildQuantDashboard({
    nightlyReports: [report(DAY, summary), report("2026-07-13", { ...summary, overall: { ...summary.overall, winRate: 40 }, momentum: { ...summary.momentum, nearMisses: 4 } })],
    weeklyReports: [],
    lessons: [],
    proposals: [],
    jobFailures: [],
    latestMomentumDiagnostics: [],
    env: {},
  });
  assert.equal(typeof q.scannerHealth.score, "number");
  assert.match(q.scannerHealth.grade, /^[A-F]|N\/A/);
  assert.ok(q.scannerHealth.components.some((m) => m.label === "Profit Factor" && m.available === false));
  assert.ok(q.reportCard.some((m) => m.label === "Missed Fast Movers" && m.value === 2));
  assert.ok(q.gateBreakdown.some((g) => g.gate === "Spread" && g.count >= 3));
  assert.ok(q.copyTradingReadiness.requirements.some((r) => r.label === "Stable Drawdown" && r.passed === null));
});

test("buildQuantDashboard shows per-runner missed runner examples only from momentum diagnostics", () => {
  const q = buildQuantDashboard({
    nightlyReports: [report(DAY, summary)],
    weeklyReports: [],
    lessons: [],
    proposals: [],
    jobFailures: [],
    latestMomentumDiagnostics: [{
      id: 1,
      ticker: "META",
      evalAtMs: Date.parse("2026-07-14T14:30:00Z"),
      tradingDay: DAY,
      session: "regular",
      movePct: 8.5,
      firstSeenMovePct: 2,
      firstPromotedMovePct: 8.5,
      decision: "NEAR_MISS",
      reason: "VWAP extended",
      createdAtMs: Date.parse("2026-07-14T14:30:01Z"),
    }],
    env: {},
  });
  assert.equal(q.missedRunners.length, 1);
  assert.equal(q.missedRunners[0].ticker, "META");
  assert.equal(q.missedRunners[0].responsibleGate, "VWAP Extension");
  assert.match(q.missedRunners[0].aiExplanation, /No trade decision/);
});

test("AI page exposes the Quant Research Dashboard without live scanner authority", () => {
  const src = readFileSync(join(process.cwd(), "app/ai/page.tsx"), "utf8");
  assert.match(src, /Scanner Health/);
  assert.match(src, /Today's Scanner Report Card/);
  assert.match(src, /Why Setups Were Rejected/);
  assert.match(src, /Missed Runners/);
  assert.match(src, /Strategy Scorecard/);
  assert.match(src, /Copy Trading Readiness/);
  assert.match(src, /AI Research/);
  assert.match(src, /Recommended Experiments/);
  assert.match(src, /Portfolio Comparison/);
  assert.match(src, /Daily AI Summary/);
  assert.match(src, /Visualizations/);
  assert.match(src, /AI Guardrails/);
  assert.doesNotMatch(src, /runScanner|placeOrder/i);
});
