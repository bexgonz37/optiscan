import test from "node:test";
import assert from "node:assert/strict";
import {
  ownerSettings, isPriorityTicker, tickerPriorityRank, stockAlertsEnabled,
  stockAlertGateReason, DEFAULT_CORE_UNIVERSE,
} from "../lib/owner-settings.ts";

test("safe production defaults (fewer, quality-first)", () => {
  const s = ownerSettings({});
  assert.deepEqual(s.coreUniverse, DEFAULT_CORE_UNIVERSE);
  assert.equal(s.maxDiscordAlerts, 5);
  assert.equal(s.minSetupQuality, 0);
  assert.equal(s.bullishEnabled, true);
  assert.equal(s.bearishEnabled, false);
  assert.equal(s.earlyAlertsEnabled, false);
  assert.deepEqual([...s.categories].sort(), ["options", "puts", "stocks"]);
});

test("core universe holds the professional desk names", () => {
  for (const t of ["SPY", "QQQ", "NVDA", "META", "AAPL", "MSFT", "AMD", "AMZN", "TSLA", "GOOGL", "AVGO", "NFLX"]) {
    assert.ok(DEFAULT_CORE_UNIVERSE.includes(t), `core missing ${t}`);
  }
});

test("every owner control is configurable via env (no code change)", () => {
  const s = ownerSettings({
    OWNER_CORE_TICKERS: "spy, qqq , iwm",
    OWNER_PREFERRED_TICKERS: "COIN MSTR",
    SUPERVISOR_MAX_DISCORD_ALERTS: "3",
    MIN_SETUP_QUALITY: "70",
    BULLISH_ENABLED: "0",
    BEARISH_ACTIONABLE: "1",
    EARLY_ALERTS_ENABLED: "1",
    OWNER_ALERT_CATEGORIES: "options,puts",
  });
  assert.deepEqual(s.coreUniverse, ["SPY", "QQQ", "IWM"]);
  assert.deepEqual(s.preferredTickers, ["COIN", "MSTR"]);
  assert.equal(s.maxDiscordAlerts, 3);
  assert.equal(s.minSetupQuality, 70);
  assert.equal(s.bullishEnabled, false);
  assert.equal(s.bearishEnabled, true);
  assert.equal(s.earlyAlertsEnabled, true);
  assert.deepEqual([...s.categories].sort(), ["options", "puts"]);
});

test("numeric controls are clamped to safe ranges", () => {
  assert.equal(ownerSettings({ SUPERVISOR_MAX_DISCORD_ALERTS: "0" }).maxDiscordAlerts, 1);
  assert.equal(ownerSettings({ SUPERVISOR_MAX_DISCORD_ALERTS: "999" }).maxDiscordAlerts, 50);
  assert.equal(ownerSettings({ MIN_SETUP_QUALITY: "-5" }).minSetupQuality, 0);
  assert.equal(ownerSettings({ MIN_SETUP_QUALITY: "500" }).minSetupQuality, 100);
});

test("priority ranking: core in listed order, then preferred, then the rest", () => {
  const s = ownerSettings({ OWNER_CORE_TICKERS: "SPY,QQQ", OWNER_PREFERRED_TICKERS: "COIN" });
  assert.ok(isPriorityTicker("SPY", s));
  assert.ok(isPriorityTicker("coin", s));
  assert.ok(!isPriorityTicker("F", s));
  assert.equal(tickerPriorityRank("SPY", s), 0);
  assert.equal(tickerPriorityRank("QQQ", s), 1);
  assert.equal(tickerPriorityRank("COIN", s), 2);
  assert.ok(tickerPriorityRank("F", s) > 100);
});

test("stock-alert gate is diagnosable (the exact reason)", () => {
  assert.equal(stockAlertsEnabled({}), false);
  assert.match(stockAlertGateReason({}), /STOCK_CALLOUTS=1/);
  assert.equal(stockAlertsEnabled({ STOCK_CALLOUTS: "1" }), true);
  assert.equal(stockAlertGateReason({ STOCK_CALLOUTS: "1" }), null);
});
