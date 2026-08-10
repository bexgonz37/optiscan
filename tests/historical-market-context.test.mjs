/**
 * tests/historical-market-context.test.mjs
 *
 * Regime at a historical instant, derived from stored bars.
 *
 * The distinction these tests defend is between three things a lazy implementation
 * collapses into one:
 *
 *   UNKNOWN  — we could not see the indices
 *   MIXED    — we saw them and they disagreed
 *   FLAT     — we saw them and they barely moved
 *
 * A cohort stratified on a regime that silently means "no data" is stratified on
 * nothing, and it will look like a real effect.
 *
 * Fixture is the SAME migration production runs, not a hand-copy.
 */
import "./helpers/register-alias.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { writeBarsOnDb } from "../lib/research/historical/store.ts";
import {
  deriveHistoricalMarketContext,
  persistHistoricalMarketContextOnDb,
  readHistoricalMarketContextOnDb,
} from "../lib/research/historical/market-context.ts";

const { applyProductionSchemaOnDb } = await import("@/lib/db");

const OPEN = Date.parse("2026-08-03T13:30:00.000Z");
const MIN = 60_000;
const T = OPEN + 60 * MIN;

function db() {
  const d = new Database(":memory:");
  applyProductionSchemaOnDb(d);
  return d;
}

/** `driftPct` is the total move from the open across `count` bars. */
function seedIndex(d, symbol, { driftPct = 0, base = 500, count = 61, rangePct = 0.5 } = {}) {
  const rows = [];
  const span = base * (rangePct / 100);
  for (let i = 0; i < count; i++) {
    const frac = count > 1 ? i / (count - 1) : 1;
    const c = base * (1 + (driftPct / 100) * frac);
    rows.push({
      symbol, timeframe: "1m", tsMs: OPEN + i * MIN,
      open: c, high: c + span / 2, low: c - span / 2, close: c,
      volume: 1000, vwap: base, tradeCount: 10,
    });
  }
  writeBarsOnDb(d, rows, { source: "test", nowMs: OPEN });
}

test("both indices up is RISK_ON", () => {
  const d = db();
  seedIndex(d, "SPY", { driftPct: 0.8 });
  seedIndex(d, "QQQ", { driftPct: 1.1, base: 400 });
  const c = deriveHistoricalMarketContext(d, T);
  assert.equal(c.broadDirection, "RISK_ON");
  assert.equal(c.spyTrend, "UP");
  assert.equal(c.qqqTrend, "UP");
  assert.equal(c.origin, "DERIVED_FROM_HISTORICAL_BARS", "a reconstruction always says so");
});

test("both indices down is RISK_OFF", () => {
  const d = db();
  seedIndex(d, "SPY", { driftPct: -0.9 });
  seedIndex(d, "QQQ", { driftPct: -1.4, base: 400 });
  const c = deriveHistoricalMarketContext(d, T);
  assert.equal(c.broadDirection, "RISK_OFF");
});

test("indices disagreeing is MIXED, which is not UNKNOWN", () => {
  const d = db();
  seedIndex(d, "SPY", { driftPct: 0.9 });
  seedIndex(d, "QQQ", { driftPct: -1.2, base: 400 });
  const c = deriveHistoricalMarketContext(d, T);
  assert.equal(c.broadDirection, "MIXED", "we saw them and they disagreed");
  assert.notEqual(c.broadDirection, "UNKNOWN");
  assert.deepEqual(c.missing, [], "nothing was missing; the tape was simply mixed");
});

test("absent bars are UNKNOWN and INSUFFICIENT, never a neutral-looking default", () => {
  const d = db();
  const c = deriveHistoricalMarketContext(d, T);
  assert.equal(c.broadDirection, "UNKNOWN", "we could not see them");
  assert.equal(c.quality, "INSUFFICIENT");
  assert.ok(c.missing.includes("spy") && c.missing.includes("qqq"));
  assert.equal(c.spyChangePct, null, "absent is null, never 0");
  assert.equal(c.volatilityState, "UNKNOWN");
});

test("one index present is PARTIAL, not COMPLETE", () => {
  const d = db();
  seedIndex(d, "SPY", { driftPct: 0.8 });
  const c = deriveHistoricalMarketContext(d, T);
  assert.ok(c.missing.includes("qqq"));
  assert.notEqual(c.quality, "COMPLETE");
});

test("volatility is measured session-to-date and cannot see the rest of the day", () => {
  const d = db();
  seedIndex(d, "SPY", { driftPct: 0.2, rangePct: 0.2 });
  seedIndex(d, "QQQ", { driftPct: 0.2, base: 400, rangePct: 0.2 });
  const quiet = deriveHistoricalMarketContext(d, T);
  assert.equal(quiet.volatilityState, "COMPRESSED");

  // The afternoon is violent. The morning reconstruction must not change.
  writeBarsOnDb(d, Array.from({ length: 200 }, (_, i) => ({
    symbol: "SPY", timeframe: "1m", tsMs: T + (i + 1) * MIN,
    open: 500, high: 560, low: 440, close: 550, volume: 5000, vwap: 500,
  })), { source: "test", nowMs: OPEN });

  const again = deriveHistoricalMarketContext(d, T);
  assert.deepEqual(again, quiet, "the afternoon had not happened yet at T");
});

test("a derived row and an observed row for one instant coexist", () => {
  const d = db();
  seedIndex(d, "SPY", { driftPct: 0.8 });
  seedIndex(d, "QQQ", { driftPct: 1.1, base: 400 });
  const derived = deriveHistoricalMarketContext(d, T);
  assert.equal(persistHistoricalMarketContextOnDb(d, derived, T), true);
  assert.equal(
    persistHistoricalMarketContextOnDb(d, { ...derived, origin: "OBSERVED_LIVE", broadDirection: "MIXED" }, T),
    true,
  );
  assert.equal(
    d.prepare("SELECT COUNT(*) n FROM historical_market_context").get().n,
    2,
    "origin is part of the key, so a reconstruction cannot overwrite a measurement",
  );

  // A measurement beats a reconstruction when both exist for the same instant.
  const read = readHistoricalMarketContextOnDb(d, T);
  assert.equal(read.origin, "OBSERVED_LIVE");
  assert.equal(read.broadDirection, "MIXED");
});

test("persisting the same derived row twice does not duplicate it", () => {
  const d = db();
  seedIndex(d, "SPY", { driftPct: 0.8 });
  seedIndex(d, "QQQ", { driftPct: 1.1, base: 400 });
  const c = deriveHistoricalMarketContext(d, T);
  persistHistoricalMarketContextOnDb(d, c, T);
  persistHistoricalMarketContextOnDb(d, c, T + 1000);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM historical_market_context").get().n, 1);
});

test("reading context never reaches forward past the instant", () => {
  const d = db();
  seedIndex(d, "SPY", { driftPct: 0.8 });
  seedIndex(d, "QQQ", { driftPct: 1.1, base: 400 });
  const early = deriveHistoricalMarketContext(d, T);
  persistHistoricalMarketContextOnDb(d, early, T);
  persistHistoricalMarketContextOnDb(
    d, { ...deriveHistoricalMarketContext(d, T), asOfMs: T + 3600_000, broadDirection: "RISK_OFF" }, T + 3600_000,
  );
  const read = readHistoricalMarketContextOnDb(d, T + 60_000);
  assert.equal(read.asOfMs, T, "the later row is not visible one minute after T");
  assert.equal(read.broadDirection, "RISK_ON");
});
