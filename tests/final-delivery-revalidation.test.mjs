import test from "node:test";
import assert from "node:assert/strict";
import { revalidateBeforeDiscordSend, mapVerdictToDeliveryRejection } from "../lib/research/options/final-delivery-revalidation.ts";
import { tradingDay, isMarketHoliday } from "../lib/trading-session.ts";

// Deterministic fake clock — the cross-session guard is time-relative, so every case pins a fixed
// nowMs and derives tradingSessionDate from THAT clock (never the real current date). This exercises
// the real cross-session protection without weakening it.
const MON = Date.parse("2026-07-20T10:30:00-04:00"); // a normal Monday, regular session
const MON_SESSION = tradingDay(MON);

const enforceEnv = {
  ENTRY_QUALITY_GATE: "enforce",
  MARKET_SESSION_GUARD: "enforce",
  OPTIONS_0DTE_DELIVERY_CUTOFF_MINUTES: "60",
  OPTIONS_READY_TTL_MS: "120000",
};

const baseInput = {
  candidateSymbol: "NVDA",
  strategy: "momentum_acceleration",
  researchOnly: false,
  contract: {
    optionSymbol: "O:NVDA260725C00180000",
    side: "call",
    strike: 180,
    expiration: "2026-07-25",
    bid: 2.1,
    ask: 2.3,
    spreadPct: 4,
    quoteAgeMs: 1000,
    dte: 1,
  },
  message: "legacy message",
  observedUnderlyingPrice: 179.5,
  currentUnderlyingPrice: 179.8,
  chaseLimitPct: 0.6,
  underlyingPrice: 179.8,
  entry: { bid: 2.1, ask: 2.3, mid: 2.2, spreadPct: 4, quoteAgeMs: 1000, t1: 2.6, t2: 3.0, stop: 1.8, methodology: "test" },
  firstDetectedAtMs: MON - 30_000,
  underlyingAtFirstDetection: 179.4,
  optionAtFirstDetection: 2.0,
  tradingSessionDate: MON_SESSION,
};

test("mapVerdictToDeliveryRejection maps standardized codes", () => {
  assert.equal(mapVerdictToDeliveryRejection("LATE"), "LATE_ENTRY");
  assert.equal(mapVerdictToDeliveryRejection("CHASED"), "CHASED_OPTION_PREMIUM");
  assert.equal(mapVerdictToDeliveryRejection("INSUFFICIENT_UPSIDE_REMAINING"), "INSUFFICIENT_UPSIDE_REMAINING");
});

test("fresh early setup passes final delivery gate", () => {
  const mon = Date.parse("2026-07-21T10:30:00-04:00");
  const r = revalidateBeforeDiscordSend({
    deliveryInput: {
      ...baseInput,
      tradingSessionDate: "2026-07-21",
      firstDetectedAtMs: mon - 30_000,
      featureSnapshot: { higherHighs: true, higherLows: true, aboveVwap: true },
    },
    nowMs: mon,
    firstReadyAtMs: mon - 20_000,
    readyExpiresAtMs: mon + 100_000,
  }, enforceEnv);
  assert.equal(r.allowed, true);
  assert.equal(r.rejectionCode, null);
  assert.ok(["EARLY", "TIMELY"].includes(r.timingClass));
  assert.ok(r.actionableReason.length > 0);
});

test("stale READY candidate blocked with STALE_READY_CANDIDATE", () => {
  // Fixed clock + same-session date so we reach the READY-TTL check (not the cross-session check).
  const r = revalidateBeforeDiscordSend({
    deliveryInput: { ...baseInput, tradingSessionDate: MON_SESSION },
    nowMs: MON,
    firstReadyAtMs: MON - 200_000,
    readyExpiresAtMs: MON - 1000,
  }, enforceEnv);
  assert.equal(r.allowed, false);
  assert.equal(r.rejectionCode, "STALE_READY_CANDIDATE");
});

