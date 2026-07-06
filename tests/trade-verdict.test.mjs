import test from "node:test";
import assert from "node:assert/strict";
import { computeTradeVerdict, isTradeEligible, hasLiveSpeedProof } from "../lib/trade-verdict.ts";

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

// The AMZN case: barely-moving stock with strong contract scores must not
// show BUY CALL just because scores look good.
test("computeTradeVerdict: slow stock (+0.19% day, 0.05%/min) -> WAIT not BUY", () => {
  const v = computeTradeVerdict({
    ...goodCall,
    ticker: "AMZN",
    short_rate_at_alert: 0.05,
    volume_surge_at_alert: 0.9,
    percent_move_at_alert: 0.19,
    relative_volume: 1.4,
  });
  assert.equal(v.action, "WAIT");
  assert.equal(v.hasSpeedProof, false);
});

// Big day move / high RVOL are context only — they no longer substitute for
// live speed when the tape has stalled.
test("computeTradeVerdict: +5% day move but stalled tape -> WAIT", () => {
  const v = computeTradeVerdict({
    ...goodCall,
    short_rate_at_alert: 0.0,
    volume_surge_at_alert: 0.7,
    percent_move_at_alert: 5.2,
    relative_volume: 3.4,
  });
  assert.equal(v.action, "WAIT");
  assert.equal(v.hasSpeedProof, false);
});

// Call bias but the tape is moving DOWN — a volume burst cannot rescue it.
test("computeTradeVerdict: reversed speed against call bias -> not TRADE", () => {
  const v = computeTradeVerdict({
    ...goodCall,
    short_rate_at_alert: -0.4,
    volume_surge_at_alert: 2.5,
  });
  assert.notEqual(v.action, "TRADE");
});

// Swing-radar path stores no speed data — capped at WAIT even with day move/RVOL.
test("computeTradeVerdict: swing path (null speed, big day move) -> never TRADE", () => {
  const v = computeTradeVerdict({
    ...goodCall,
    short_rate_at_alert: null,
    volume_surge_at_alert: null,
    percent_move_at_alert: 6.0,
    relative_volume: 4.0,
  });
  assert.equal(v.action, "WAIT");
});

test("computeTradeVerdict: research tier never TRADEs even with fast at-alert speed", () => {
  const v = computeTradeVerdict({ ...goodCall, alert_tier: "research" });
  assert.equal(v.action, "WAIT");
});

test("computeTradeVerdict: live tape re-acceleration upgrades stale alert to TRADE", () => {
  const stale = { ...goodCall, short_rate_at_alert: 0.02, volume_surge_at_alert: 0.8 };
  assert.equal(computeTradeVerdict(stale).action, "WAIT");
  assert.equal(computeTradeVerdict(stale, { shortRate: 0.3, surge: 1.8 }).action, "TRADE");
});

test("isTradeEligible: popup filter matches TRADE verdicts only", () => {
  assert.equal(isTradeEligible(goodCall), true);
  assert.equal(isTradeEligible(goodCall, { shortRate: 0.02, surge: 0.8 }), false);
  assert.equal(isTradeEligible({ ...goodCall, alert_tier: "research" }), false);
});

test("hasLiveSpeedProof: direction-aligned only", () => {
  const base = { short_rate_at_alert: 0.2, volume_surge_at_alert: null };
  assert.equal(hasLiveSpeedProof(base, "CALL"), true);
  assert.equal(hasLiveSpeedProof(base, "PUT"), false);
  assert.equal(hasLiveSpeedProof({ short_rate_at_alert: -0.2, volume_surge_at_alert: null }, "PUT"), true);
  assert.equal(hasLiveSpeedProof({ short_rate_at_alert: null, volume_surge_at_alert: null }, "CALL"), false);
});
