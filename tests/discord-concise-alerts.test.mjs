import test from "node:test";
import assert from "node:assert/strict";
import {
  formatPrivateLiveAlert,
  plainEnglishAlertReason,
} from "../lib/research/options/format.ts";
import { formatMarketOpenConfirm } from "../lib/notifications/owner-research-notify.ts";
import {
  formatOpportunityClosedUpdate,
  formatReturnMilestoneUpdate,
} from "../lib/research/options/milestone-format.ts";

const opening = (side) => formatPrivateLiveAlert({
  symbol: side === "put" ? "NVDA" : "SPY",
  side,
  strike: side === "put" ? 200 : 640,
  expiration: "2026-07-29",
  entryMid: side === "put" ? 0.495 : 1.25,
  t1: side === "put" ? 0.65 : 1.55,
  t2: side === "put" ? 0.85 : 1.9,
  stop: side === "put" ? 0.35 : 0.95,
  strategyKey: side === "put" ? "momentum_breakdown" : "sr_reclaim",
  underlyingPrice: side === "put" ? 200.24 : 639.8,
  dte: 0,
  optionSymbol: side === "put" ? "O:NVDA260729P00200000" : "O:SPY260729C00640000",
  actionableReason: side === "put"
    ? "Support broke with downside momentum and put-flow confirmation."
    : "SPY reclaimed VWAP and held the opening range with volume.",
  invalidation: side === "put"
    ? "Exit if NVDA reclaims the broken support."
    : "Exit if SPY loses VWAP and the opening-range low.",
  bid: side === "put" ? 0.49 : 1.2,
  ask: side === "put" ? 0.5 : 1.3,
  spreadPct: side === "put" ? 2.02 : 8,
  confidence: side === "put" ? 0.85 : 0.78,
  detailUrl: `/alerts/sample-${side}`,
});

const summary = {
  currentReturnPct: 25,
  maxReturnPct: 31,
  currentStatus: "RUNNING",
  originalThesis: ["VWAP reclaim held", "Volume expanded"],
  evidenceCount: 4,
  latestEvidence: null,
  milestoneHistory: [],
  elapsedTimeMs: 900_000,
  currentConfidence: 0.8,
  lastUpdatedAt: "2026-07-29T14:45:00.000Z",
  frozenEntry: 1.25,
  currentMark: 1.56,
  nextUndeliveredReturnMilestone: 50,
  active: true,
  openedAtMs: Date.parse("2026-07-29T14:30:00.000Z"),
};

