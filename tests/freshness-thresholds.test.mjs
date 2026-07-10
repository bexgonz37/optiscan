import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { maxAgeSecondsFor } from "../lib/data-freshness.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Phase-1 verification (2026-07-10): the observed live behavior — a 67-second
 * quote classified STALE while a 106-second one-minute candle is LIVE — is
 * INTENTIONAL per-data-type design, now locked by tests. Plus the new
 * session-aware relaxation for extended hours.
 */

test("per-data-type thresholds: quote strict, candle loose (the 67s/106s question)", () => {
  const quoteMax = maxAgeSecondsFor("stock_quote", "regular");
  const candleMax = maxAgeSecondsFor("one_minute_candle", "regular");
  assert.equal(quoteMax, 20, "quotes must be seconds-fresh in RTH");
  assert.equal(candleMax, 180, "a 1-min bar is definitionally up to ~a minute old while current");
  // 67s quote: > 3×20 → STALE. 106s candle: ≤ 180 → LIVE. Both correct.
  assert.ok(67 > quoteMax * 3, "67s quote exceeds DELAYED band → STALE");
  assert.ok(106 <= candleMax, "106s candle within LIVE band");
});

test("session-aware: extended hours relax quote freshness (quiet tape is not a failure)", () => {
  const rth = maxAgeSecondsFor("stock_quote", "regular");
  const ah = maxAgeSecondsFor("stock_quote", "afterhours");
  const pre = maxAgeSecondsFor("stock_quote", "premarket");
  assert.equal(ah, rth * 4, "after-hours multiplies the base");
  assert.equal(pre, rth * 4, "premarket multiplies the base");
  // The observed META case: 67s after-hours quote is now LIVE (≤80s), while
  // the same age in RTH stays STALE — strictness preserved where it matters.
  assert.ok(67 <= ah, "67s AH quote is LIVE under session-aware thresholds");
  assert.ok(67 > rth * 3, "67s RTH quote remains STALE");
});

test("every data kind has an explicit centralized threshold", () => {
  for (const kind of ["stock_quote", "stock_trade", "one_minute_candle", "options_chain", "options_quote", "options_trade", "greeks", "news"]) {
    const v = maxAgeSecondsFor(kind, "regular");
    assert.ok(Number.isFinite(v) && v > 0, `${kind} has a threshold (${v})`);
  }
});

test("options data has its own (stricter than candles) freshness bar", () => {
  assert.ok(maxAgeSecondsFor("options_quote", "regular") < maxAgeSecondsFor("one_minute_candle", "regular"));
});

test("provider-level status is independent of individual symbol staleness (source spec)", () => {
  const src = readFileSync(join(root, "lib/data-freshness.ts"), "utf8");
  // Provider health tracked separately from per-symbol samples: a quiet
  // after-hours symbol must never mark the provider DISCONNECTED.
  assert.ok(src.includes("recordProviderSuccess"), "provider health tracked separately");
  assert.ok(src.includes("MARKET_CLOSED"), "closed session short-circuits classification");
});
