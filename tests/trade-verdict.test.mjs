import test from "node:test";
import assert from "node:assert/strict";
import { computeTradeVerdict, isTradeEligible, hasLiveSpeedProof, isClearTradeSignal, passesQualityGates, resolveAlertTier, shouldLockCapturedTrade } from "../lib/trade-verdict.ts";

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

test("computeTradeVerdict: strong call setup -> Buy call option", () => {
  const v = computeTradeVerdict(goodCall);
  assert.equal(v.action, "TRADE");
  assert.equal(v.headline, "BUY CALL");
  assert.equal(v.side, "CALL");
});

test("computeTradeVerdict: stock alert says Buy stock, never Buy call", () => {
  const v = computeTradeVerdict({
    asset_class: "stock",
    trade_bias: "stock_long_candidate",
    capture_action: "TRADE",
    session: "afterhours",
    signal_score: 78,
    short_rate_at_alert: 0.25,
  });
  assert.equal(v.headline, "Buy stock ↑");
  assert.equal(v.side, "NONE");
  assert.ok(!v.headline.includes("CALL"));
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

test("computeTradeVerdict: stalled with live null surge must not borrow alert surge (C1)", () => {
  const stalled = {
    ...goodCall,
    short_rate_at_alert: 0.35,
    volume_surge_at_alert: 2.1,
  };
  const v = computeTradeVerdict(stalled, { shortRate: 0.02, surge: null });
  assert.equal(v.action, "WAIT");
  assert.equal(v.hasSpeedProof, false);
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

// GME-style: live tape dipping with high surge must not show BUY CALL.
test("computeTradeVerdict: live down + surge does not keep BUY CALL", () => {
  const v = computeTradeVerdict(goodCall, { shortRate: -0.05, surge: 2.2, direction: "bearish" });
  assert.notEqual(v.action, "TRADE");
  assert.equal(v.action, "WAIT");
});

test("computeTradeVerdict: live bearish direction blocks CALL even with speed", () => {
  const v = computeTradeVerdict(goodCall, { shortRate: 0.25, surge: 2.0, direction: "bearish" });
  assert.equal(v.action, "WAIT");
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

test("computeTradeVerdict: live tape re-acceleration upgrades FRESH stalled alert to TRADE", () => {
  const fresh = {
    ...goodCall,
    short_rate_at_alert: 0.02,
    volume_surge_at_alert: 0.8,
    alert_time: new Date(Date.now() - 3 * 60_000).toISOString(), // 3 min old
  };
  assert.equal(computeTradeVerdict(fresh).action, "WAIT");
  assert.equal(computeTradeVerdict(fresh, { shortRate: 0.3, surge: 1.8 }).action, "TRADE");
});

// The user's "old alert still attached" bug: a signal from 40 min ago must
// never re-arm as BUY just because the tape twitches the right way again.
test("computeTradeVerdict: stale alert (40 min old) never re-arms as TRADE on live re-check", () => {
  const old = { ...goodCall, alert_time: new Date(Date.now() - 40 * 60_000).toISOString() };
  const v = computeTradeVerdict(old, { shortRate: 0.5, surge: 2.5, direction: "bullish" });
  assert.equal(v.action, "WAIT");
  assert.match(v.reason, /too old|stale/i);
});

test("computeTradeVerdict: stale alert WITHOUT live context keeps historical TRADE verdict", () => {
  // History tab's "@ alert" column: shows what the verdict WAS, not what it is now.
  const old = { ...goodCall, alert_time: new Date(Date.now() - 3 * 3_600_000).toISOString() };
  assert.equal(computeTradeVerdict(old).action, "TRADE");
});

test("computeTradeVerdict: fresh alert (2 min) with fast aligned tape still TRADEs", () => {
  const fresh = { ...goodCall, alert_time: new Date(Date.now() - 2 * 60_000).toISOString() };
  assert.equal(computeTradeVerdict(fresh, { shortRate: 0.4, surge: 2.0, direction: "bullish" }).action, "TRADE");
});

test("isTradeEligible: popup filter matches TRADE verdicts only", () => {
  const rthMs = Date.parse("2026-07-07T14:00:00-04:00"); // Tue 2:00 PM ET (regular hours)
  assert.equal(isTradeEligible(goodCall, undefined, rthMs), true);
  assert.equal(isTradeEligible({ ...goodCall, capture_action: "TRADE", alert_time: new Date(rthMs - 60_000).toISOString() }, { shortRate: 0.02, surge: 0.8 }, rthMs), true);
  assert.equal(isTradeEligible(goodCall, { shortRate: 0.02, surge: 0.8 }, rthMs), false);
  assert.equal(isTradeEligible({ ...goodCall, alert_tier: "research" }, undefined, rthMs), false);
  assert.equal(isTradeEligible(goodCall, undefined, Date.parse("2026-07-07T17:00:00-04:00")), false);
});

test("shouldLockCapturedTrade: fresh TRADE locks through brief stall", () => {
  const fresh = {
    ...goodCall,
    capture_action: "TRADE",
    alert_time: new Date(Date.now() - 90_000).toISOString(),
  };
  assert.equal(shouldLockCapturedTrade(fresh, "CALL", { shortRate: 0.02, surge: 0.8 }), true);
  assert.equal(shouldLockCapturedTrade(fresh, "CALL", { shortRate: -0.25, surge: 0.8 }), false);
});

test("hasLiveSpeedProof: direction-aligned only", () => {
  const base = { short_rate_at_alert: 0.2, volume_surge_at_alert: null };
  assert.equal(hasLiveSpeedProof(base, "CALL"), true);
  assert.equal(hasLiveSpeedProof(base, "PUT"), false);
  assert.equal(hasLiveSpeedProof({ short_rate_at_alert: -0.2, volume_surge_at_alert: null }, "PUT"), true);
  assert.equal(hasLiveSpeedProof({ short_rate_at_alert: null, volume_surge_at_alert: null }, "CALL"), false);
  assert.equal(hasLiveSpeedProof(goodCall, "CALL", { shortRate: -0.03, surge: 2.5 }), false);
});

test("isClearTradeSignal: needs high confidence and fast aligned speed", () => {
  assert.equal(isClearTradeSignal(goodCall, { shortRate: 0.35, direction: "bullish" }), true);
  assert.equal(isClearTradeSignal(goodCall, { shortRate: 0.12, direction: "bullish" }), false);
  assert.equal(isClearTradeSignal({ ...goodCall, alert_tier: "research" }, { shortRate: 0.35, direction: "bullish" }), false);
});

test("resolveAlertTier: TRADE or quality+speed fallback", () => {
  assert.equal(resolveAlertTier({ action: "TRADE" }, false, false), "trade");
  assert.equal(resolveAlertTier({ action: "WAIT" }, true, true), "trade");
  assert.equal(resolveAlertTier({ action: "WAIT" }, true, false), "research");
  assert.equal(resolveAlertTier({ action: "SKIP" }, false, false), "research");
});

test("passesQualityGates: setup/worth/contract/liquidity + bias", () => {
  assert.equal(passesQualityGates(goodCall), true);
  assert.equal(passesQualityGates({ ...goodCall, signal_score: 65 }), false);
});
