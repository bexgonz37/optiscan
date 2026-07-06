import test from "node:test";
import assert from "node:assert/strict";
import { buildExplanation } from "../lib/explain.js";
import { containsBannedPublicLanguage } from "../lib/language-modes.js";

const INPUT = {
  ticker: "RDDT", direction: "bullish", movePct: 7.8, relVol: 4.2,
  catalystType: "earnings", catalystQuality: "strong", catalystSummary: "RDDT beats estimates",
  liquidityScore: 81, riskScore: 42, setupScore: 87,
  spreadPct: 6, openInterest: 4200, ivPct: 92, hasUnusualFlow: true, trendAligned: true,
  optionSide: "call",
};

test("private explanation has all six sections and cites real values", () => {
  const { sections, text } = buildExplanation(INPUT, "private");
  assert.ok(sections.whyTriggered.includes("RDDT"));
  assert.ok(sections.whyTriggered.includes("+7.8%"));
  assert.ok(sections.supports.length >= 2);
  assert.ok(sections.risks.length >= 1);
  assert.ok(sections.liquidityRead.includes("81/100"));
  assert.ok(sections.confirm.length >= 3);
  assert.ok(sections.invalidate.length >= 3);
  for (const part of ["Why it triggered", "Supports", "Risks", "Liquidity", "Would confirm", "Would invalidate"]) {
    assert.ok(text.includes(part), `missing section: ${part}`);
  }
});

test("bearish setups flip confirm/invalidate around VWAP", () => {
  const { sections } = buildExplanation({ ...INPUT, direction: "bearish", movePct: -6.2 }, "private");
  assert.ok(sections.confirm[0].includes("below VWAP"));
  assert.ok(sections.invalidate[0].includes("reclaim"));
});

test("no-catalyst extended movers get honest risk wording", () => {
  const { sections } = buildExplanation(
    { ...INPUT, movePct: 12.5, catalystType: "no_clear_catalyst", catalystQuality: "unknown", liquidityScore: 25 },
    "private",
  );
  assert.ok(sections.whyTriggered.includes("unexplained"));
  assert.ok(sections.risks.some((r) => r.includes("extended")));
  assert.ok(sections.liquidityRead.toLowerCase().includes("poor"));
});

test("public explanation is education-safe for bullish AND bearish", () => {
  for (const dir of ["bullish", "bearish"]) {
    const { text } = buildExplanation({ ...INPUT, direction: dir }, "public");
    assert.equal(containsBannedPublicLanguage(text), false, text);
    assert.ok(text.includes("Not financial advice"));
  }
});
