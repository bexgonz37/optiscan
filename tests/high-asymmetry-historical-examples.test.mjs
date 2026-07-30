/**
 * tests/high-asymmetry-historical-examples.test.mjs — the import contract.
 *
 * The single property that matters: a screenshot, post, or article can supply
 * PROVENANCE and never PRICE. This is enforced structurally — the reference
 * type has no numeric price field at all — and asserted here at runtime.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { acceptHistoricalExample, intakeHistoricalExamples } from "../lib/research/asymmetry/historical-examples.ts";
import { buildAsymmetryResearchReport } from "../lib/research/asymmetry/report.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const T = Date.parse("2026-07-30T14:00:00Z");
const OCC = "AAPL260731C00150000";

const quote = (atMs, bid, ask) => ({
  occSymbol: OCC, atMs, bid, ask, quoteTimestampMs: atMs - 2_000, source: "provider:historical-chain",
});

const submission = (over = {}) => ({
  exampleId: "ex-1",
  symbol: "AAPL",
  sessionDate: "2026-07-30",
  occSymbol: OCC,
  strike: 150,
  optionType: "call",
  expiration: "2026-07-31",
  candidateAtMs: T,
  direction: "bullish",
  references: [{ kind: "SCREENSHOT", uri: "file://gain.png", claimedNote: "this ran +800% that morning" }],
  quoteEvidence: [quote(T, 1.00, 1.10)],
  quoteEvidenceSource: "provider:historical-chain",
  markEvidence: [quote(T + 5 * 60_000, 3.00, 3.10)],
  ...over,
});

test("a screenshot alone is a lead, never a graded outcome", () => {
  const out = acceptHistoricalExample(submission({ quoteEvidence: [], quoteEvidenceSource: null, markEvidence: [] }));
  assert.equal(out.status, "PENDING_QUOTE_EVIDENCE");
  assert.equal(out.candidateInput, null);
  assert.equal(out.referencesUsedAsPriceEvidence, false);
  assert.equal(out.referenceCount, 1);
  assert.match(out.reasons.join(" "), /never price evidence/i);
});

test("a claimed return in a note is never read or reported", () => {
  const out = acceptHistoricalExample(submission({
    references: [{ kind: "SOCIAL_POST", claimedNote: "+800% in 20 minutes, 1200% peak" }],
  }));
  // The example IS gradeable from its independent quotes — and the grade comes
  // only from those, nowhere near the claimed numbers in the note.
  assert.equal(out.status, "ACCEPTED_FOR_REPLAY");
  const report = buildAsymmetryResearchReport([out.candidateInput], { evaluationAtMs: T + 60 * 60_000 });
  assert.equal(report.candidates[0].label, "OUTSIZED_100", "entry ask 1.10 → bid 3.00 is +172%, not +800%");
  assert.equal(report.candidates[0].outcome.mfePct, 172.7273);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("+800%"), false, "the claimed note must not reach the report");
  assert.equal(serialized.includes("in 20 minutes"), false);
  for (const claimed of [800, 1200]) {
    assert.notEqual(report.candidates[0].outcome.mfePct, claimed);
    assert.notEqual(report.candidates[0].outcome.finalVerifiedReturnPct, claimed);
  }
});

test("the reference type carries no price field at all", () => {
  const source = readFileSync(join(HERE, "..", "lib", "research", "asymmetry", "historical-examples.ts"), "utf8");
  const block = source.slice(
    source.indexOf("export interface HistoricalExampleReference"),
    source.indexOf("export interface HistoricalExampleSubmission"),
  );
  assert.ok(block.length > 0, "the reference interface must exist to be checked");
  for (const forbidden of [/\bbid\b/, /\bask\b/, /\bprice\b/i, /\breturn\w*\s*[?:]/i, /\bpct\b/i, /\bgain\b/i]) {
    assert.equal(forbidden.test(block), false,
      `HistoricalExampleReference must not declare ${forbidden} — a reference can never carry a price`);
  }
});

test("an example without exact OCC is retained as a lead", () => {
  const out = acceptHistoricalExample(submission({ occSymbol: null }));
  assert.equal(out.status, "PENDING_EXACT_OCC");
  assert.equal(out.candidateInput, null);
  assert.match(out.reasons.join(" "), /lead only/i);
});

test("an OCC that disagrees with the supplied terms is refused", () => {
  const out = acceptHistoricalExample(submission({ strike: 155 }));
  assert.equal(out.status, "PENDING_EXACT_OCC");
  assert.match(out.reasons.join(" "), /disagrees with the supplied contract terms/i);
});

test("quote evidence without a named source is not accepted", () => {
  const out = acceptHistoricalExample(submission({ quoteEvidenceSource: "  " }));
  assert.equal(out.status, "PENDING_QUOTE_EVIDENCE");
  assert.equal(out.candidateInput, null);
});

test("quote evidence for the wrong contract cannot supply the entry", () => {
  const out = acceptHistoricalExample(submission({
    quoteEvidence: [{ ...quote(T, 1.00, 1.10), occSymbol: "AAPL260731P00150000" }],
  }));
  assert.equal(out.status, "PENDING_QUOTE_EVIDENCE");
  assert.match(out.reasons.join(" "), /no exact-OCC observation at the candidate timestamp/i);
});

test("an accepted example is graded by the standard engine with no relaxed rule", () => {
  const out = acceptHistoricalExample(submission());
  assert.equal(out.status, "ACCEPTED_FOR_REPLAY");
  assert.equal(out.occSymbol, OCC);

  // A stale mark is refused here exactly as it would be for a persisted row.
  const stale = acceptHistoricalExample(submission({
    markEvidence: [{ ...quote(T + 5 * 60_000, 9.00, 9.10), quoteTimestampMs: T + 5 * 60_000 - 20 * 60_000 }],
  }));
  const report = buildAsymmetryResearchReport([stale.candidateInput], { evaluationAtMs: T + 60 * 60_000 });
  assert.equal(report.candidates[0].label, "INSUFFICIENT_EVIDENCE");
  assert.ok(report.candidates[0].outcome.rejectedMarks.some((r) => r.reason === "QUOTE_STALE"));
});

test("a missing candidate timestamp blocks acceptance", () => {
  const out = acceptHistoricalExample(submission({ candidateAtMs: null }));
  assert.equal(out.status, "PENDING_CANDIDATE_TIMESTAMP");
  assert.equal(out.candidateInput, null);
});

test("malformed submissions are rejected rather than guessed at", () => {
  for (const bad of [{ exampleId: "" }, { symbol: "" }, { sessionDate: "yesterday" }]) {
    const out = acceptHistoricalExample(submission(bad));
    assert.equal(out.status, "REJECTED_UNVERIFIABLE");
    assert.equal(out.candidateInput, null);
  }
});

test("intake summarizes every status and exposes only accepted candidates", () => {
  const intake = intakeHistoricalExamples([
    submission({ exampleId: "a" }),
    submission({ exampleId: "b", occSymbol: null }),
    submission({ exampleId: "c", quoteEvidence: [], quoteEvidenceSource: null }),
  ]);
  assert.equal(intake.submitted, 3);
  assert.equal(intake.accepted, 1);
  assert.equal(intake.pending, 2);
  assert.equal(intake.rejected, 0);
  assert.equal(intake.candidateInputs.length, 1, "only accepted examples become gradeable inputs");
  assert.equal(intake.byStatus.PENDING_EXACT_OCC, 1);
  assert.equal(intake.byStatus.PENDING_QUOTE_EVIDENCE, 1);
  assert.equal(intake.advisoryOnly, true);
  assert.equal(intake.productionBehaviorChanged, false);
  assert.ok(intake.notes.some((n) => /never read, parsed, or reported/i.test(n)));
});

test("intake writes nothing and is a pure function of its input", () => {
  const submissions = [submission({ exampleId: "a" })];
  const snapshot = structuredClone(submissions);
  const first = intakeHistoricalExamples(submissions);
  const second = intakeHistoricalExamples(submissions);
  assert.deepEqual(submissions, snapshot, "submissions must not be mutated");
  assert.deepEqual(first, second);
});
