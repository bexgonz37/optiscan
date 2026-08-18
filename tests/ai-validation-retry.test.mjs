/**
 * PHASE 5 — nightly/research AI validation failures.
 *
 * Diagnosed against the production ledger (2026-08-18, 29 recorded VALIDATION_FAILED
 * diagnostic blocks): 22 anti-fabrication rejections of a PERCENTAGE, 13 schema
 * rejections of `repeatedPatterns`, 6 ratios, 3 "at most 5 findings", 2 counts.
 *
 * The decisive observation is that every rejected token appears exactly TWICE with
 * byte-identical context — once per attempt. The retry was uninformed, so it could
 * only reproduce the same answer.
 *
 * These tests pin the fixes AND pin that nothing was loosened: an unsupported number
 * still fails, an over-long findings array still fails, and a still-wrong retry still
 * fails closed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildRetryCorrection, STRUCTURED_RETRY_INSTRUCTION } from "../lib/ai/retry-correction.ts";
import { runStructuredAiJob } from "../lib/ai/provider.ts";
import { buildQuantEvidenceRegistry, assertNoFabricatedNumbers } from "../lib/ai/schemas.ts";
import { validateAnalysis, researchAnalysisPrompt } from "../lib/ai/research-analysis.ts";

const BASE = { model: "claude-haiku-4-5", system: "SYS.", user: "u", maxOutputTokens: 500, timeoutMs: 5000, maxRetries: 2 };
const KEY_ENV = { ANTHROPIC_API_KEY: "test-key" };

const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };

const reply = (payload) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({
    content: [{ type: "text", text: JSON.stringify(payload) }],
    usage: { input_tokens: 10, output_tokens: 5 },
  }),
});

// ── the retry now carries the real reason ────────────────────────────────────

test("anti-fabrication correction names the token, the context, and both legal exits", () => {
  const c = buildRetryCorrection({
    stage: "anti_fabrication",
    validatorName: "validateNightlyNarrative",
    failingField: "antiFabricationNumbers",
    expectedValue: null,
    receivedValue: null,
    message: "narrative contains an unsupported quantitative claim: 75%",
    token: "75%",
    semanticType: "percentage",
    context: "Zero-DTE strategy concentrated 75% of session trades (3 of 4)",
  });
  assert.match(c, /75%/, "must name the exact rejected token");
  assert.match(c, /percentage/);
  assert.match(c, /3 of 4/, "must quote where it appeared");
  assert.match(c, /DERIVED/i, "a percentage rejection must say arithmetic is the likely cause");
  assert.match(c, /DELETE/i);
  assert.doesNotMatch(
    c,
    /no usable structured payload/i,
    "the old generic sentence is FALSE here: the payload parsed perfectly",
  );
});

test("a correction never supplies a replacement number", () => {
  const c = buildRetryCorrection({
    stage: "anti_fabrication",
    validatorName: "v",
    failingField: "antiFabricationNumbers",
    expectedValue: null,
    receivedValue: null,
    message: "unsupported quantitative claim: 75%",
    token: "75%",
    semanticType: "percentage",
    context: "ctx",
    closestAllowedEvidence: [{ type: "percentage", value: 66.7, source: "summary.x", formatted: ["66.7", "66.7%"] }],
  });
  assert.doesNotMatch(
    c,
    /66\.7/,
    "handing the model a number to use turns the validator into a suggestion box",
  );
});

test("findings-cap correction states the hard maximum and that fewer is correct", () => {
  const c = buildRetryCorrection({
    stage: "schema",
    validatorName: "validateAnalysis",
    failingField: null,
    expectedValue: null,
    receivedValue: null,
    message: "at most 5 findings",
  });
  assert.match(c, /5/);
  assert.match(c, /DELETE|drop|Keep only/i);
  assert.match(c, /do not merge/i, "merging to fit a cap manufactures a finding");
});

test("wrong-shape correction names the field and the required shape", () => {
  const c = buildRetryCorrection({
    stage: "schema",
    validatorName: "validateNightlyNarrative",
    failingField: "repeatedPatterns",
    expectedValue: "array",
    receivedValue: "one joined string",
    message: "field 'repeatedPatterns' must be an array",
  });
  assert.match(c, /repeatedPatterns/);
  assert.match(c, /array/);
  assert.match(c, /empty array \[\] is valid/i);
});

test("an unrecognisable violation degrades to the honest generic instruction", () => {
  assert.equal(buildRetryCorrection(null), STRUCTURED_RETRY_INSTRUCTION);
  assert.equal(
    buildRetryCorrection({
      stage: "schema", validatorName: null, failingField: null,
      expectedValue: null, receivedValue: null, message: "",
    }),
    STRUCTURED_RETRY_INSTRUCTION,
    "a confident wrong diagnosis is the bug being fixed; say the true general thing instead",
  );
});

// ── the provider actually feeds it back ──────────────────────────────────────

test("the second attempt receives the first violation, not a fixed sentence", async () => {
  const systems = [];
  const fetchImpl = async (_url, init) => {
    systems.push(JSON.parse(init.body).system);
    return reply({ narrative: "spent 75% of it" });
  };
  const res = await runStructuredAiJob(
    { ...BASE, validatorName: "validateNightlyNarrative" },
    (j) => { assertNoFabricatedNumbers(j.narrative, buildQuantEvidenceRegistry({ trades: 4 })); return j; },
    { fetchImpl, env: KEY_ENV },
  );
  assert.equal(res.ok, false);
  assert.equal(systems.length, 2, "exactly one paid validation retry");
  assert.equal(systems[0], "SYS.", "the first attempt is never prefixed");
  assert.match(systems[1], /75%/, "the retry must be told which token was rejected");
  assert.doesNotMatch(systems[1], /no usable structured payload/i);
});

test("a still-invalid retry still FAILS CLOSED — nothing was loosened", async () => {
  const res = await runStructuredAiJob(
    { ...BASE, validatorName: "validateNightlyNarrative" },
    (j) => { assertNoFabricatedNumbers(j.narrative, buildQuantEvidenceRegistry({ trades: 4 })); return j; },
    { fetchImpl: async () => reply({ narrative: "spent 75% of it" }), env: KEY_ENV },
  );
  assert.equal(res.ok, false);
  assert.equal(res.errorCategory, "validation");
  assert.equal(res.data, null, "an invalid answer is never handed back");
});

test("a corrected retry succeeds — the informed retry is worth its money", async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    return reply({ narrative: n === 1 ? "we spent 75% of it" : "3 of the 4 trades were zero-DTE" });
  };
  const res = await runStructuredAiJob(
    { ...BASE, validatorName: "validateNightlyNarrative" },
    (j) => { assertNoFabricatedNumbers(j.narrative, buildQuantEvidenceRegistry({ zeroDte: 3, graded: 4 })); return j; },
    { fetchImpl, env: KEY_ENV },
  );
  assert.equal(res.ok, true);
  assert.equal(res.retries, 1);
});

// ── the evidence registry now covers what the summary actually printed ───────

test("PROVE IT — a percentage inside a deterministic KEY is supported, not fabricated", () => {
  // Verbatim from the production nightly summary. The "8%" is our own text.
  const summary = { rejectionReasons: { "daily loss cap reached (8% of equity) — no new entries": 4 } };
  const registry = buildQuantEvidenceRegistry(summary);
  assert.doesNotThrow(
    () => assertNoFabricatedNumbers("The daily loss cap (8% of equity) blocked 4 entries.", registry),
    "8 of the recorded rejections were this exact number, printed by our own code",
  );
});

test("PROVE IT — a number that appears NOWHERE still fails", () => {
  const registry = buildQuantEvidenceRegistry({
    rejectionReasons: { "daily loss cap reached (8% of equity)": 4 },
  });
  const err = throws(() => assertNoFabricatedNumbers("The cap is 12% of equity.", registry));
  assert.ok(err, "harvesting real strings must not license invented ones");
  assert.match(err.message, /12/);
});

test("PROVE IT — a DERIVED percentage still fails even when the arithmetic is right", () => {
  const registry = buildQuantEvidenceRegistry({ zeroDte: { n: 3 }, graded: 4 });
  const err = throws(() => assertNoFabricatedNumbers("Zero-DTE was 75% of session trades (3 of 4).", registry));
  assert.ok(err, "3/4 really is 75%, and 75 is still not evidence");
  assert.match(err.message, /75/);
});

test("a date inside a string never licenses its digits as a count", () => {
  const registry = buildQuantEvidenceRegistry({ note: "session 2026-08-13 closed" });
  assert.ok(
    throws(() => assertNoFabricatedNumbers("There were 2026 candidates.", registry)),
    "2026 is a year here, not a count",
  );
});

test("the compact time-bucket label is a time range, not a count of 930", () => {
  const summary = { byTimeOfDay: { open_0930_1000: { n: 1 }, morning_1000_1200: { n: 2 } } };
  const registry = buildQuantEvidenceRegistry(summary);
  assert.doesNotThrow(() => assertNoFabricatedNumbers("By time: 0930-1000 was flat.", registry));
  assert.doesNotThrow(() => assertNoFabricatedNumbers("By time: 09:30-10:00 was flat.", registry));
});

test("a time window the summary never reported is still rejected", () => {
  const registry = buildQuantEvidenceRegistry({ byTimeOfDay: { open_0930_1000: { n: 1 } } });
  assert.ok(
    throws(() => assertNoFabricatedNumbers("By time: 1200-1400 led the day.", registry)),
    "classifying compact labels as time ranges must not admit unreported windows",
  );
});

// ── the findings cap is now stated where the model reads ─────────────────────

test("PROVE IT — too many findings still FAILS", () => {
  const finding = (i) => ({
    key: `K${i}`, question: "q", title: "t", statement: "s",
    evidenceStrength: "WEAK", sampleSize: 10, limitations: ["in-sample"],
  });
  const err = throws(() => validateAnalysis({ findings: [1, 2, 3, 4, 5, 6].map(finding), openQuestions: [] }));
  assert.ok(err);
  assert.match(err.message, /at most 5 findings/);
});

test("PROVE IT — valid bounded findings PASS", () => {
  const out = validateAnalysis({
    findings: [{
      key: "OVERNIGHT_GAP_RISK",
      question: "q",
      title: "t",
      statement: "42 of 74 owner callouts crossed a session boundary.",
      evidenceStrength: "MODERATE",
      sampleSize: 74,
      limitations: ["arms are outcome-selected, not randomly assigned"],
    }],
    openQuestions: ["what would a flat close have cost"],
  });
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].sampleSize, 74);
});

test("the prompt states the cap and the arithmetic ban the schema alone could not enforce", () => {
  const { system } = researchAnalysisPrompt("2026-08-18", { a: 1 }, ["q"]);
  assert.match(system, /AT MOST 5 findings/);
  assert.match(system, /hard limit/i);
  assert.match(system, /Never compute a percentage/i);
});

test("zero rows still cannot be strong evidence", () => {
  assert.ok(throws(() => validateAnalysis({
    findings: [{
      key: "K", question: "q", title: "t", statement: "s",
      evidenceStrength: "STRONG", sampleSize: 0, limitations: ["x"],
    }],
    openQuestions: [],
  })));
});
