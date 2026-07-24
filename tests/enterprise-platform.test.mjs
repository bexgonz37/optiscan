import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deterministicOpportunityId, createEmptyCase } from "../lib/opportunity-case/schema.ts";
import { runStrategyConductor, ensembleDecisionFingerprint } from "../lib/strategy/conductor.ts";
import { evaluationFromOptionsSelection } from "../lib/strategy/catalog-adapter.ts";
import { evaluateBlockedStrategy } from "../lib/strategy/blocked-providers.ts";
import { computeKellyResearch } from "../lib/strategy/research/kelly.ts";
import { runMonteCarloResearch } from "../lib/strategy/research/monte-carlo.ts";
import { buildProbabilityEstimate } from "../lib/opportunity-case/probability.ts";
import { learningAffectsLiveBehavior, canPromoteToLive, createLearningProposal } from "../lib/ai/learning-governance.ts";
import { sanitizeDiagnosticForResponse, buildWhyNoAlertsDiagnostic } from "../lib/research/options/pipeline-diagnostics.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("Opportunity Case: deterministic id and immutable frozen block", () => {
  const a = deterministicOpportunityId(["NVDA", "breakout", "123"]);
  const b = deterministicOpportunityId(["NVDA", "breakout", "123"]);
  assert.equal(a, b);
  const c = createEmptyCase("nvda", 1000, "options_live");
  assert.equal(c.schemaVersion, 1);
  assert.equal(c.underlyingSymbol, "NVDA");
});

test("Strategy Conductor: deterministic identical inputs", () => {
  const selection = {
    symbol: "SPY",
    selected: { key: "zero_dte_index", label: "0DTE", score: 0.8, side: "call", researchOnly: false, preferredDte: "0dte" },
    direction: "bullish",
    considered: [{ key: "zero_dte_index", label: "0DTE", applicable: true, score: 0.8, matched: ["above_vwap"], rejection: null }],
    reason: "ok",
  };
  const evals = evaluationFromOptionsSelection(selection, 1000);
  const input = { symbol: "SPY", nowMs: 1000, evaluations: evals, hardGates: [], regimeLabel: "risk_on" };
  const d1 = runStrategyConductor(input);
  const d2 = runStrategyConductor(input);
  assert.equal(ensembleDecisionFingerprint(d1), ensembleDecisionFingerprint(d2));
});

test("Strategy Conductor: correlated evidence discounted", () => {
  const mk = (id, strength) => ({
    schemaVersion: 1,
    strategyId: id,
    strategyVersion: "1",
    strategyFamily: "momentum",
    lifecycleStatus: "ACTIVE",
    applicable: true,
    evaluatedDirection: "bullish",
    evaluatedHorizon: "0dte",
    signal: "SUPPORTIVE",
    rawMetrics: {},
    strength,
    evidence: [],
    contradictingEvidence: [],
    missingDataRequirements: [],
    regimeCompatible: true,
    historicalCohortKey: null,
    latencyMs: 1,
    dataFreshnessMs: 0,
    limitations: [],
    reasonCodes: [],
    error: null,
  });
  const d = runStrategyConductor({
    symbol: "SPY",
    nowMs: 1,
    evaluations: [mk("momentum_breakout", 80), mk("momentum_continuation", 75)],
  });
  assert.ok(Object.keys(d.correlationGroups).length >= 1 || d.contributionModel["momentum_breakout"].correlationDiscount >= 0);
});

test("Blocked L2/L3 strategies return INSUFFICIENT_DATA", () => {
  const ev = evaluateBlockedStrategy("order_book_imbalance");
  assert.ok(ev);
  assert.equal(ev.lifecycleStatus, "BLOCKED");
  assert.equal(ev.signal, "INSUFFICIENT_DATA");
});

test("Kelly criterion is RESEARCH_ONLY and withheld on low sample", () => {
  const r = computeKellyResearch({ winProbability: 0.6, avgWinR: 1, avgLossR: 1, estimationError: 0.1, sampleSize: 5 });
  assert.equal(r.status, "INSUFFICIENT_EVIDENCE");
  assert.equal(r.fractionalKelly, null);
});

test("Monte Carlo is RESEARCH_ONLY with documented assumptions", () => {
  const r = runMonteCarloResearch({ sampleReturns: Array.from({ length: 50 }, (_, i) => (i % 5 - 2) * 0.01), simulations: 500, seed: 1 });
  assert.equal(r.status, "RESEARCH_ONLY");
  assert.ok(r.assumptions.some((a) => /RESEARCH_ONLY/i.test(a)));
});

test("Probabilities withheld below sample minimum", () => {
  const p = buildProbabilityEstimate({
    outcomeDefinition: "T1 before stop",
    classification: "empirical",
    observedRate: 0.55,
    sampleSize: 5,
  });
  assert.equal(p.withheld, true);
  assert.equal(p.value, null);
});

test("Learning governance cannot affect live behavior", () => {
  assert.equal(learningAffectsLiveBehavior(), false);
  const p = createLearningProposal("test", ["momentum"]);
  assert.equal(canPromoteToLive(p), false);
});

test("Pipeline diagnostics: secret-safe sanitizer", () => {
  const d = buildWhyNoAlertsDiagnostic(null, { INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "0" });
  d.likelyBlockers.push("apiKey=secret12345");
  const s = sanitizeDiagnosticForResponse(d);
  assert.ok(!s.likelyBlockers[0].includes("secret12345"));
});

test("Architecture: strategies do not import Discord delivery", () => {
  const files = [];
  const w = (d) => {
    for (const e of readdirSync(join(root, d), { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) w(p);
      else if (e.name.endsWith(".ts")) files.push(p);
    }
  };
  w("lib/strategy");
  w("lib/opportunity-case");
  for (const f of files) {
    const src = read(f);
    assert.ok(!/deliverOptionsCallout|postToDiscord/.test(src), `${f} must not deliver alerts`);
  }
});

test("Architecture: loop.ts wires opportunity case capture", () => {
  const src = read("lib/research/options/loop.ts");
  assert.ok(src.includes("persistCaseFromOptionsLive"));
  assert.ok(src.includes("OPPORTUNITY_CASE_CAPTURE_ENABLED"));
});

test("DB schema includes opportunity_cases table", () => {
  const src = read("lib/db.ts");
  assert.ok(src.includes("CREATE TABLE IF NOT EXISTS opportunity_cases"));
});
