import test from "node:test";
import assert from "node:assert/strict";
import { formatPrivatePopup, formatPublicAlert, formatDiscordAlert } from "../lib/alert-format.js";
import { containsBannedPublicLanguage } from "../lib/language-modes.js";
import { buildExplanation } from "../lib/explain.js";

const ALERT = {
  ticker: "RDDT", direction: "bullish", optionSide: "call",
  setupScore: 87, riskScore: 42, liquidityScore: 81,
  catalystType: "earnings", catalystQuality: "strong",
  movePct: 7.8, relVol: 4.2, strike: 100, expiration: "2026-08-21", delta: 0.42,
  optionSymbol: "O:RDDT260821C00100000",
};

test("private popup carries full detail incl. contract area + side hint", () => {
  const p = formatPrivatePopup(ALERT);
  assert.equal(p.title, "High-Quality Alert: RDDT");
  assert.equal(p.sideHint, "Possible Call Setup");
  assert.ok(p.contractArea.includes("100C"));
  assert.equal(p.suggestedAction, "Watch / Journal");
  assert.ok(p.liquidity.includes("Good"));
});

test("public payload never leaks contract/side directives", () => {
  const p = formatPublicAlert(ALERT);
  const s = JSON.stringify(p);
  assert.equal(containsBannedPublicLanguage(s), false, s);
  assert.ok(!s.includes("Possible Call"));
  assert.ok(p.note.includes("Not financial advice"));
});

test("discord format is public-safe across bullish/bearish/put alerts", () => {
  for (const variant of [
    ALERT,
    { ...ALERT, direction: "bearish", optionSide: "put", setupScore: 91 },
    { ...ALERT, setupScore: 40, riskScore: 85 },
    { ...ALERT, publicExplanation: buildExplanation({ ...ALERT, ivPct: 95 }, "public").text },
  ]) {
    const d = formatDiscordAlert(variant);
    assert.equal(d.safe, true, d.content);
    assert.equal(containsBannedPublicLanguage(d.content), false, d.content);
    assert.ok(d.content.includes("Not financial advice"));
    assert.ok(!/possible (call|put) setup/i.test(d.content));
  }
});

test("discord formatter flags unsafe injected wording instead of passing it", () => {
  const d = formatDiscordAlert({ ...ALERT, publicExplanation: "strong buy now guaranteed" });
  assert.equal(d.safe, false);
});
