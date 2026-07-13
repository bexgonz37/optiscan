import test from "node:test";
import assert from "node:assert/strict";
import {
  __resetFreshnessForTest,
  actionableFreshness,
  getSystemDataHealth,
  normalizeProviderTimestampMs,
  recordDataSample,
  recordNoData,
} from "../lib/data-freshness.ts";

test("normalizeProviderTimestampMs supports seconds, milliseconds, microseconds, nanoseconds, bigint, strings, ISO, and Date", () => {
  const baseMs = Date.parse("2026-07-10T18:01:16.000Z");
  const nowMs = baseMs + 60_000;
  assert.equal(normalizeProviderTimestampMs(1783706476, nowMs), baseMs);
  assert.equal(normalizeProviderTimestampMs(1783706476000, nowMs), baseMs);
  assert.equal(normalizeProviderTimestampMs(1783706476000000, nowMs), baseMs);
  assert.equal(normalizeProviderTimestampMs(1783706476000000000, nowMs), baseMs);
  assert.equal(normalizeProviderTimestampMs(1783706476000000000n, nowMs), baseMs);
  assert.equal(normalizeProviderTimestampMs("1783706476000000000", nowMs), baseMs);
  assert.equal(normalizeProviderTimestampMs("2026-07-10T18:01:16.000Z", nowMs), baseMs);
  assert.equal(normalizeProviderTimestampMs(new Date(baseMs), nowMs), baseMs);
});

test("normalizeProviderTimestampMs rejects malformed, unsafe, old, and future timestamps", () => {
  const nowMs = Date.parse("2026-07-10T18:01:16.000Z");
  assert.equal(normalizeProviderTimestampMs(null, nowMs), null);
  assert.equal(normalizeProviderTimestampMs(undefined, nowMs), null);
  assert.equal(normalizeProviderTimestampMs(0, nowMs), null);
  assert.equal(normalizeProviderTimestampMs(-1783706476, nowMs), null);
  assert.equal(normalizeProviderTimestampMs("not a date", nowMs), null);
  assert.equal(normalizeProviderTimestampMs(Number.NaN, nowMs), null);
  assert.equal(normalizeProviderTimestampMs(Number.POSITIVE_INFINITY, nowMs), null);
  assert.equal(normalizeProviderTimestampMs(nowMs + 10 * 60_000, nowMs), null);
  assert.equal(normalizeProviderTimestampMs("1999-12-31T23:59:59.000Z", nowMs), null);
  assert.equal(normalizeProviderTimestampMs(new Date("invalid"), nowMs), null);
});

test("freshness service records provider timestamps and actionable status", () => {
  __resetFreshnessForTest();
  const now = Date.now();
  const sample = recordDataSample({
    symbol: "SPY",
    kind: "stock_quote",
    providerTimestamp: now - 5_000,
    receivedAt: now,
  });
  assert.equal(sample.symbol, "SPY");
  assert.equal(sample.data_age_seconds, 5);
  assert.ok(["LIVE", "MARKET_CLOSED"].includes(sample.freshness_status));
  const health = getSystemDataHealth({ callsToday: 1, callsThisMinute: 1, quotaExceeded: false });
  assert.equal(health.freshness.stock_quote?.symbol, "SPY");
});

test("actionable freshness blocks missing and not-entitled data", () => {
  __resetFreshnessForTest();
  recordNoData("META", "options_chain", "403 not entitled");
  const verdict = actionableFreshness("META", ["stock_quote", "options_chain"]);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reason.includes("options_chain: NO_ENTITLEMENT"));
  assert.ok(verdict.reason.includes("stock_quote: NOT_REQUESTED_YET"));
});

test("system health separates blocking not-requested symbols from truly stale/provider symbols", () => {
  __resetFreshnessForTest();
  recordNoData("LUNR", "options_chain", "required data type has not been observed in this process");
  recordNoData("VLO", "news", "no recent catalysts returned");
  recordNoData("AMD", "options_chain", "polygon timeout after 10000ms: /v3/snapshot/options/AMD");
  const health = getSystemDataHealth();
  assert.ok(health.blocking_symbols.includes("LUNR"));
  assert.ok(health.blocking_symbols.includes("VLO"));
  assert.ok(health.stale_symbols.includes("AMD"));
  assert.ok(!health.stale_symbols.includes("LUNR"), "not-requested data is not counted as stale live data");
  assert.ok(!health.stale_symbols.includes("VLO"), "ordinary no-data rows are not counted as stale live data");
});
