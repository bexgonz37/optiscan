import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTradeExplanation,
  actionabilityFrom,
  evidenceFrom,
  rejectionToPlain,
  advancedMetricsLine,
} from "../lib/trade-explanation.ts";

/** A successful zero_dte selection for a tradable call. */
const okCallSelection = (over = {}) => ({
  ok: true,
  profile: "zero_dte_momentum",
  contract: {
    optionSymbol: "O:NVDA_C130", side: "call", strike: 130, expiration: "2026-07-11", dte: 0,
    bid: 1.18, ask: 1.22, mid: 1.2, spreadPct: 3, delta: 0.45, iv: 0.42, openInterest: 4500, volume: 1240,
  },
  score: 78,
  reasons: ["usable delta", "tight spread"],
  actionable: true,
  researchOnly: false,
  notes: [],
  marketData: {
    spot: 130, mid: 1.2, spreadPct: 3, delta: 0.45, openInterest: 4500, volume: 1240, iv: 0.42,
    breakevenPct: 0.92, distFromSpotPct: 0, chainAsOfMs: 1, contractAsOfMs: 1,
  },
  ...over,
});

const rejection = (code, blockedByGate = {}) => ({
  ok: false, profile: "zero_dte_momentum", rejectionCode: code,
  reason: `No safe/tradable contract: blocked by ${code}.`, evaluated: 3, blockedByGate,
});

function callSource(over = {}) {
  return {
    ticker: "NVDA",
    direction: "bullish",
    side: "call",
    selection: okCallSelection(),
    movePct: 1.4,
    relVol: 2.1,
    vwapRelationship: "above VWAP",
    riskScore: 40,
    riskLabel: "Medium Risk",
    midpointLabel: "Estimated midpoint",
    contract: okCallSelection().contract,
    ...over,
  };
}

// ── happy path ───────────────────────────────────────────────────────────────

test("successful call selection → ACTIONABLE with a contract and selectedBecause", () => {
  const exp = buildTradeExplanation(callSource());
  assert.equal(exp.actionabilityStatus, "ACTIONABLE");
  assert.equal(exp.side, "call");
  assert.equal(exp.plainSummary, "NVDA CALL — ACTIONABLE");
  assert.ok(exp.contractSummary.includes("NVDA $130 Call"));
  assert.ok(exp.contractSummary.includes("Estimated midpoint $1.20"));
  assert.ok(exp.selectedBecause && exp.selectedBecause.includes("spread and liquidity"));
  assert.equal(exp.rejectedBecause, null);
  assert.ok(exp.whyNow.includes("NVDA is moving +1.4%"));
});

// ── rejections ───────────────────────────────────────────────────────────────

test("wide spread rejection → NO_VALID_CONTRACT with rejectedBecause + wouldImproveIf", () => {
  const exp = buildTradeExplanation(callSource({ selection: rejection("SPREAD_TOO_WIDE", { spread: 3 }), contract: null }));
  assert.equal(exp.actionabilityStatus, "NO_VALID_CONTRACT");
  assert.equal(exp.contractSummary, null);
  assert.ok(exp.rejectedBecause.includes("spread"));
  assert.ok(exp.wouldImproveIf.includes("spread"));
  assert.deepEqual(exp.advanced.failedGates, ["spread"]);
  assert.equal(exp.advanced.rejection.code, "SPREAD_TOO_WIDE");
});

test("low liquidity rejection maps to a liquidity improvement", () => {
  const exp = buildTradeExplanation(callSource({ selection: rejection("NO_LIQUID_CONTRACT", { open_interest: 2 }), contract: null }));
  assert.equal(exp.actionabilityStatus, "NO_VALID_CONTRACT");
  assert.ok(exp.rejectedBecause.includes("liquidity"));
  assert.ok(exp.wouldImproveIf.includes("open interest"));
});

