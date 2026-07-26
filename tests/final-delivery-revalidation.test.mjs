import test from "node:test";
import assert from "node:assert/strict";
import { revalidateBeforeDiscordSend, mapVerdictToDeliveryRejection } from "../lib/research/options/final-delivery-revalidation.ts";

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
  firstDetectedAtMs: Date.now() - 30_000,
  underlyingAtFirstDetection: 179.4,
  optionAtFirstDetection: 2.0,
  tradingSessionDate: "2026-07-26",
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
  const nowMs = Date.now();
  const r = revalidateBeforeDiscordSend({
    deliveryInput: baseInput,
    nowMs,
    firstReadyAtMs: nowMs - 200_000,
    readyExpiresAtMs: nowMs - 1000,
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
      featureSnapshot: { accel: -0.12, move5m: -0.4 },
    },
    nowMs: mon,
    firstReadyAtMs: mon - 10_000,
    readyExpiresAtMs: mon + 100_000,
  }, enforceEnv);
  assert.equal(r.allowed, false);
  assert.equal(r.rejectionCode, "MOMENTUM_EXHAUSTED");
});