test("chased option premium blocked with CHASED_OPTION_PREMIUM", () => {
  const mon = Date.parse("2026-07-21T10:30:00-04:00");
  const r = revalidateBeforeDiscordSend({
    deliveryInput: {
      ...baseInput,
      tradingSessionDate: "2026-07-21",
      firstDetectedAtMs: mon - 30_000,
      optionAtFirstDetection: 1.5,
      entry: { ...baseInput.entry, mid: 3.0, t1: 3.6, t2: 4.2 },
      contract: { ...baseInput.contract, bid: 2.9, ask: 3.1 },
    },
    nowMs: mon,
    firstReadyAtMs: mon - 10_000,
    readyExpiresAtMs: mon + 100_000,
  }, { ...enforceEnv, ENTRY_MAX_OPTION_PREMIUM_EXPANSION_PCT: "20" });
  assert.equal(r.allowed, false);
  assert.equal(r.rejectionCode, "CHASED_OPTION_PREMIUM");
});

test("move already completed blocks when T1 nearly reached", () => {
  const mon = Date.parse("2026-07-21T10:30:00-04:00");
  const r = revalidateBeforeDiscordSend({
    deliveryInput: {
      ...baseInput,
      tradingSessionDate: "2026-07-21",
      firstDetectedAtMs: mon - 30_000,
      currentUnderlyingPrice: 181.5,
      underlyingAtFirstDetection: 179.0,
      entry: { ...baseInput.entry, mid: 2.5, t1: 2.55, t2: 3.0 },
      contract: { ...baseInput.contract, bid: 2.48, ask: 2.52 },
    },
    nowMs: mon,
    firstReadyAtMs: mon - 10_000,
    readyExpiresAtMs: mon + 100_000,
  }, enforceEnv);
  assert.equal(r.allowed, false);
  assert.equal(r.rejectionCode, "MOVE_ALREADY_COMPLETED");
});

test("momentum exhaustion blocks with MOMENTUM_EXHAUSTED", () => {
  const mon = Date.parse("2026-07-21T10:30:00-04:00");
  const r = revalidateBeforeDiscordSend({
    deliveryInput: {
      ...baseInput,
      tradingSessionDate: "2026-07-21",
      firstDetectedAtMs: mon - 30_000,
      featureSnapshot: { accel: -0.12, move5m: -0.4 },
    },
    nowMs: mon,
    firstReadyAtMs: mon - 10_000,
    readyExpiresAtMs: mon + 100_000,
  }, enforceEnv);
  assert.equal(r.allowed, false);
  assert.equal(r.rejectionCode, "MOMENTUM_EXHAUSTED");
});

// ── Cross-session identity coverage (deterministic clock; derived session date) ─────────────────
// These assert the session guard's IDENTITY logic, isolated from the other gates: a same-session
// candidate must NOT be rejected as EXPIRED (it may still reject for another reason), and any
// prior-session candidate MUST be EXPIRED_TRADING_SESSION.

test("same-session delivery passes the final gate", () => {
  const r = revalidateBeforeDiscordSend({
    deliveryInput: {
      ...baseInput,
      tradingSessionDate: MON_SESSION,
      featureSnapshot: { higherHighs: true, higherLows: true, aboveVwap: true },
    },
    nowMs: MON,
    firstReadyAtMs: MON - 20_000,
    readyExpiresAtMs: MON + 100_000,
  }, enforceEnv);
  assert.equal(r.allowed, true);
  assert.equal(r.rejectionCode, null);
  assert.notEqual(MON_SESSION, undefined);
});

test("prior-session candidate fails with EXPIRED_TRADING_SESSION", () => {
  const priorSession = tradingDay(Date.parse("2026-07-17T10:30:00-04:00")); // the Friday before
  assert.notEqual(priorSession, MON_SESSION);
  const r = revalidateBeforeDiscordSend({
    deliveryInput: { ...baseInput, tradingSessionDate: priorSession, firstDetectedAtMs: MON - 30_000 },
    nowMs: MON,
    firstReadyAtMs: MON - 20_000,
    readyExpiresAtMs: MON + 100_000,
  }, enforceEnv);
  assert.equal(r.allowed, false);
  assert.equal(r.rejectionCode, "EXPIRED_TRADING_SESSION");
});

