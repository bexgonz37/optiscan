import test from "node:test";
import assert from "node:assert/strict";
import {
  privateLabel,
  privateLabel0dte,
  publicLabel,
  publicLabel0dte,
  privateSideHint,
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
    "Take this call", "take this put", "take calls here", "take puts now", "sell now",
  ];
  for (const s of unsafe) assert.equal(containsBannedPublicLanguage(s), true, s);
});

test("banned checker passes safe education wording", () => {
  for (const s of [
    "Bullish Momentum Alert: SPY",
    "Bearish scanner alert — momentum setup detected",
    "0DTE Watchlist Candidate",
    "Educational market signal only. Not financial advice.",
    "buyout rumors circulating", // word boundary: 'buyout' is not 'buy'
  ]) assert.equal(containsBannedPublicLanguage(s), false, s);
});

test("SPEC: private 0DTE labels — call/put watch wording, flags override", () => {
  assert.equal(privateLabel0dte({ bias: "long_call_candidate", setupScore: 91 }), "A+ 0DTE Call Watch");
  assert.equal(privateLabel0dte({ bias: "long_call_candidate", setupScore: 78 }), "0DTE Call Watch");
  assert.equal(privateLabel0dte({ bias: "long_put_candidate", setupScore: 92 }), "A+ 0DTE Put Watch");
  assert.equal(privateLabel0dte({ bias: "wait_for_pullback", setupScore: 70 }), "Wait for Pullback");
  assert.equal(privateLabel0dte({ bias: "chase_risk", setupScore: 70 }), "Chase Risk");
  assert.equal(privateLabel0dte({ bias: "no_clean_setup", setupScore: 70 }), "Too Choppy");
  assert.equal(privateLabel0dte({ bias: "watch_only", setupScore: 70, direction: "bullish" }), "Bullish 0DTE Setup");
  assert.equal(privateLabel0dte({ bias: "watch_only", setupScore: 70, direction: "bearish" }), "Bearish 0DTE Setup");
  assert.equal(privateLabel0dte({ bias: "long_call_candidate", setupScore: 95, riskFlags: ["Spread Too Wide"] }), "Spread Too Wide");
  assert.equal(privateLabel0dte({ bias: "long_call_candidate", setupScore: 95, riskFlags: ["Premium Too Expensive"] }), "Premium Too Expensive");
});

test("SPEC: public 0DTE labels are directional but never call/put and always safe", () => {
  assert.equal(publicLabel0dte({ direction: "bullish", setupScore: 88 }), "Bullish Momentum Alert");
  assert.equal(publicLabel0dte({ direction: "bearish", setupScore: 75 }), "Bearish Momentum Alert");
  assert.equal(publicLabel0dte({ direction: "choppy", setupScore: 65 }), "0DTE Watchlist Candidate");
  assert.equal(publicLabel0dte({ direction: "bullish", setupScore: 55 }), "Momentum Setup Detected");
  assert.equal(publicLabel0dte({ direction: "bullish", setupScore: 20 }), "Educational Only");
  for (const d of ["bullish", "bearish", "choppy"]) for (const s of [95, 75, 62, 55, 20]) {
    const label = publicLabel0dte({ direction: d, setupScore: s });
    assert.equal(containsBannedPublicLanguage(label), false, label);
    assert.ok(!/call|put/i.test(label), `public label leaks side: ${label}`);
  }
});

test("legacy label bands still work for swing/manual alerts", () => {
  assert.equal(privateLabel(95), "A+ Setup");
  assert.equal(privateLabel(65), "Needs Confirmation");
  assert.equal(publicLabel(85), "High-Quality Scanner Alert");
  assert.equal(privateSideHint("call"), "Possible Call Setup");
});

test("riskLabel / suggestedAction / directionLabel", () => {
  assert.equal(riskLabel(10), "Low Risk");
  assert.equal(riskLabel(80), "Extreme Risk / Avoid");
  assert.equal(suggestedAction(85, 30), "Watch");
  assert.equal(suggestedAction(90, 80), "Skip");
  assert.equal(directionLabel("choppy"), "Volatile / Unclear");
});
