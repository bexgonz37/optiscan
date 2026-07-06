import test from "node:test";
import assert from "node:assert/strict";
import { computeTradeVerdict } from "../lib/trade-verdict.ts";

const goodCall = {
  ticker: "SMCI",
  direction: "bullish",
  trade_bias: "long_call_candidate",
  signal_score: 81,
  risk_score: 8,
  option_worth_score: 87,
  worth_verdict: "Early Move",
  zero_dte_contract_score: 85,
  options_liquidity_score: 70,
  short_rate_at_alert: 0.35,
  volume_surge_at_alert: 2.1,
  strike: 45,
  option_side: "call",
  dte: 0,
  risk_flags: "[]",
};

test("computeTradeVerdict: strong call setup -> BUY CALL", () => {
  const v = computeTradeVerdict(goodCall);
  assert.equal(v.action, "TRADE");
  assert.equal(v.headline, "BUY CALL");
  assert.equal(v.side, "CALL");
});

test("computeTradeVerdict: premium too expensive -> SKIP", () => {
  const v = computeTradeVerdict({
    ...goodCall,
    risk_flags: JSON.stringify(["Premium Too Expensive"]),
  });
  assert.equal(v.action, "SKIP");
  assert.match(v.headline, /SKIP/);
});

test("computeTradeVerdict: chase risk with weak worth -> WAIT", () => {
  const v = computeTradeVerdict({
    ...goodCall,
    trade_bias: "chase_risk",
    option_worth_score: 50,
    worth_verdict: "Chase Risk",
  });
  assert.equal(v.action, "WAIT");
});

test("computeTradeVerdict: good scores but no speed -> WAIT not BUY", () => {
  const v = computeTradeVerdict({
    ...goodCall,
    short_rate_at_alert: null,
    volume_surge_at_alert: null,
    percent_move_at_alert: 0.2,
    relative_volume: 1.1,
  });
  assert.equal(v.action, "WAIT");
  assert.equal(v.hasSpeedProof, false);
});

test("computeTradeVerdict: live speed stalled downgrades TRADE to WAIT", () => {
  const v = computeTradeVerdict(goodCall, { shortRate: 0.02, surge: 0.8 });
  assert.equal(v.action, "WAIT");
});

test("computeTradeVerdict: bearish put candidate -> BUY PUT", () => {
  const v = computeTradeVerdict({
    ...goodCall,
    direction: "bearish",
    trade_bias: "long_put_candidate",
    option_side: "put",
    short_rate_at_alert: -0.4,
  });
  assert.equal(v.action, "TRADE");
  assert.equal(v.headline, "BUY PUT");
});