test("stale chain / stale contract rejections → BLOCKED (data problem, not NVC)", () => {
  for (const code of ["CHAIN_STALE", "STALE_CONTRACT", "CHAIN_UNAVAILABLE"]) {
    const exp = buildTradeExplanation(callSource({ selection: rejection(code), contract: null }));
    assert.equal(exp.actionabilityStatus, "BLOCKED", `${code} should block`);
  }
});

// ── freshness / session ─────────────────────────────────────────────────────

test("freshness-blocked symbol → BLOCKED and carries the reason as a note", () => {
  const exp = buildTradeExplanation(callSource({
    freshnessBlocked: true,
    freshnessReason: "NVDA options quote is 200 seconds old.",
  }));
  assert.equal(exp.actionabilityStatus, "BLOCKED");
  assert.ok(exp.notes.some((n) => n.includes("200 seconds old")));
});

test("session-not-actionable selection note surfaces as RESEARCH_ONLY", () => {
  const sel = okCallSelection({ actionable: false, researchOnly: true, notes: ["Not actionable in the afterhours session."] });
  const exp = buildTradeExplanation(callSource({ selection: sel }));
  assert.equal(exp.actionabilityStatus, "RESEARCH_ONLY");
  assert.ok(exp.notes.some((n) => n.includes("afterhours")));
});

// ── bearish safety ──────────────────────────────────────────────────────────

test("a PUT is NEVER actionable even if a selection claims actionable=true", () => {
  const putSel = {
    ...okCallSelection({ actionable: true, researchOnly: false }),
    contract: { ...okCallSelection().contract, side: "put", optionSymbol: "O:NVDA_P130", delta: -0.45 },
  };
  const exp = buildTradeExplanation({
    ticker: "NVDA", direction: "bearish", side: "put", selection: putSel,
    contract: putSel.contract,
  });
  assert.equal(exp.actionabilityStatus, "RESEARCH_ONLY");
  assert.notEqual(exp.actionabilityStatus, "ACTIONABLE");
  assert.ok(exp.notes.some((n) => n.toLowerCase().includes("research-only")));
});

test("actionabilityFrom guards put/bearish directly", () => {
  assert.equal(actionabilityFrom({ ticker: "X", side: "put", selection: null }), "RESEARCH_ONLY");
  assert.equal(actionabilityFrom({ ticker: "X", direction: "bearish" }), "RESEARCH_ONLY");
});

// ── missing optional data → no fabrication ──────────────────────────────────

test("missing optional data yields nulls, never invented values", () => {
  const exp = buildTradeExplanation({ ticker: "SPY", direction: "bullish", side: "call" });
  assert.equal(exp.contractSummary, null);
  assert.equal(exp.whyNow, null);
  assert.equal(exp.selectedBecause, null);
  assert.equal(exp.advanced.mid, null);
  assert.equal(exp.advanced.delta, null);
  assert.deepEqual(exp.supportingMetrics, []);
  assert.equal(exp.evidenceStatus, "NOT_TRACKED");
});

// ── invalidated lifecycle ───────────────────────────────────────────────────

test("INVALIDATED lifecycle wins over everything", () => {
  const exp = buildTradeExplanation(callSource({ lifecycleStatus: "INVALIDATED" }));
  assert.equal(exp.actionabilityStatus, "INVALIDATED");
});

// ── evidence gating ─────────────────────────────────────────────────────────

test("no history → NOT_TRACKED, no numeric evidence shown", () => {
  const exp = buildTradeExplanation(callSource({ evidence: { dataQuality: "empty" } }));
  assert.equal(exp.evidenceStatus, "NOT_TRACKED");
  assert.ok(!exp.supportingMetrics.some((m) => m.key === "winRate"));
});

