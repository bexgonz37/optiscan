/**
 * tests/high-asymmetry-evidence.test.mjs — the evidence contract.
 *
 * Proves the three structural rules of the canonical evidence model: no future
 * evidence, no fabricated evidence, and no missing-value-becomes-zero.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAsymmetryEvidence,
  validateExecutableQuote,
  verifyOccIdentity,
  moneynessPct,
} from "../lib/research/asymmetry/evidence.ts";

// 14:00Z = 10:00 ET on a Thursday — inside the regular options session.
const T = Date.parse("2026-07-30T14:00:00Z");
const OCC = "AAPL260731C00150000";

const baseEvidence = (over = {}) => ({
  candidateId: "c1",
  symbol: "AAPL",
  direction: "bullish",
  detectionAtMs: T,
  setupFamily: "DAILY_BREAKOUT",
  underlyingPrice: 150,
  occSymbol: OCC,
  expiration: "2026-07-31",
  strike: 150,
  optionType: "call",
  dte: 1,
  bid: 1.00,
  ask: 1.10,
  quoteTimestampMs: T - 5_000,
  ...over,
});

test("evidence stamped after the candidate timestamp cannot reach the candidate", () => {
  const future = normalizeAsymmetryEvidence(baseEvidence({ quoteTimestampMs: T + 30_000 }));
  assert.equal(future.bid, null);
  assert.equal(future.ask, null);
  assert.equal(future.quoteRejection, "QUOTE_TIMESTAMP_IN_FUTURE");
  assert.equal(future.missing.ask, "EVIDENCE_FROM_FUTURE");
  assert.equal(future.evidenceComplete, false);
});

test("a stale quote cannot become executable evidence", () => {
  const stale = normalizeAsymmetryEvidence(baseEvidence({ quoteTimestampMs: T - 10 * 60_000 }));
  assert.equal(stale.quoteRejection, "QUOTE_STALE");
  assert.equal(stale.quoteFreshness, "STALE");
  assert.equal(stale.ask, null);
  assert.equal(stale.evidenceComplete, false);
});

test("a prior-session quote is refused even when it is fresh in its own session", () => {
  const yesterday = Date.parse("2026-07-29T14:00:00Z");
  const quote = validateExecutableQuote({
    atMs: yesterday, bid: 1, ask: 1.1, quoteTimestampMs: yesterday - 1_000,
    referenceAtMs: T, maxQuoteAgeMs: 60_000,
  });
  assert.equal(quote.valid, false);
  assert.equal(quote.reason, "QUOTE_FROM_DIFFERENT_SESSION");
});

test("an after-hours quote is refused", () => {
  // 01:00Z = 21:00 ET the previous evening — outside the options session.
  const afterHours = Date.parse("2026-07-31T01:00:00Z");
  const quote = validateExecutableQuote({
    atMs: afterHours, bid: 1, ask: 1.1, quoteTimestampMs: afterHours - 1_000,
    referenceAtMs: afterHours, maxQuoteAgeMs: 60_000,
  });
  assert.equal(quote.valid, false);
  assert.equal(quote.reason, "QUOTE_OUTSIDE_OPTIONS_SESSION");
});

test("an undated quote is refused rather than assumed current", () => {
  const quote = validateExecutableQuote({
    atMs: T, bid: 1, ask: 1.1, quoteTimestampMs: null, referenceAtMs: T, maxQuoteAgeMs: 60_000,
  });
  assert.equal(quote.valid, false);
  assert.equal(quote.reason, "QUOTE_TIMESTAMP_UNAVAILABLE");
});

test("a quote for a different OCC contract is refused", () => {
  const quote = validateExecutableQuote({
    occSymbol: "AAPL260731P00150000", expectedOccSymbol: OCC,
    atMs: T, bid: 1, ask: 1.1, quoteTimestampMs: T - 1_000, referenceAtMs: T, maxQuoteAgeMs: 60_000,
  });
  assert.equal(quote.valid, false);
  assert.equal(quote.reason, "QUOTE_WRONG_OCC");
});

test("an OCC symbol that disagrees with the supplied contract terms is refused", () => {
  assert.equal(verifyOccIdentity({ occSymbol: OCC, symbol: "AAPL", strike: 150, optionType: "call" }).ok, true);
  assert.equal(verifyOccIdentity({ occSymbol: OCC, symbol: "MSFT" }).ok, false, "underlying mismatch");
  assert.equal(verifyOccIdentity({ occSymbol: OCC, strike: 155 }).ok, false, "strike mismatch");
  assert.equal(verifyOccIdentity({ occSymbol: OCC, optionType: "put" }).ok, false, "right mismatch");
  assert.equal(verifyOccIdentity({ occSymbol: OCC, expiration: "2026-08-21" }).ok, false, "expiration mismatch");
  assert.equal(verifyOccIdentity({ occSymbol: "NOT-AN-OCC" }).ok, false, "unparseable");

  const mismatched = normalizeAsymmetryEvidence(baseEvidence({ strike: 155 }));
  assert.equal(mismatched.occSymbol, null);
  assert.equal(mismatched.missing.occSymbol, "OCC_UNVERIFIED");
  assert.equal(mismatched.ask, null, "an unverified contract cannot carry an executable quote");
});

test("an unsourced catalyst is rejected, never downgraded to a guess", () => {
  const unsourced = normalizeAsymmetryEvidence(baseEvidence({ catalystType: "FDA approval" }));
  assert.equal(unsourced.catalystState, "REJECTED_UNSOURCED");
  assert.equal(unsourced.catalystType, null);
  assert.equal(unsourced.missing.catalystType, "NO_NAMED_SOURCE");

  const sourced = normalizeAsymmetryEvidence(baseEvidence({ catalystType: "earnings", catalystSource: "provider:earnings-calendar" }));
  assert.equal(sourced.catalystState, "CONFIRMED");
  assert.equal(sourced.catalystType, "earnings");

  const absent = normalizeAsymmetryEvidence(baseEvidence());
  assert.equal(absent.catalystState, "ABSENT_OR_UNKNOWN");
  assert.equal(absent.catalystType, null);
});

test("greeks, relative volume, and levels require a named source", () => {
  const unsourced = normalizeAsymmetryEvidence(baseEvidence({
    delta: 0.55, gamma: 0.04,
    relativeStockVolume: 4.2,
    distanceToLevelPct: 1.5, roomToNextLevelPct: 3.0,
    relativeStrengthVsSpyPct: 2.2,
    impliedVolatility: 0.6,
  }));
  assert.equal(unsourced.delta, null);
  assert.equal(unsourced.gamma, null);
  assert.equal(unsourced.relativeStockVolume, null);
  assert.equal(unsourced.distanceToLevelPct, null);
  assert.equal(unsourced.relativeStrengthVsSpyPct, null);
  assert.equal(unsourced.impliedVolatility, null);
  assert.equal(unsourced.missing.delta, "NO_NAMED_SOURCE");
  assert.equal(unsourced.missing.relativeStockVolume, "NO_BASELINE");

  const sourced = normalizeAsymmetryEvidence(baseEvidence({
    delta: 0.55, greeksSource: "provider:chain",
    relativeStockVolume: 4.2, relativeVolumeBaselineSource: "provider:intraday-baseline",
    distanceToLevelPct: 1.5, levelSource: "daily_bars",
  }));
  assert.equal(sourced.delta, 0.55);
  assert.equal(sourced.relativeStockVolume, 4.2);
  assert.equal(sourced.distanceToLevelPct, 1.5);
});

test("volume acceleration requires an explicit bounded window", () => {
  const unbounded = normalizeAsymmetryEvidence(baseEvidence({ volumeAcceleration: 3.1 }));
  assert.equal(unbounded.volumeAcceleration, null);
  assert.equal(unbounded.missing.volumeAcceleration, "NO_BASELINE");

  const bounded = normalizeAsymmetryEvidence(baseEvidence({ volumeAcceleration: 3.1, volumeAccelerationWindowMs: 300_000 }));
  assert.equal(bounded.volumeAcceleration, 3.1);
  assert.equal(bounded.volumeAccelerationWindowMs, 300_000);
});

test("missing evidence stays missing and never becomes zero", () => {
  const sparse = normalizeAsymmetryEvidence(baseEvidence());
  const mustBeNull = [
    "stockVolume", "relativeStockVolume", "volumeAcceleration", "optionVolume", "openInterest",
    "volumeOpenInterestRatio", "impliedVolatility", "impliedVolatilityChange", "delta", "gamma",
    "distanceToLevelPct", "roomToNextLevelPct", "relativeStrengthVsSpyPct",
    "relativeStrengthVsQqqPct", "relativeStrengthVsSectorPct", "underlyingMovePctBeforeDetection",
  ];
  for (const field of mustBeNull) {
    assert.equal(sparse[field], null, `${field} must be null, not a number`);
    assert.notEqual(sparse[field], 0, `${field} must never be defaulted to 0`);
    assert.ok(sparse.missing[field], `${field} must record why it is missing`);
  }
});

test("an open interest of zero leaves the volume/OI ratio undefined, not zero or infinite", () => {
  const zeroOi = normalizeAsymmetryEvidence(baseEvidence({ optionVolume: 500, openInterest: 0 }));
  assert.equal(zeroOi.openInterest, 0, "an observed zero is a real observation and is preserved");
  assert.equal(zeroOi.volumeOpenInterestRatio, null);
  assert.equal(zeroOi.missing.volumeOpenInterestRatio, "OUT_OF_RANGE");
  assert.equal(zeroOi.liquidityState, "ILLIQUID");

  const real = normalizeAsymmetryEvidence(baseEvidence({ optionVolume: 500, openInterest: 250 }));
  assert.equal(real.volumeOpenInterestRatio, 2);
});

test("moneyness needs both sides; a missing underlying is never at-the-money", () => {
  assert.equal(moneynessPct(normalizeAsymmetryEvidence(baseEvidence({ underlyingPrice: null }))), null);
  assert.equal(moneynessPct(normalizeAsymmetryEvidence(baseEvidence({ underlyingPrice: 150 }))), 0);
  assert.equal(moneynessPct(normalizeAsymmetryEvidence(baseEvidence({ underlyingPrice: 100, strike: 110, occSymbol: "AAPL260731C00110000" }))), 10);
});

test("normalization is deterministic and does not mutate its input", () => {
  const raw = baseEvidence({ catalystType: "earnings", catalystSource: "provider:x" });
  const snapshot = structuredClone(raw);
  const first = normalizeAsymmetryEvidence(raw);
  const second = normalizeAsymmetryEvidence(raw);
  assert.deepEqual(raw, snapshot, "the raw input must be untouched");
  assert.deepEqual(first, second, "the same input must always produce the same evidence");
});
