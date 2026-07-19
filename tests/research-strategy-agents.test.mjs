import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StrategyRegistry, evaluateAgents } from "../lib/research/strategy-registry.ts";
import { defaultStrategyAgents, defaultRegistry } from "../lib/research/strategy-agents.ts";
import { primaryDecision } from "../lib/research/lane-policy.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const contract = { optionSymbol: "O:NVDA260710C00210000", strike: 210, expiration: "2026-07-10", dte: 0, side: "call", bid: 2.4, ask: 2.5, mid: 2.45, spreadPct: 4, delta: 0.5, iv: 0.55, volume: 1200, openInterest: 900, breakevenPct: 1.2 };
function agentResult(over = {}) {
  return {
    agentId: "call_0DTE", agentVersion: 1, strategy: "zero_dte_momentum", strategyVersion: 3,
    ticker: "nvda", direction: "bullish", horizon: "0DTE", dteRange: [0, 1],
    candidateStatus: "ACTIONABLE_NOW", lifecycleStatus: null, score: 88, verifiedInputs: {},
    requiredConditions: [], selectorProfile: "zero_dte_momentum", selectedContract: contract,
    passedGates: [], failedGates: [], evidenceStatus: "OK", statisticsSnapshot: null, modelStatus: "INACTIVE",
    probability: null, actionability: "ACTIONABLE", researchOnly: false, reasons: ["fast up move"],
    improvementConditions: [], invalidationConditions: ["loses VWAP"], freshness: { ok: true, reason: null },
    marketContext: null, riskVerdict: { allowed: true, failures: [], vetoed: false }, timestamp: 1_700_000_000_000,
    ...over,
  };
}
function ctx(agentResults) {
  return { ticker: "NVDA", nowMs: 1, tradingDay: "2026-07-10", session: "regular", freshness: { ok: true, reason: null }, marketRegime: null, agentResults, underlyingPrice: 210, features: null, missing: [] };
}

// ── active producer + attribution ────────────────────────────────────────────
test("an ACTIVE producer adapts its horizon result into a normalized candidate", () => {
  const reg = defaultRegistry();
  const call0 = reg.get("call_0DTE");
  assert.equal(call0.status(), "ACTIVE");
  const out = call0.evaluate(ctx([agentResult()]));
  assert.equal(out.length, 1);
  assert.equal(out[0].setupTier, "PRODUCTION_QUALITY");
  assert.equal(out[0].strategyAgent, "call_0DTE", "agent-id attribution persists");
  assert.equal(out[0].consumerLanes.length, 0, "router assigns lanes later — agent does not route");
  assert.ok(out[0].setupTier, "tiering is applied by the adapter — agent cannot bypass it");
});

test("a producer only emits results matching its own horizon id (no overlap/duplication)", () => {
  const reg = defaultRegistry();
  const results = [agentResult({ agentId: "call_0DTE" }), agentResult({ agentId: "call_1-5", horizon: "1-5" })];
  assert.equal(reg.get("call_0DTE").evaluate(ctx(results)).length, 1);
  assert.equal(reg.get("call_1-5").evaluate(ctx(results)).length, 1);
});

// ── registry ─────────────────────────────────────────────────────────────────
test("duplicate agent ids are rejected", () => {
  const reg = new StrategyRegistry();
  const [a] = defaultStrategyAgents();
  reg.register(a);
  assert.throws(() => reg.register(a), /duplicate strategy-agent id/);
});

test("registry ordering is deterministic (sorted by id, stable across calls)", () => {
  const reg = defaultRegistry();
  const a = reg.list().map((x) => x.id);
  const b = reg.list().map((x) => x.id);
  assert.deepEqual(a, b);
  assert.deepEqual([...a].sort(), a, "ids are in sorted order");
});

// ── inactive agents ──────────────────────────────────────────────────────────
test("INACTIVE_MISSING_DATA agents emit nothing and report exact missing requirements", () => {
  const reg = defaultRegistry();
  const news = reg.get("news_catalyst");
  assert.equal(news.status(), "INACTIVE_MISSING_DATA");
  assert.deepEqual(news.missingRequirements(), ["news_event_feed", "catalyst_scoring"]);
  assert.match(news.inactiveReason(), /missing required data/);
  // Even with rich context present, an inactive agent fabricates nothing.
  assert.deepEqual(news.evaluate(ctx([agentResult()])), []);
});

test("every INACTIVE_MISSING_DATA agent lists at least one exact missing field", () => {
  for (const a of defaultStrategyAgents()) {
    if (a.status() === "INACTIVE_MISSING_DATA") {
      assert.ok(a.missingRequirements().length > 0, `${a.id} must list its missing requirements`);
      assert.deepEqual(a.evaluate(ctx([agentResult()])), [], `${a.id} must emit nothing`);
    }
  }
});

