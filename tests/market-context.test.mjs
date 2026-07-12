import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMarketContext,
  contextIsUsable,
  MARKET_CONTEXT_VERSION,
} from "../lib/market-context.ts";

const NOW = Date.parse("2026-07-09T15:00:00Z");
const idx = (symbol, changePercent, aboveVwap = true, freshnessOk = true) => ({ symbol, changePercent, aboveVwap, freshnessOk });

const base = (over = {}) => ({ session: "regular", spy: idx("SPY", 0.8, true), qqq: idx("QQQ", 0.9, true), vix: null, nowMs: NOW, ...over });

test("risk_on when SPY and QQQ both trend up", () => {
  const c = buildMarketContext(base());
  assert.equal(c.spyTrend, "UP");
  assert.equal(c.qqqTrend, "UP");
  assert.equal(c.riskState, "RISK_ON");
  assert.equal(c.contextVersion, MARKET_CONTEXT_VERSION);
});

test("risk_off when SPY and QQQ both trend down", () => {
  const c = buildMarketContext(base({ spy: idx("SPY", -0.7, false), qqq: idx("QQQ", -0.8, false) }));
  assert.equal(c.riskState, "RISK_OFF");
});

test("mixed + conflict flag when SPY and QQQ disagree", () => {
  const c = buildMarketContext(base({ spy: idx("SPY", 0.9, true), qqq: idx("QQQ", -0.9, false) }));
  assert.equal(c.riskState, "MIXED");
  assert.ok(c.conflictFlags.includes("spy_qqq_direction_conflict"));
});

test("UNKNOWN risk when an index read is missing", () => {
  const c = buildMarketContext(base({ qqq: null }));
  assert.equal(c.qqqTrend, "UNKNOWN");
  assert.equal(c.riskState, "UNKNOWN");
  assert.ok(c.reasons.includes("qqq_missing"));
});

test("stale index data degrades to UNKNOWN trend and is flagged", () => {
  const c = buildMarketContext(base({ spy: idx("SPY", 1.2, true, false) }));
  assert.equal(c.spyTrend, "UNKNOWN");
  assert.equal(c.freshness, "STALE");
  assert.ok(c.conflictFlags.includes("stale_index_data"));
  assert.ok(c.reasons.includes("spy_stale"));
});

test("trend threshold: small moves are FLAT", () => {
  const c = buildMarketContext(base({ spy: idx("SPY", 0.1, true), qqq: idx("QQQ", 0.05, true) }));
  assert.equal(c.spyTrend, "FLAT");
  assert.equal(c.riskState, "MIXED");
  assert.equal(c.structure, "CHOPPY");
});

test("volatility is UNKNOWN without a VIX proxy, bucketed when present", () => {
  assert.equal(buildMarketContext(base({ vix: null })).volatility, "UNKNOWN");
  assert.equal(buildMarketContext(base({ vix: 12 })).volatility, "LOW");
  assert.equal(buildMarketContext(base({ vix: 20 })).volatility, "ELEVATED");
  assert.equal(buildMarketContext(base({ vix: 30 })).volatility, "HIGH");
});

test("structure TRENDING only when VWAP agrees with the trend", () => {
  assert.equal(buildMarketContext(base({ spy: idx("SPY", 1.0, true) })).structure, "TRENDING");
  const conflict = buildMarketContext(base({ spy: idx("SPY", 1.0, false) }));
  assert.equal(conflict.structure, "CHOPPY");
  assert.ok(conflict.conflictFlags.includes("trend_vwap_conflict"));
});

test("vwapState reflects SPY vwap, UNKNOWN when absent", () => {
  assert.equal(buildMarketContext(base({ spy: idx("SPY", 1, true) })).vwapState, "ABOVE");
  assert.equal(buildMarketContext(base({ spy: idx("SPY", -1, false) })).vwapState, "BELOW");
  assert.equal(buildMarketContext(base({ spy: idx("SPY", 1, null) })).vwapState, "UNKNOWN");
});

test("freshness UNKNOWN when no index reads at all", () => {
  const c = buildMarketContext(base({ spy: null, qqq: null }));
  assert.equal(c.freshness, "UNKNOWN");
  assert.equal(c.riskState, "UNKNOWN");
});

test("contextIsUsable only when fresh and risk known", () => {
  assert.equal(contextIsUsable(buildMarketContext(base())), true);
  assert.equal(contextIsUsable(buildMarketContext(base({ qqq: null }))), false);
});

test("context is deterministic", () => {
  assert.deepEqual(buildMarketContext(base()), buildMarketContext(base()));
});
