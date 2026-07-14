import test from "node:test";
import assert from "node:assert/strict";
import { deriveCandidateLessons } from "../lib/ai/lessons.ts";
import { nightlyRunKey, weeklyRunKey, isoWeekKey, etParts } from "../lib/ai/schedule.ts";
import { screenProposalSafety } from "../lib/ai/safety.ts";
import { estimateCostUsd, modelPrice } from "../lib/ai/pricing.ts";

function summary(over = {}) {
  return {
    version: 1, tradingDay: "2026-07-13", periodStartMs: null, periodEndMs: null,
    counts: {}, rejectionReasons: {}, waitWatchReasons: {}, timing: {},
    callsVsPuts: {}, zeroDteVsLonger: {}, byStrategy: {}, byTimeOfDay: {},
    realizedGrade: {}, opportunityGrade: {}, signalCorrectExitFailed: 0, bothFailed: 0,
    patterns: [], prioritizedIssue: null, dataGaps: [], overall: {}, ...over,
  };
}

// ── candidate lessons: evidence-gated + stable dedup keys ─────────────────────
test("no lesson below the sample threshold; a stable dedup key above it", () => {
  assert.equal(deriveCandidateLessons(summary({ signalCorrectExitFailed: 2 }), { minSample: 3 }).length, 0);
  const ls = deriveCandidateLessons(summary({ signalCorrectExitFailed: 4 }), { minSample: 3 });
  assert.equal(ls.length, 1);
  assert.equal(ls[0].findingType, "exit_management");
  assert.equal(ls[0].dedupKey, "exit_management|all|all|all"); // stable across nights ⇒ dedup
  assert.equal(ls[0].sampleSize, 4);
});

test("a dominant rejection reason yields a classified lesson", () => {
  const ls = deriveCandidateLessons(summary({ rejectionReasons: { "spread too wide": 5 } }), { minSample: 3 });
  assert.ok(ls.some((l) => l.findingType === "liquidity_reject"));
});

// ── schedule predicates (America/New_York) ───────────────────────────────────
test("nightly fires only after the extended-hours cutoff on a trading weekday", () => {
  // 19:00 ET Monday → too early; 20:30 ET Monday → due.
  assert.equal(nightlyRunKey(Date.parse("2026-07-13T23:00:00Z")), null);        // 19:00 ET
  assert.equal(nightlyRunKey(Date.parse("2026-07-14T00:30:00Z")), "2026-07-13"); // 20:30 ET (same ET day)
  // Weekend → never.
  assert.equal(nightlyRunKey(Date.parse("2026-07-12T01:00:00Z")), null); // Sat night ET
});

test("weekly fires Friday night / Saturday and returns the ISO week", () => {
  assert.equal(weeklyRunKey(Date.parse("2026-07-14T02:00:00Z")), null); // Mon
  assert.ok(/^\d{4}-W\d{2}$/.test(weeklyRunKey(Date.parse("2026-07-18T02:00:00Z")) ?? "")); // Fri 22:00 ET
});

test("isoWeekKey is stable and well-formed", () => {
  assert.equal(isoWeekKey("2026-07-13"), "2026-W29");
  assert.match(isoWeekKey("2026-01-01"), /^\d{4}-W\d{2}$/);
});

test("etParts reports the ET weekday", () => {
  assert.equal(etParts(Date.parse("2026-07-13T14:00:00Z")).weekday, "Mon");
});

// ── proposal safety screen (defense-in-depth) ────────────────────────────────
function draft(over = {}) {
  return { title: "t", problem: "p", proposedChange: "c", affectedConfig: null, suggestedPatch: null, expectedBenefit: null, ...over };
}
test("a benign config proposal passes the safety screen", () => {
  assert.equal(screenProposalSafety(draft({ proposedChange: "lower ENTRY_MAX_SPREAD_PCT to 6" })).ok, true);
});
test("forbidden intents are blocked", () => {
  assert.equal(screenProposalSafety(draft({ proposedChange: "enable bearish actionable alerts" })).ok, false);
  assert.equal(screenProposalSafety(draft({ proposedChange: "place a real order via the broker" })).ok, false);
  assert.equal(screenProposalSafety(draft({ proposedChange: "auto-merge low-risk changes" })).ok, false);
  assert.equal(screenProposalSafety(draft({ proposedChange: "bypass the liquidity gate" })).ok, false);
});

// ── pricing ──────────────────────────────────────────────────────────────────
test("cost estimate uses per-model pricing; unknown model falls back conservatively", () => {
  assert.equal(estimateCostUsd("claude-haiku-4-5", 1_000_000, 1_000_000), 6); // $1 in + $5 out
  assert.equal(estimateCostUsd("claude-sonnet-5", 1_000_000, 0), 3);
  assert.deepEqual(modelPrice("totally-unknown"), { inputPerMTok: 5, outputPerMTok: 25 });
  assert.equal(estimateCostUsd("x", 0, 0), 0);
});