test("canonical call and put openings stay concise and dossier-linked", () => {
  for (const side of ["call", "put"]) {
    const message = opening(side);
    assert.match(message, side === "put" ? /🔴 NVDA PUT ALERT/ : /🟢 SPY CALL ALERT/);
    assert.match(message, /(?:NVDA|SPY) 07\/29 \$\d+ (?:Call|Put)/);
    assert.match(message, /Entry: \$\d+\.\d{2}–\$\d+\.\d{2}/);
    assert.match(message, /Why: .+\./);
    assert.match(message, /Educational purposes only\. Options are high risk\./);
    assert.match(message, /View details: \/alerts\//);
    assert.doesNotMatch(
      message,
      /O:|Contract:|DTE|T1|T2|Stop|Confidence|Spread|Volume|Open interest|Delta|Freshness|setup|passed|blocker|pipeline|subscriber|Risk:/i,
    );
  }
});

test("plain-English mapper translates condition IDs without leaking IDs", () => {
  const cases = [
    {
      input: { symbol: "SPY", side: "put", conditionIds: ["downside_momentum", "below_vwap_or_rejection"] },
      expected: "SPY stayed below VWAP and bearish momentum increased.",
    },
    {
      input: { symbol: "SPY", side: "put", conditionIds: ["support_break", "failed_reclaim"] },
      expected: "SPY broke support and failed to reclaim it.",
    },
    {
      input: { symbol: "NVDA", side: "call", conditionIds: ["reclaimed_vwap", "momentum_acceleration"] },
      expected: "NVDA reclaimed VWAP and momentum accelerated.",
    },
    {
      input: { symbol: "NVDA", side: "call", conditionIds: ["opening_range_breakout", "volume_confirmation"] },
      expected: "NVDA broke the opening range with rising volume.",
    },
    {
      input: {
        symbol: "NVDA",
        side: "call",
        strategyKey: "sr_reclaim",
        sourceReason: "NVDA reclaimed VWAP and broke above resistance with rising momentum.",
      },
      expected: "NVDA reclaimed VWAP and broke above resistance with rising momentum.",
    },
  ];
  for (const row of cases) {
    const reason = plainEnglishAlertReason(row.input);
    assert.equal(reason, row.expected);
    assert.doesNotMatch(reason, /_|condition|score|gate|pipeline/i);
  }
});

test("almost-ready watchlist and lifecycle samples use their canonical non-opening formats", () => {
  const watchlist = formatMarketOpenConfirm({
    tradingDay: "2026-07-29",
    builtAtMs: Date.parse("2026-07-29T13:35:00.000Z"),
    planVersion: "sample",
    marketContext: { spyNote: "SPY holding VWAP", qqqNote: "QQQ mixed", newsNote: "No new catalyst" },
    recommendations: [{
      symbol: "AAPL",
      bias: "bullish",
      setupFamily: "support_reclaim",
      triggerLevel: 215.4,
      invalidationLevel: 213.9,
      preferredDteRange: "7-14 DTE",
      preferredMoneyness: "ATM",
      contractSelectionGuidance: "Select only after options open",
      confidence: 72,
      supportingEvidence: ["Reclaim is one confirmation away"],
      mainRisk: "Trigger may fail below VWAP.",
      verifyContractAfterOpen: true,
      quoteContext: "STALE_PRIOR_SESSION",
      executable: false,
      rank: 1,
      priorContractContext: null,
      status: "ALMOST READY",
    }],
  });
  assert.match(watchlist, /Status: ALMOST READY/);
  assert.match(watchlist, /Not executable/);
  assert.doesNotMatch(watchlist, /TRADE NOW|BEARISH TRADE CANDIDATE/);

  const t1 = formatReturnMilestoneUpdate({
    symbol: "SPY",
    optionType: "CALL",
    strike: 640,
    milestonePercent: 25,
    summary,
    opportunityCaseId: "oc_sample",
    eventLabel: "TARGET 1 HIT",
  });
  const stopped = formatOpportunityClosedUpdate({
    symbol: "SPY",
    optionType: "CALL",
    strike: 640,
    summary: { ...summary, currentStatus: "INVALIDATED", currentReturnPct: -24, currentMark: 0.95, active: false },
    exitReason: "stop_hit",
    opportunityCaseId: "oc_sample",
    invalidated: true,
  });
  const winner = formatOpportunityClosedUpdate({
    symbol: "NVDA",
    optionType: "CALL",
    strike: 180,
    summary: { ...summary, currentStatus: "CLOSED", currentReturnPct: 42, currentMark: 1.78, active: false },
    exitReason: "time_stop",
    opportunityCaseId: "oc_winner",
  });
  assert.match(t1, /🏁 SPY CALL · TARGET 1 HIT/);
  assert.match(t1, /Entry: \$1\.25\nCurrent: \$1\.56\nMove: \+25\.0%/);
  assert.match(stopped, /⛔ SPY CALL · STOPPED/);
  assert.match(stopped, /Entry: \$1\.25\nExit: \$0\.95\nResult: -24\.0%/);
  assert.match(winner, /✅ NVDA CALL · CLOSED WINNER/);
  assert.match(winner, /Result: \+42\.0%/);
  for (const message of [t1, stopped, winner]) {
    assert.match(message, /Educational purposes only\./);
    assert.match(message, /View details: \/intelligence\//);
    assert.doesNotMatch(message, /thesis|evidence|confidence|spread|delta|freshness|Ref:/i);
  }
});