test("an agent can be explicitly INACTIVE_DISABLED via env", () => {
  const reg = defaultRegistry();
  const iv = reg.get("volatility_iv_context");
  assert.equal(iv.status({}), "ACTIVE");
  assert.equal(iv.status({ STRATEGY_AGENT_IV_CONTEXT_DISABLED: "1" }), "INACTIVE_DISABLED");
});

// ── control-agent roles ──────────────────────────────────────────────────────
test("Risk Agent + Data Quality Agent are review-role and emit NO candidates", () => {
  const reg = defaultRegistry();
  for (const id of ["risk_agent", "data_quality"]) {
    const a = reg.get(id);
    assert.equal(a.role, "review");
    assert.deepEqual(a.evaluate(ctx([agentResult()])), [], `${id} may not produce candidates`);
  }
});

// ── puts remain research-only ────────────────────────────────────────────────
test("Puts Research Agent stays research-only (never PRODUCTION_QUALITY / never Primary)", () => {
  const reg = defaultRegistry();
  const put = reg.get("put_research_0DTE");
  const r = agentResult({ agentId: "put_research_0DTE", direction: "bearish", actionability: "RESEARCH_ONLY", candidateStatus: "RESEARCH_ONLY", selectedContract: { ...contract, side: "put" } });
  const [c] = put.evaluate(ctx([r]));
  assert.notEqual(c.setupTier, "PRODUCTION_QUALITY", "bearish-gate keeps puts below production quality");
  assert.equal(primaryDecision(c).routed, false, "puts never route to Primary");
});

// ── failure isolation + flag gating ──────────────────────────────────────────
test("one agent exception does not stop the others (failure isolation)", () => {
  const reg = new StrategyRegistry();
  const thrower = { id: "boom", name: "Boom", version: 1, strategyFamily: "x", assetClass: "option", role: "producer",
    supportedDirections: ["bullish"], supportedHorizons: ["0DTE"], requiredFeatures: [], requiredProviderData: [],
    status: () => "ACTIVE", inactiveReason: () => null, missingRequirements: () => [],
    evaluate: () => { throw new Error("kaboom"); }, diagnostics: () => ({}) };
  reg.register(thrower);
  reg.registerAll(defaultStrategyAgents().filter((a) => a.id === "call_0DTE"));
  const res = evaluateAgents(reg, ctx([agentResult()]), { STRATEGY_AGENTS_V2_ENABLED: "1" });
  assert.equal(res.ran, true);
  assert.equal(res.candidates.length, 1, "call_0DTE still emitted despite boom throwing");
  assert.ok(res.perAgent.find((p) => p.agentId === "boom" && p.status === "ERROR"), "the failure is recorded, not silent");
});

test("SAFETY: the framework is a HARD no-op when STRATEGY_AGENTS_V2_ENABLED is off", () => {
  const reg = defaultRegistry();
  const res = evaluateAgents(reg, ctx([agentResult()]), {});
  assert.equal(res.ran, false);
  assert.equal(res.candidates.length, 0);
  assert.match(res.skippedReason, /STRATEGY_AGENTS_V2_ENABLED/);
});

// ── structural safety: agents cannot send Discord / create trades / route ─────
test("agent modules import/call NO Discord/trade/router execution surface", () => {
  // Check real imports and call-sites, not prose in comments (which explain the ban).
  for (const p of ["lib/research/strategy-agents.ts", "lib/research/strategy-registry.ts", "lib/research/strategy-agent.ts"]) {
    const src = read(p);
    assert.doesNotMatch(src, /from ["'][^"']*notifications|deliverCalloutDiscord\(/, `${p} must not touch Discord`);
    assert.doesNotMatch(src, /from ["'][^"']*paper-engine|createLanePaperTrade\(|createPaperTrade\(/, `${p} must not create trades`);
    assert.doesNotMatch(src, /from ["'][^"']*research\/router|from ["'][^"']*research-consumer|routeAgentResults\(/, `${p} must not route or consume`);
  }
});

test("existing production cycle does NOT import the v2 framework (ships inactive/unwired)", () => {
  const src = read("lib/callouts/runtime.ts");
  assert.doesNotMatch(src, /strategy-registry|strategy-agents\b/, "framework is not wired into the production cycle");
});

test("capability report separates ACTIVE from INACTIVE with reasons", () => {
  const reg = defaultRegistry();
  const rep = reg.capabilityReport();
  const active = rep.filter((r) => r.status === "ACTIVE");
  const inactive = rep.filter((r) => r.status.startsWith("INACTIVE"));
  assert.ok(active.length >= 10, "the options horizon + context/review agents are active");
  assert.ok(inactive.length >= 10, "data-less agents are honestly inactive");
  for (const r of inactive) assert.ok(r.inactiveReason, `${r.id} must explain why it is inactive`);
});
