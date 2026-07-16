import test from "node:test";
import assert from "node:assert/strict";
import {
  flattenNumbers,
  assertNoFabricatedNumbers,
  buildQuantEvidenceRegistry,
  legacyNumericTokensForAudit,
  validateNightlyNarrative,
  validateWeeklyProposals,
} from "../lib/ai/schemas.ts";

test("flattenNumbers collects numbers from nested objects, arrays, and label strings", () => {
  const s = flattenNumbers({ a: 7, b: [1.5, { c: 42 }], d: "spread 12.3% (3x)" });
  assert.ok(s.has("7") && s.has("1.5") && s.has("42") && s.has("12.3") && s.has("3"));
});

test("legacy numeric tokenizer splits clock ranges into incorrect performance-like tokens", () => {
  assert.deepEqual(legacyNumericTokensForAudit("10:00-12:00 and 14:00-16:00"), ["10", "00", "12", "00", "14", "00", "16", "00"]);
});

test("assertNoFabricatedNumbers keeps legacy Set behavior for direct callers", () => {
  const allowed = flattenNumbers({ n: 9, rate: 66.7 });
  assert.doesNotThrow(() => assertNoFabricatedNumbers("9 misses at 66.7% with 0 rescues and 1 issue", allowed));
  assert.throws(() => assertNoFabricatedNumbers("actually 15 misses", allowed), /not present in the deterministic summary: 15/);
});

const SUMMARY = {
  tradingDay: "2026-07-14",
  counts: { outcomesGraded: 10, rejected: 4 },
  overall: {
    n: 10,
    wins: 0,
    losses: 7,
    breakeven: 3,
    ungradable: 0,
    winRate: 0,
    breakevenRatePct: 30,
    avgReturnPct: -8.29,
  },
  byTimeOfDay: {
    morning_1000_1200: { n: 5, wins: 0, losses: 3, breakeven: 2, winRate: 0, breakevenRatePct: 40, avgReturnPct: -8.29 },
    afternoon_1400_1600: { n: 5, wins: 0, losses: 4, breakeven: 1, winRate: 0, breakevenRatePct: 20, avgReturnPct: -8.29 },
  },
  signalCorrectExitFailed: 3,
  prioritizedIssue: "exit_management",
};

function narrative(over = {}) {
  return {
    headline: "10 graded outcomes on 2026-07-14",
    whatHappened: "The 10:00-12:00 and 14:00-16:00 buckets had 10 graded outcomes with 3 breakeven results.",
    repeatedPatterns: ["3 of 10 trades were breakeven, a 30% preservation rate."],
    successPatterns: ["Average return was -8.29%."],
    bottlenecks: ["exit management"],
    supportedConclusions: ["exit management is the leak"],
    needsMoreEvidence: ["need more days"],
    prioritizedIssue: "exit_management",
    ...over,
  };
}

test("validateNightlyNarrative accepts supplied time ranges and deterministic metrics", () => {
  const n = validateNightlyNarrative(narrative(), SUMMARY);
  assert.equal(n.headline, "10 graded outcomes on 2026-07-14");
});

test("validateNightlyNarrative treats calendar dates and OCC identifiers as typed non-performance text", () => {
  assert.doesNotThrow(() => validateNightlyNarrative(narrative({
    whatHappened: "On 2026-07-14, AAPL260117C00150000 was mentioned while 10 outcomes were graded.",
  }), SUMMARY));
});

test("validateNightlyNarrative accepts supplied positive percentages, negative percentages, and decimals", () => {
  assert.doesNotThrow(() => validateNightlyNarrative(narrative({
    successPatterns: ["Breakeven preservation was 30%; average return was -8.29% and -8.29 as supplied."],
  }), SUMMARY));
});

test("validateNightlyNarrative rejects invented win rate, P/L, sample size, drawdown, and percentage claims", () => {
  assert.throws(() => validateNightlyNarrative(narrative({ headline: "88% win rate" }), SUMMARY), /unsupported quantitative claim: 88%/);
  assert.throws(() => validateNightlyNarrative(narrative({ whatHappened: "The day made $125." }), SUMMARY), /unsupported quantitative claim/);
  assert.throws(() => validateNightlyNarrative(narrative({ whatHappened: "15 trades were graded." }), SUMMARY), /unsupported quantitative claim: 15/);
  assert.throws(() => validateNightlyNarrative(narrative({ whatHappened: "Max drawdown was -12.5%." }), SUMMARY), /unsupported quantitative claim: -12.5%/);
});

test("unsupplied derived percentage fails, but supplied breakevenRatePct passes", () => {
  const withoutDerived = JSON.parse(JSON.stringify(SUMMARY));
  delete withoutDerived.overall.breakevenRatePct;
  delete withoutDerived.byTimeOfDay.morning_1000_1200.breakevenRatePct;
  delete withoutDerived.byTimeOfDay.afternoon_1400_1600.breakevenRatePct;
  assert.throws(() => validateNightlyNarrative(narrative(), withoutDerived), /unsupported quantitative claim: 30%/);
  assert.doesNotThrow(() => validateNightlyNarrative(narrative(), SUMMARY));
});

test("evidence registry keeps counts, percentages, dates, and time ranges typed separately", () => {
  const evidence = buildQuantEvidenceRegistry(SUMMARY);
  assert.ok(evidence.some((x) => x.type === "count" && x.value === 10));
  assert.ok(evidence.some((x) => x.type === "percentage" && x.value === 30));
  assert.ok(evidence.some((x) => x.type === "percentage" && x.value === -8.29));
  assert.ok(evidence.some((x) => x.type === "date" && x.value === "2026-07-14"));
  assert.ok(evidence.some((x) => x.type === "time_range" && x.value === "10:00-12:00"));
});

test("validateNightlyNarrative rejects a missing required field", () => {
  assert.throws(() => validateNightlyNarrative({ headline: "hi" }, SUMMARY), /whatHappened/);
});

test("validateWeeklyProposals accepts { proposals: [] } and a well-formed proposal", () => {
  assert.deepEqual(validateWeeklyProposals({ proposals: [] }), []);
  const out = validateWeeklyProposals({ proposals: [{
    title: "Tighten spread cap", problem: "wide spreads", evidence: "12 liquidity rejects",
    sampleSize: 12, proposedChange: "lower ENTRY_MAX_SPREAD_PCT to 6", changeLevel: "config-only",
    relevantFiles: ["lib/entry-window.ts"], confidence: "MEDIUM",
  }] });
  assert.equal(out.length, 1);
  assert.equal(out[0].changeLevel, "config-only");
  assert.equal(out[0].confidence, "MEDIUM");
  assert.equal(out[0].sampleSize, 12);
});

test("validateWeeklyProposals rejects a malformed payload / missing required fields", () => {
  assert.throws(() => validateWeeklyProposals({ nope: true }), /must be an array/);
  assert.throws(() => validateWeeklyProposals({ proposals: [{ title: "x" }] }), /problem/);
});
