import test from "node:test";
import assert from "node:assert/strict";
import { buildCallout } from "../lib/callouts/callout.ts";
import { candidateIdempotencyKey } from "../lib/callouts/paper-bridge.ts";
import { tradingDay } from "../lib/trading-session.ts";

const EW_OK = { state: "ACTIONABLE", waitFor: "enter now", validEntry: "valid now", doNotEnter: "loses VWAP", currently: "confirmed", alreadyHappened: null };

function callout(ts) {
  return buildCallout({
    agentId: "call_1_5", agentVersion: 1, strategy: "swing_momentum", strategyVersion: 1,
    ticker: "NVDA", direction: "bullish", horizon: "1-5", dteRange: [1, 5],
    candidateStatus: "ACTIONABLE_NOW", lifecycleStatus: null, score: 82,
    verifiedInputs: { spot: 182.4, entryWindow: EW_OK }, requiredConditions: ["hold VWAP"], selectorProfile: "swing_momentum",
    selectedContract: { optionSymbol: "O:NVDA_C185", strike: 185, expiration: "2026-07-17", dte: 4, side: "call", bid: 2.10, ask: 2.18, mid: 2.14, spreadPct: 3, delta: 0.5, iv: 0.3, volume: 500, openInterest: 1000, breakevenPct: 0.5 },
    passedGates: ["spread"], failedGates: [], evidenceStatus: "NOT_TRACKED",
    statisticsSnapshot: { evidenceStatus: "NOT_TRACKED", evidenceSummary: "", gradedSampleSize: 0 },
    modelStatus: "INACTIVE_NO_TRAINABLE_DATA", probability: null,
    actionability: "ACTIONABLE", researchOnly: false, reasons: ["fresh momentum"],
    improvementConditions: [], invalidationConditions: ["loses VWAP"], freshness: { ok: true, reason: null },
    marketContext: null, riskVerdict: { allowed: true, failures: [], vetoed: false }, timestamp: ts,
  });
}

test("idempotency key is scoped to the US/Eastern trading day, not the UTC date", () => {
  // 01:00 UTC on Jul 14 == 21:00 ET on Jul 13 (after-hours). UTC date rolled over,
  // but the trading day is still Jul 13 — the key must carry the ET day.
  const nowMs = Date.parse("2026-07-14T01:00:00Z");
  assert.equal(tradingDay(nowMs), "2026-07-13", "sanity: 9pm ET is the prior trading day vs UTC");
  const key = candidateIdempotencyKey(callout(nowMs), nowMs);
  assert.ok(key.endsWith(":2026-07-13"), `key uses the ET trading day, got ${key}`);
  assert.ok(!key.endsWith(":2026-07-14"), "key must NOT use the rolled-over UTC date");
});

test("two after-hours cycles either side of UTC midnight share ONE trading-day key", () => {
  const before = Date.parse("2026-07-13T23:30:00Z"); // 19:30 ET Jul 13
  const after = Date.parse("2026-07-14T00:30:00Z");  // 20:30 ET Jul 13 (still Jul 13 ET)
  const c = callout(before);
  const k1 = candidateIdempotencyKey(c, before);
  const k2 = candidateIdempotencyKey(c, after);
  assert.equal(k1, k2, "same ET trading day → same dedup key across the UTC midnight boundary");
});

test("a genuinely new trading day produces a distinct key", () => {
  const day1 = Date.parse("2026-07-13T15:00:00Z"); // 11:00 ET Jul 13
  const day2 = Date.parse("2026-07-14T15:00:00Z"); // 11:00 ET Jul 14
  const c = callout(day1);
  assert.notEqual(candidateIdempotencyKey(c, day1), candidateIdempotencyKey(c, day2));
});
