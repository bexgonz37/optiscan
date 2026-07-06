import test from "node:test";
import assert from "node:assert/strict";
import { buildExplanation } from "../lib/explain.js";
import { containsBannedPublicLanguage } from "../lib/language-modes.js";

const INPUT = {
  ticker: "SPY", direction: "bullish", movePct: 1.8, shortRate: 0.35, relVol: 3.1, surge: 1.7,
  vwapAligned: true, levelBreak: true, efficiency: 0.68, moveStatus: "continuing",
  worthItVerdict: "Continuation Setup", zeroDteScore: 84,
  liquidityScore: 88, riskScore: 32, setupScore: 91,
  spreadPct: 2, ivPct: 95, minsToClose: 210, riskFlags: ["Theta Risk High"],
  catalystType: "no_clear_catalyst", catalystQuality: "unknown",
};

test("private explanation: six sections, real values, VWAP/HOD language", () => {
  const { sections, text } = buildExplanation(INPUT, "private");
  assert.ok(sections.whyTriggered.includes("SPY"));
  assert.ok(sections.whyTriggered.includes("high of day"));
  assert.ok(sections.whyTriggered.includes("VWAP"));
  assert.ok(sections.confirm.some((c) => c.includes("call spreads staying tight")));
  assert.ok(sections.invalidate.some((c) => c.includes("losing VWAP") || c.includes("Losing VWAP")));
  assert.equal(sections.moveStatus, "Continuation Setup");
  for (const part of ["Why it triggered", "Move status", "Supports", "Risks", "Liquidity", "Would confirm", "Would invalidate"]) {
    assert.ok(text.includes(part), `missing: ${part}`);
  }
});

test("SPEC: no news is neutral context, never a listed risk", () => {
  const { sections } = buildExplanation(INPUT, "private");
  assert.ok(sections.catalystContext.includes("not a penalty"));
  assert.ok(!sections.risks.some((r) => r.toLowerCase().includes("catalyst")), JSON.stringify(sections.risks));
  assert.ok(!sections.risks.some((r) => r.toLowerCase().includes("no news")));
});

test("SPEC: a big move that is continuing is supported, not warned about", () => {
  const big = buildExplanation({ ...INPUT, movePct: 16.2 }, "private");
  assert.ok(big.sections.supports.some((s) => s.includes("Continuation")));
  assert.ok(!big.sections.risks.some((r) => r.includes("16.2")));
  // but the same size EXHAUSTED move is warned about:
  const dead = buildExplanation({ ...INPUT, movePct: 16.2, moveStatus: "exhausted", vwapAligned: false }, "private");
  assert.ok(dead.sections.risks.some((r) => r.includes("rolled over")));
});

test("bearish read flips levels and spread language", () => {
  const { sections } = buildExplanation({ ...INPUT, direction: "bearish", movePct: -2.4, shortRate: -0.4 }, "private");
  assert.ok(sections.whyTriggered.includes("low of day"));
  assert.ok(sections.confirm.some((c) => c.includes("put spreads")));
  assert.ok(sections.invalidate.some((c) => c.includes("reclaiming VWAP")));
});

test("public explanation is education-safe for all directions", () => {
  for (const dir of ["bullish", "bearish", "choppy"]) {
    const { text } = buildExplanation({ ...INPUT, direction: dir }, "public");
    assert.equal(containsBannedPublicLanguage(text), false, text);
    assert.ok(text.includes("Not financial advice"));
    assert.ok(!/call|put/i.test(text), `public text leaks side: ${text}`);
  }
});
