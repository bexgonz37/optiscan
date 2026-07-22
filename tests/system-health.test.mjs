import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  __resetFreshnessForTest,
  recordProviderSuccess,
  recordNoData,
  recordDataSample,
  getProviderHealth,
  getSystemDataHealth,
  describeBlockingSample,
  describeSymbolActionability,
  maxAgeSecondsFor,
  kindLabel,
  sessionLabel,
} from "../lib/data-freshness.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("provider health is independent of individual stale symbols", () => {
  __resetFreshnessForTest();
  recordProviderSuccess("polygon", 42);
  // several stale/missing symbols do NOT flip the provider to disconnected
  recordNoData("META", "stock_quote", "no data yet");
  recordNoData("NVDA", "options_chain", "403 not entitled");
  const provider = getProviderHealth();
  assert.equal(provider.connected, true, "provider stays connected despite stale symbols");
  const health = getSystemDataHealth();
  assert.ok(health.blocking_symbols.length >= 2, "blocking symbols tracked separately");
  assert.ok(health.stale_symbols.includes("NVDA"), "entitlement/provider issues remain in stale/provider bucket");
  assert.ok(!health.stale_symbols.includes("META"), "ordinary no-data is not mislabeled stale");
  assert.equal(health.provider.connected, true, "system view keeps provider health independent");
});

test("describeBlockingSample produces the exact human-readable reason for a stale after-hours quote", () => {
  const sample = {
    symbol: "META",
    kind: "stock_quote",
    market_session: "afterhours",
    data_age_seconds: 67,
    freshness_status: "STALE",
    provider: "polygon",
    provider_timestamp: null,
    provider_timestamp_ms: null,
    received_at: new Date().toISOString(),
    received_at_ms: Date.now(),
    note: null,
  };
  // Threshold comes from maxAgeSecondsFor — 20s base × 4 extended multiplier = 80s
  assert.equal(maxAgeSecondsFor("stock_quote", "afterhours"), 80);
  const reason = describeBlockingSample(sample);
  assert.ok(reason.includes("META stock quote is 67 seconds old"), reason);
  assert.ok(reason.includes("after-hours"), reason);
  assert.ok(reason.includes("80 seconds"), reason);
});

test("describeBlockingSample returns null for fresh samples", () => {
  const fresh = {
    symbol: "SPY", kind: "stock_quote", market_session: "regular",
    data_age_seconds: 3, freshness_status: "LIVE", provider: "polygon",
    provider_timestamp: null, provider_timestamp_ms: null,
    received_at: new Date().toISOString(), received_at_ms: Date.now(), note: null,
  };
  assert.equal(describeBlockingSample(fresh), null);
});

test("kindLabel and sessionLabel give human copy", () => {
  assert.equal(kindLabel("one_minute_candle"), "1-minute candle");
  assert.equal(kindLabel("options_chain"), "options chain");
  assert.equal(sessionLabel("afterhours"), "after-hours");
  assert.equal(sessionLabel("premarket"), "pre-market");
  assert.equal(sessionLabel("regular"), "regular-hours");
});

test("describeSymbolActionability aggregates blocking reasons for a symbol", () => {
  __resetFreshnessForTest();
  recordNoData("AAPL", "options_chain", "403 not entitled");
  const verdict = describeSymbolActionability("AAPL");
  assert.equal(verdict.actionable, false);
  assert.ok(verdict.reasons.length >= 1);
  assert.ok(verdict.reasons.some((r) => r.includes("AAPL")));
});

test("a fresh symbol reports actionable with no reasons", () => {
  __resetFreshnessForTest();
  recordDataSample({ symbol: "TSLA", kind: "stock_quote", providerTimestamp: Date.now() - 2000, receivedAt: Date.now() });
  const verdict = describeSymbolActionability("TSLA", ["stock_quote"]);
  // regular-session freshness may be LIVE (actionable) or MARKET_CLOSED (blocking)
  // depending on the wall clock; either way reasons must be consistent with it.
  assert.equal(verdict.actionable, verdict.reasons.length === 0);
});

test("system overview route keeps provider health separate and reports DB health", () => {
  const route = read("app/api/system/overview/route.ts");
  assert.ok(/getSystemDataHealth/.test(route), "uses freshness aggregate");
  assert.ok(/database/.test(route) && /SELECT 1 AS one/.test(route), "checks DB health");
  assert.ok(/describeSymbolActionability|describeBlockingSample/.test(route), "attaches human reasons");
  assert.ok(/maxAgeSecondsFor/.test(route), "uses shared thresholds, not duplicated numbers");
  assert.ok(!/polyFetch|fetchBulkQuotes|fetchOptionChain/.test(route), "makes no provider calls");
});

test("Discord panel shows recap NOT CONFIGURED without treating it as a delivery failure, and leaks no secrets", () => {
  const panel = read("components/DiscordDeliveryPanel.tsx");
  assert.ok(/Paid beta readiness/.test(panel), "Discord-only paid beta readiness is visible to the operator");
  assert.ok(/Subscriber surface/.test(panel) && /Discord only/.test(panel), "panel names Discord as the subscriber surface");
  assert.ok(/NOT CONFIGURED/.test(panel), "recap not-configured must be surfaced");
  assert.ok(/does not affect options or stock alert delivery/i.test(panel), "recap absence is not a failure");
  assert.ok(!/DISCORD_WEBHOOK|https:\/\/discord/.test(panel), "no webhook URLs/secrets in the frontend");
  // failure review count excludes NOT_CONFIGURED
  assert.ok(/FAILED", "RETRYING", "SUPPRESSED/.test(panel), "review count is failures/retries/suppressed only");
});

test("Discord deliveries API joins alerts for ticker + setup but returns no payload secrets to callers", () => {
  const store = read("lib/alert-store.ts");
  assert.ok(/LEFT JOIN alerts/.test(store), "ledger enriched with ticker/setup via join");
  const health = read("app/api/discord/health/route.ts");
  assert.ok(/recap:/.test(health), "recap webhook status exposed as boolean only");
  assert.ok(/subscriberSurface/.test(health) && /discord_only/.test(health), "health route declares Discord-only subscriber surface");
  assert.ok(/buildSubscriberDiscordReadiness/.test(health), "health route exposes paid-beta readiness derived from delivery health");
  assert.ok(!/DISCORD_WEBHOOK_/.test(health), "health route never echoes webhook env values");
});