test("Friday candidate evaluated on Monday fails (weekend boundary)", () => {
  const friday = Date.parse("2026-07-17T15:30:00-04:00");
  const fridaySession = tradingDay(friday);
  const monday = Date.parse("2026-07-20T09:45:00-04:00");
  assert.notEqual(fridaySession, tradingDay(monday));
  const r = revalidateBeforeDiscordSend({
    deliveryInput: { ...baseInput, tradingSessionDate: fridaySession, firstDetectedAtMs: friday },
    nowMs: monday,
    firstReadyAtMs: monday - 20_000,
    readyExpiresAtMs: monday + 100_000,
  }, enforceEnv);
  assert.equal(r.allowed, false);
  assert.equal(r.rejectionCode, "EXPIRED_TRADING_SESSION");
});

test("holiday boundary fails correctly (session before a holiday, evaluated after)", () => {
  // Juneteenth 2026-06-19 (Fri) is a market holiday. A Thursday 06-18 candidate evaluated the
  // following Monday 06-22 spans the holiday and must be EXPIRED, never treated as same-session.
  const holiday = "2026-06-19";
  assert.equal(isMarketHoliday(holiday), true, "test relies on 2026-06-19 being a holiday");
  const thursday = Date.parse("2026-06-18T15:30:00-04:00");
  const monday = Date.parse("2026-06-22T10:00:00-04:00");
  const thuSession = tradingDay(thursday);
  assert.notEqual(thuSession, tradingDay(monday));
  const r = revalidateBeforeDiscordSend({
    deliveryInput: { ...baseInput, tradingSessionDate: thuSession, firstDetectedAtMs: thursday },
    nowMs: monday,
    firstReadyAtMs: monday - 20_000,
    readyExpiresAtMs: monday + 100_000,
  }, enforceEnv);
  assert.equal(r.allowed, false);
  assert.equal(r.rejectionCode, "EXPIRED_TRADING_SESSION");
});

test("DST does not change session identity incorrectly", () => {
  // US DST springs forward 2026-03-08. Two timestamps on the SAME ET calendar day (one before the
  // 2am shift, one after) must resolve to the same trading session; the next ET day must not.
  const preShift = Date.parse("2026-03-08T01:30:00-05:00");  // 01:30 EST, still 03-08 ET
  const postShift = Date.parse("2026-03-08T10:00:00-04:00"); // 10:00 EDT, same 03-08 ET
  assert.equal(tradingDay(preShift), tradingDay(postShift), "same ET day across the DST shift");
  const nextDay = Date.parse("2026-03-09T10:00:00-04:00");
  assert.notEqual(tradingDay(postShift), tradingDay(nextDay));

  // Same-session (across the DST instant) must NOT be rejected as EXPIRED…
  const same = revalidateBeforeDiscordSend({
    deliveryInput: { ...baseInput, tradingSessionDate: tradingDay(preShift), firstDetectedAtMs: preShift },
    nowMs: postShift,
    firstReadyAtMs: postShift - 20_000,
    readyExpiresAtMs: postShift + 100_000,
  }, enforceEnv);
  assert.notEqual(same.rejectionCode, "EXPIRED_TRADING_SESSION");

  // …but the next ET day must be EXPIRED.
  const cross = revalidateBeforeDiscordSend({
    deliveryInput: { ...baseInput, tradingSessionDate: tradingDay(preShift), firstDetectedAtMs: preShift },
    nowMs: nextDay,
    firstReadyAtMs: nextDay - 20_000,
    readyExpiresAtMs: nextDay + 100_000,
  }, enforceEnv);
  assert.equal(cross.rejectionCode, "EXPIRED_TRADING_SESSION");
});