test("insufficient history → INSUFFICIENT_HISTORY, still no numeric proof", () => {
  const exp = buildTradeExplanation(callSource({ evidence: { dataQuality: "limited", sampleSize: 4, winRate: 90, expectancy: 12 } }));
  assert.equal(exp.evidenceStatus, "INSUFFICIENT_HISTORY");
  assert.ok(!exp.supportingMetrics.some((m) => m.key === "winRate"));
  assert.ok(!exp.supportingMetrics.some((m) => m.key === "expectancy"));
});

test("only ESTABLISHED evidence surfaces the numeric win rate", () => {
  const exp = buildTradeExplanation(callSource({ evidence: { dataQuality: "strong", sampleSize: 60, winRate: 58, expectancy: 3.2 } }));
  assert.equal(exp.evidenceStatus, "ESTABLISHED_EVIDENCE");
  assert.ok(exp.supportingMetrics.some((m) => m.key === "winRate" && m.value === "58%"));
});

test("evidenceFrom maps every dataQuality value", () => {
  assert.equal(evidenceFrom(null).evidenceStatus, "NOT_TRACKED");
  assert.equal(evidenceFrom({ dataQuality: "empty" }).evidenceStatus, "NOT_TRACKED");
  assert.equal(evidenceFrom({ dataQuality: "limited" }).evidenceStatus, "INSUFFICIENT_HISTORY");
  assert.equal(evidenceFrom({ dataQuality: "developing" }).evidenceStatus, "EARLY_EVIDENCE");
  assert.equal(evidenceFrom({ dataQuality: "strong" }).evidenceStatus, "ESTABLISHED_EVIDENCE");
});

// ── determinism + view sharing ──────────────────────────────────────────────

test("determinism: identical input → deep-equal output", () => {
  const a = buildTradeExplanation(callSource());
  const b = buildTradeExplanation(callSource());
  assert.deepEqual(a, b);
});

test("Simple and Advanced read ONE object: advanced fields are additive, core is shared", () => {
  const exp = buildTradeExplanation(callSource());
  // Simple view uses core fields; Advanced view uses the same object's `advanced`.
  assert.equal(exp.advanced.delta, 0.45);
  assert.equal(exp.advanced.spreadPct, 3);
  // The plain summary/contract/risk the Simple view shows come from the same object.
  assert.ok(exp.plainSummary && exp.contractSummary && exp.riskSummary);
});

// ── deterministic language guards (no banned wording) ───────────────────────

test("no fabricated/directive wording in generated fields", () => {
  const exp = buildTradeExplanation(callSource());
  const blob = JSON.stringify(exp).toLowerCase();
  for (const bad of ["guaranteed", "easy money", "safe trade", "high-confidence winner", "will definitely"]) {
    assert.ok(!blob.includes(bad), `must not contain "${bad}"`);
  }
});

// ── advanced one-liner ──────────────────────────────────────────────────────

test("advancedMetricsLine renders a compact deterministic line", () => {
  const line = advancedMetricsLine(buildTradeExplanation(callSource()));
  assert.ok(line.includes("Delta 0.45"));
  assert.ok(line.includes("Spread 3.0%"));
  assert.ok(line.includes("IV 42%"));
  assert.ok(line.includes("Volume 1,240"));
  assert.ok(line.includes("OI 4,500"));
});

test("rejectionToPlain covers every code without throwing", () => {
  const codes = [
    "CHAIN_UNAVAILABLE", "CHAIN_STALE", "NO_CONTRACTS", "NO_SIDE_CONTRACTS", "NO_MID_QUOTE",
    "SPREAD_TOO_WIDE", "NO_LIQUID_CONTRACT", "NO_DELTA_ZONE", "DTE_OUT_OF_WINDOW",
    "BREAKEVEN_UNREACHABLE", "STALE_CONTRACT", "SESSION_NOT_ACTIONABLE",
  ];
  for (const c of codes) {
    const r = rejectionToPlain(c, "call");
    assert.ok(r.rejectedBecause.length > 0 && r.wouldImproveIf.length > 0, c);
  }
});
