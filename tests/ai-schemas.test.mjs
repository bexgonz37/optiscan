import test from "node:test";
import assert from "node:assert/strict";
import {
  flattenNumbers, assertNoFabricatedNumbers, validateNightlyNarrative, validateWeeklyProposals,
} from "../lib/ai/schemas.ts";

test("flattenNumbers collects numbers from nested objects, arrays, and label strings", () => {
  const s = flattenNumbers({ a: 7, b: [1.5, { c: 42 }], d: "spread 12.3% (3×)" });
  assert.ok(s.has("7") && s.has("1.5") && s.has("42") && s.has("12.3") && s.has("3"));
});

test("assertNoFabricatedNumbers allows summary numbers + 0/1, rejects invented ones", () => {
  const allowed = flattenNumbers({ n: 9, rate: 66.7 });
  assert.doesNotThrow(() => assertNoFabricatedNumbers("9 misses at 66.7% with 0 rescues and 1 issue", allowed));
  assert.throws(() => assertNoFabricatedNumbers("actually 15 misses", allowed), /not present in the deterministic summary: 15/);
});

const SUMMARY = { counts: { outcomesGraded: 9, rejected: 4 }, signalCorrectExitFailed: 3, prioritizedIssue: "exit_management" };

test("validateNightlyNarrative accepts a well-formed narrative that only cites summary numbers", () => {
  const n = validateNightlyNarrative({
    headline: "9 graded, 4 rejected",
    whatHappened: "3 setups gave back a win via exit management.",
    repeatedPatterns: ["3 exit-management leaks"],
    successPatterns: [],
    bottlenecks: ["exit management"],
    supportedConclusions: ["exit management is the leak"],
    needsMoreEvidence: ["need more days"],
    prioritizedIssue: "exit_management",
  }, SUMMARY);
  assert.equal(n.headline, "9 graded, 4 rejected");
});

test("validateNightlyNarrative REJECTS a fabricated statistic", () => {
  assert.throws(() => validateNightlyNarrative({
    headline: "win rate was 88%", whatHappened: "x", prioritizedIssue: "exit_management",
  }, SUMMARY), /not present in the deterministic summary/);
});

test("validateNightlyNarrative REJECTS a missing required field", () => {
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
