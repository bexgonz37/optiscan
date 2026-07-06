import test from "node:test";
import assert from "node:assert/strict";
import {
  privateLabel,
  privateSideHint,
  publicLabel,
  riskLabel,
  suggestedAction,
  directionLabel,
  containsBannedPublicLanguage,
} from "../lib/language-modes.js";

test("banned-language checker catches every unsafe phrase", () => {
  const unsafe = [
    "Buy now before it rips", "This is a STRONG BUY", "take this trade",
    "Just buy calls here", "buy puts on this", "guaranteed winner",
    "easy money setup", "copy this trade", "time to sell everything",
    "Take this call", "take this put",
  ];
  for (const s of unsafe) assert.equal(containsBannedPublicLanguage(s), true, s);
});

test("banned checker passes safe education wording (incl. tricky substrings)", () => {
  const safe = [
    "High-Quality Scanner Alert: RDDT",
    "Watchlist Candidate — momentum + catalyst detected",
    "Educational market signal only. Not financial advice.",
    "Options Liquidity Alert: spreads are workable",
    "buyout rumors circulating", // 'buyout' must not trip the 'buy' word-boundary
    "sell-side analyst coverage initiated", // hyphenated, not the verb usage... still contains 'sell'? word boundary check
  ];
  // Note: "sell-side" DOES contain the whole word "sell" — by design we treat
  // it as unsafe (over-blocking beats under-blocking for public output).
  assert.equal(containsBannedPublicLanguage(safe[0]), false);
  assert.equal(containsBannedPublicLanguage(safe[1]), false);
  assert.equal(containsBannedPublicLanguage(safe[2]), false);
  assert.equal(containsBannedPublicLanguage(safe[3]), false);
  assert.equal(containsBannedPublicLanguage(safe[4]), false);
  assert.equal(containsBannedPublicLanguage(safe[5]), true);
});

test("privateLabel bands per spec", () => {
  assert.equal(privateLabel(95), "A+ Setup");
  assert.equal(privateLabel(85), "High-Quality Alert");
  assert.equal(privateLabel(75), "Watchlist Candidate");
  assert.equal(privateLabel(65), "Needs Confirmation");
  assert.equal(privateLabel(40), "Low Quality / Ignore");
  assert.equal(privateLabel(95, { riskLabel: "Extreme Risk / Avoid" }), "Skip / Too Risky");
});

test("publicLabel bands are education-safe and pass the checker", () => {
  for (const s of [95, 85, 75, 65, 40]) {
    const label = publicLabel(s);
    assert.equal(containsBannedPublicLanguage(label), false, label);
  }
  assert.equal(publicLabel(85), "High-Quality Scanner Alert");
  assert.equal(publicLabel(75), "Watchlist Candidate");
  assert.equal(publicLabel(40), "Educational Only");
  assert.equal(publicLabel(95, { riskLabel: "Extreme Risk / Avoid" }), "Risk Warning");
});

test("riskLabel bands", () => {
  assert.equal(riskLabel(10), "Low Risk");
  assert.equal(riskLabel(40), "Medium Risk");
  assert.equal(riskLabel(60), "High Risk");
  assert.equal(riskLabel(80), "Extreme Risk / Avoid");
});

test("suggestedAction: skip on extreme risk or low quality, watch on clean strength", () => {
  assert.equal(suggestedAction(90, 80), "Skip");
  assert.equal(suggestedAction(50, 20), "Skip");
  assert.equal(suggestedAction(85, 30), "Watch");
  assert.equal(suggestedAction(72, 40), "Confirm");
});

test("private side hints exist only for real sides", () => {
  assert.equal(privateSideHint("call"), "Possible Call Setup");
  assert.equal(privateSideHint("put"), "Possible Put Setup");
  assert.equal(privateSideHint(null), null);
  assert.equal(directionLabel("neutral"), "Volatile / Unclear");
});
