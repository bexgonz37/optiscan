import test from "node:test";
import assert from "node:assert/strict";
import { buildNightlySummary } from "../lib/ai/nightly-summary.ts";

// 10:00 ET on 2026-07-13 (a Monday) — well inside regular hours.
const ENTRY_MS = Date.parse("2026-07-13T14:00:00Z");

function outcome(over = {}) {
  return {
    strategy: "swing_momentum", direction: "CALL", dteAtEntry: 4, entrySession: "regular",
    entryTimeMs: ENTRY_MS, terminalKind: "TARGET", grade: "WIN", gradingStatus: "GRADED",
    returnPct: 20, opportunityGrade: "HIT", peakFavorablePct: 30, ...over,
  };
}
function candidate(over = {}) {
  return { status: "CREATED", rejectReason: null, entryState: "ACTIONABLE", confidenceTier: "HIGH", direction: "CALL", ...over };
}

test("empty input yields zeros/nulls, never fabricated numbers", () => {
  const s = buildNightlySummary({ tradingDay: "2026-07-13", periodStartMs: null, periodEndMs: null, outcomes: [], candidates: [], live: null });
  assert.equal(s.counts.outcomesGraded, 0);
  assert.equal(s.overall.winRate, null);
  assert.equal(s.callsVsPuts.call.winRate, null);
  assert.equal(s.timing.avgTriggerToDiscordMs, null);
  assert.ok(s.dataGaps.length >= 1);
  assert.ok(!/\bNaN\b/.test(JSON.stringify(s)));
});

test("calls vs puts and win-rate are computed over graded rows only", () => {
  const s = buildNightlySummary({
    tradingDay: "2026-07-13", periodStartMs: null, periodEndMs: null,
    outcomes: [
      outcome({ grade: "WIN" }),
      outcome({ grade: "LOSS", returnPct: -40, opportunityGrade: "NONE" }),
      outcome({ direction: "PUT", grade: "WIN", returnPct: 10 }),
      outcome({ grade: "UNGRADABLE", gradingStatus: "UNGRADABLE", returnPct: null, opportunityGrade: "UNGRADABLE" }),
    ],
    candidates: [], live: null,
  });
  assert.equal(s.callsVsPuts.call.n, 3);
  assert.equal(s.callsVsPuts.call.wins, 1);
  assert.equal(s.callsVsPuts.call.losses, 1);
  assert.equal(s.callsVsPuts.call.winRate, 50); // 1 win / 2 graded
  assert.equal(s.callsVsPuts.put.wins, 1);
  assert.equal(s.counts.outcomesGraded, 3);
  assert.equal(s.counts.outcomesUngradable, 1);
});

test("0DTE vs longer bucketing", () => {
  const s = buildNightlySummary({
    tradingDay: "2026-07-13", periodStartMs: null, periodEndMs: null,
    outcomes: [outcome({ dteAtEntry: 0 }), outcome({ dteAtEntry: 0, grade: "LOSS" }), outcome({ dteAtEntry: 7 })],
    candidates: [], live: null,
  });
  assert.equal(s.zeroDteVsLonger.zeroDte.n, 2);
  assert.equal(s.zeroDteVsLonger.longer.n, 1);
});

test("signal-correct-exit-failed vs both-failed are separated", () => {
  const s = buildNightlySummary({
    tradingDay: "2026-07-13", periodStartMs: null, periodEndMs: null,
    outcomes: [
      outcome({ opportunityGrade: "HIT", grade: "LOSS" }),   // signal right, exit failed
      outcome({ opportunityGrade: "HIT", grade: "BREAKEVEN" }), // signal right, exit failed
      outcome({ opportunityGrade: "NONE", grade: "LOSS" }),  // both failed
    ],
    candidates: [], live: null,
  });
  assert.equal(s.signalCorrectExitFailed, 2);
  assert.equal(s.bothFailed, 1);
});

test("rejection reasons are counted and classified (liquidity / contract data)", () => {
  const s = buildNightlySummary({
    tradingDay: "2026-07-13", periodStartMs: null, periodEndMs: null,
    outcomes: [],
    candidates: [
      candidate({ status: "REJECTED", rejectReason: "spread too wide" }),
      candidate({ status: "REJECTED", rejectReason: "spread too wide" }),
      candidate({ status: "REJECTED", rejectReason: "CONTRACT DATA INCOMPLETE — missing OCC symbol" }),
      candidate({ status: "ELIGIBLE", entryState: "WAIT_FOR_PULLBACK" }),
    ],
    live: null,
  });
  assert.equal(s.counts.rejected, 3);
  assert.equal(s.counts.liquidityRejections, 2);
  assert.equal(s.counts.contractDataRejections, 1);
  assert.equal(s.rejectionReasons["spread too wide"], 2);
  assert.equal(s.waitWatchReasons["WAIT_FOR_PULLBACK"], 1);
});

test("prioritized issue is deterministic (exit management when it dominates)", () => {
  const s = buildNightlySummary({
    tradingDay: "2026-07-13", periodStartMs: null, periodEndMs: null,
    outcomes: [
      outcome({ opportunityGrade: "HIT", grade: "LOSS" }),
      outcome({ opportunityGrade: "HIT", grade: "LOSS" }),
      outcome({ opportunityGrade: "HIT", grade: "BREAKEVEN" }),
    ],
    candidates: [], live: null,
  });
  assert.equal(s.prioritizedIssue, "exit_management");
  assert.ok(s.patterns.some((p) => /exit management/i.test(p)));
});

test("best-effort live instrumentation is surfaced honestly when unavailable", () => {
  const s = buildNightlySummary({
    tradingDay: "2026-07-13", periodStartMs: null, periodEndMs: null,
    outcomes: [outcome()], candidates: [], live: { available: false, actionableAlerts: null, nearMissCount: null, lateCalloutCount: null, crossingRescues: null, avgTriggerToDiscordMs: null },
  });
  assert.equal(s.counts.nearMisses, null);
  assert.equal(s.timing.available, false);
  assert.ok(s.dataGaps.some((g) => /instrumentation unavailable/i.test(g)));
});
