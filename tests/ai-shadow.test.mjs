import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { validateAiShadowOutput, postValidateAiShadowOutput, enqueueAiShadow, aiShadowMetrics } from "../lib/ai/shadow.ts";
import { shadowQueue } from "../lib/research/shadow/queue.ts";

const input = (over = {}) => ({ symbol: "ASTS", underlying: { price: 20, dollarVolume: 30_000_000 }, triggerFeatures: { velPct: 1.2 }, earnings: null, optionsActivity: { direction: "call_skew", flowClassification: "unclassified_no_trade_data", volVsBaseline: 2, hasProvenance: true }, technicalState: { rvol: 4 }, marketContext: { regime: "risk_on" }, analog: { comparableCount: 40, confidence: 0.62, dispersion: 0.4, contradiction: 0.4, abstain: false, abstainReason: null }, missing: ["iv"], scannerDecision: { actionable: true, direction: "bullish" }, paperHistory: { trades: 10, winRate: 0.5 }, ...over });
const goodOut = (over = {}) => ({ catalystClass: "momentum", setupSummary: "ASTS breaking out on rvol", evidenceFor: ["rvol 4x"], evidenceAgainst: ["extended"], contradictions: [], riskSummary: "chase risk", confidenceExplanation: "moderate", missingEvidence: ["iv"], classification: "CONFIRM", ...over });

test("schema validation accepts a well-formed output and rejects malformed ones", () => {
  assert.equal(validateAiShadowOutput(goodOut()).ok, true);
  assert.equal(validateAiShadowOutput({ ...goodOut(), classification: "BUY" }).ok, false);
  assert.equal(validateAiShadowOutput({ ...goodOut(), evidenceFor: "x" }).ok, false);
  assert.equal(validateAiShadowOutput(null).ok, false);
});

test("post-validation flags a FOREIGN ticker hallucination", () => {
  const v = postValidateAiShadowOutput(input(), goodOut({ setupSummary: "ASTS and NVDA both ripping" }));
  assert.ok(v.some((x) => /foreign ticker NVDA/.test(x)));
});

test("12. post-validation rejects an institutional-flow claim without authoritative provenance", () => {
  const noProv = input({ optionsActivity: { direction: null, flowClassification: "unclassified_no_trade_data", volVsBaseline: 1, hasProvenance: false } });
  const v = postValidateAiShadowOutput(noProv, goodOut({ evidenceFor: ["institutional sweep detected"] }));
  assert.ok(v.some((x) => /institutional/.test(x)));
});

test("enqueueAiShadow is a HARD no-op unless AI_SHADOW_ENABLED=1 AND a model caller is supplied", () => {
  assert.equal(enqueueAiShadow(input(), 1, {}, {}).enqueued, false); // flag off
  assert.match(enqueueAiShadow(input(), 1, {}, {}).reason, /AI_SHADOW_ENABLED/);
  assert.equal(enqueueAiShadow(input(), 1, {}, { AI_SHADOW_ENABLED: "1" }).enqueued, false); // no model caller
});

test("AI shadow records a validated result; a schema failure and a hallucination are counted, never actionable", async () => {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE ai_shadow (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, tag TEXT NOT NULL DEFAULT 'AI_SHADOW_ONLY', classification TEXT, catalyst_class TEXT, agrees_with_scanner INTEGER, agrees_with_analog INTEGER, abstained INTEGER NOT NULL DEFAULT 0, schema_ok INTEGER NOT NULL DEFAULT 0, hallucination INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, error TEXT, output_json TEXT, created_at_ms INTEGER NOT NULL);`);
  const ENV = { AI_SHADOW_ENABLED: "1" };
  const callGood = async () => ({ json: goodOut(), inputTokens: 100, outputTokens: 50, costUsd: 0.001 });
  const callHalluc = async () => ({ json: goodOut({ setupSummary: "ASTS with TSLA sympathy" }), inputTokens: 100, outputTokens: 50, costUsd: 0.001 });
  const callBad = async () => ({ json: { nope: 1 }, inputTokens: 10, outputTokens: 5, costUsd: 0 });
  enqueueAiShadow(input(), 10, { getDb: () => d, callModel: callGood }, ENV);
  enqueueAiShadow(input({ symbol: "IREN" }), 20, { getDb: () => d, callModel: callHalluc }, ENV);
  enqueueAiShadow(input({ symbol: "RKLB" }), 30, { getDb: () => d, callModel: callBad }, ENV);
  await shadowQueue().drain();
  const rows = d.prepare("SELECT symbol, classification, schema_ok, hallucination FROM ai_shadow ORDER BY created_at_ms").all();
  assert.equal(rows.length, 3);
  const asts = rows.find((r) => r.symbol === "ASTS");
  assert.equal(asts.classification, "CONFIRM"); assert.equal(asts.schema_ok, 1); assert.equal(asts.hallucination, 0);
  const iren = rows.find((r) => r.symbol === "IREN");
  assert.equal(iren.hallucination, 1); assert.equal(iren.classification, "ABSTAIN", "hallucination downgraded to ABSTAIN");
  const rklb = rows.find((r) => r.symbol === "RKLB");
  assert.equal(rklb.schema_ok, 0, "schema failure recorded");
  const m = aiShadowMetrics();
  assert.ok(m.hallucinations >= 1 && m.schemaFailures >= 1 && m.totalTokens > 0);
});
