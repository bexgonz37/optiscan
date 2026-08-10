/**
 * tests/historical-replay-fencing.test.mjs — THE HINDSIGHT HARNESS.
 *
 * Every test here has the same shape and it is the only shape that proves anything:
 *
 *   1. reconstruct state at time T
 *   2. add or mutate data STRICTLY AFTER T
 *   3. reconstruct at T again
 *   4. assert the two results are byte-identical
 *
 * Asserting "the replay looks right" proves nothing — a leaking replay also looks
 * right, and looks better. Only the invariance check can distinguish them, because a
 * leak is by definition a dependency on data that was not there yet.
 *
 * The specific leaks these target, all of which have shipped in real backtests:
 *   · a later bar widening the session range used to size "move consumed"
 *   · the day's FINAL high/low standing in for the running high/low
 *   · a later quote becoming the entry price
 *   · the realized outcome reaching a decision-time classification
 *
 * Fixture is the SAME migration production runs, not a hand-copy.
 */
import "./helpers/register-alias.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  writeBarsOnDb,
  writeOptionQuotesOnDb,
  writeOptionTradesOnDb,
  writeContractReferenceOnDb,
} from "../lib/research/historical/store.ts";
import {
  replayBarsOnDb,
  replayUnderlyingStateOnDb,
  replayContractStateOnDb,
  replayQuoteAsOfOnDb,
  forwardExcursionOnDb,
} from "../lib/research/historical/replay.ts";

const { applyProductionSchemaOnDb } = await import("@/lib/db");

// 2026-08-03 13:30Z = 09:30 ET open.
const OPEN = Date.parse("2026-08-03T13:30:00.000Z");
const MIN = 60_000;
const T = OPEN + 30 * MIN;          // the decision instant
const OCC = "O:NVDA260807C00180000";
const SRC = "test";

function db() {
  const d = new Database(":memory:");
  applyProductionSchemaOnDb(d);
  return d;
}

/** Bars from the open, one per minute, rising gently. */
function seedBars(d, { from = OPEN, count = 30, base = 100, step = 0.05, vol = 1000 } = {}) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const c = base + i * step;
    rows.push({
      symbol: "NVDA", timeframe: "1m", tsMs: from + i * MIN,
      open: c - step / 2, high: c + 0.02, low: c - 0.02, close: c,
      volume: vol, vwap: c, tradeCount: 10,
    });
  }
  return writeBarsOnDb(d, rows, { source: SRC, nowMs: OPEN });
}

function seedQuotes(d, pairs) {
  return writeOptionQuotesOnDb(
    d,
    pairs.map(([tsMs, bid, ask]) => ({ occ: OCC, tsMs, bid, ask })),
    { source: SRC, nowMs: OPEN },
  );
}

function seedRef(d) {
  return writeContractReferenceOnDb(d, [{
    occ: OCC, underlying: "NVDA", side: "call", strike: 180, expiration: "2026-08-07",
  }], { source: SRC, nowMs: OPEN });
}

// ── the store itself ─────────────────────────────────────────────────────────

test("re-ingesting the same window writes nothing the second time", () => {
  const d = db();
  const first = seedBars(d);
  assert.equal(first.written, 30);
  const second = seedBars(d);
  assert.equal(second.written, 0, "identity is the primary key, so a re-run is a no-op");
  assert.equal(second.skipped, 30);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM historical_underlying_bars").get().n, 30);
});

test("option quotes and trades dedupe independently and never share a table", () => {
  const d = db();
  seedQuotes(d, [[T - MIN, 2.0, 2.1], [T, 2.05, 2.15]]);
  seedQuotes(d, [[T - MIN, 2.0, 2.1], [T, 2.05, 2.15]]);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM historical_option_quotes").get().n, 2);

  // Two prints in the SAME millisecond must both survive — they are distinct events.
  writeOptionTradesOnDb(d, [
    { occ: OCC, tsMs: T, price: 2.1, size: 5 },
    { occ: OCC, tsMs: T, price: 2.12, size: 3 },
  ], { source: SRC, nowMs: OPEN });
  assert.equal(d.prepare("SELECT COUNT(*) n FROM historical_option_trades").get().n, 2);

  // ...and re-ingesting that same batch must still collide rather than double.
  writeOptionTradesOnDb(d, [
    { occ: OCC, tsMs: T, price: 2.1, size: 5 },
    { occ: OCC, tsMs: T, price: 2.12, size: 3 },
  ], { source: SRC, nowMs: OPEN });
  assert.equal(
    d.prepare("SELECT COUNT(*) n FROM historical_option_trades").get().n,
    2,
    "seq is assigned deterministically per (occ, ts) so a replayed batch produces the same keys",
  );
});

// ── the fence ────────────────────────────────────────────────────────────────

test("bars after T are invisible at T", () => {
  const d = db();
  seedBars(d, { count: 31 }); // through T
  const before = replayBarsOnDb(d, "NVDA", { asOfMs: T });
  assert.equal(before.length, 31);

  // The rest of the session arrives.
  seedBars(d, { from: T + MIN, count: 300, base: 200, step: 1 });
  const after = replayBarsOnDb(d, "NVDA", { asOfMs: T });
  assert.deepEqual(after, before, "300 later bars changed nothing about the view at T");
});

test("the day's FINAL high cannot become the session high at T", () => {
  const d = db();
  seedBars(d, { count: 31 });
  const atT = replayUnderlyingStateOnDb(d, "NVDA", T);
  assert.ok(atT.sessionHigh != null && atT.sessionHigh < 103, "the range through T is small");

  // The stock doubles after T. This is the single most seductive leak in a backtest:
  // the final HOD is exactly what makes "share of the move consumed" look precise.
  seedBars(d, { from: T + MIN, count: 200, base: 100, step: 1 });
  const again = replayUnderlyingStateOnDb(d, "NVDA", T);

  assert.deepEqual(again, atT, "reconstruction at T is byte-identical after the future arrives");
  assert.equal(again.sessionHigh, atT.sessionHigh);
  assert.ok(again.sessionHigh < 103, "session extremes are SESSION-TO-DATE, never the day's final");
});

test("a later quote cannot become the quote in force at T", () => {
  const d = db();
  seedQuotes(d, [[T - 30_000, 2.0, 2.1]]);
  const q1 = replayQuoteAsOfOnDb(d, OCC, { asOfMs: T });
  assert.equal(q1.ask, 2.1);

  seedQuotes(d, [[T + 1000, 9.0, 9.5], [T + 60_000, 20, 21]]);
  const q2 = replayQuoteAsOfOnDb(d, OCC, { asOfMs: T });
  assert.deepEqual(q2, q1, "the +900% quote one second later is not the quote at T");
});

test("no quote within tolerance yields null, never the nearest one", () => {
  const d = db();
  // The only quote is an hour stale, and a fresh one exists just after T.
  seedQuotes(d, [[T - 3600_000, 2.0, 2.1], [T + 1000, 5.0, 5.2]]);
  assert.equal(
    replayQuoteAsOfOnDb(d, OCC, { asOfMs: T, maxStalenessMs: 5 * 60_000 }),
    null,
    "a contract with no quote near the instant was not executable then",
  );
});

test("contract economics at T do not move when the future is written", () => {
  const d = db();
  seedBars(d, { count: 31 });
  seedRef(d);
  seedQuotes(d, [[T - 10_000, 2.0, 2.1]]);
  const before = replayContractStateOnDb(d, OCC, T, { underlyingPrice: 101.5 });
  assert.equal(before.executableAsk, 2.1);
  assert.equal(before.side, "call");
  assert.equal(before.dte, 4);

  seedQuotes(d, [[T + 5_000, 12, 12.5], [T + 900_000, 30, 31]]);
  seedBars(d, { from: T + MIN, count: 120, base: 150, step: 0.5 });
  const after = replayContractStateOnDb(d, OCC, T, { underlyingPrice: 101.5 });
  assert.deepEqual(after, before);
});

test("a trade print is never substituted for an executable quote", () => {
  const d = db();
  seedRef(d);
  // Trades exist at T; NBBO does not.
  writeOptionTradesOnDb(d, [
    { occ: OCC, tsMs: T - 5_000, price: 2.4, size: 10 },
    { occ: OCC, tsMs: T - 1_000, price: 2.45, size: 4 },
  ], { source: SRC, nowMs: OPEN });

  const s = replayContractStateOnDb(d, OCC, T, { underlyingPrice: 101.5 });
  assert.equal(s.executableAsk, null, "someone traded there; that is not proof we could have");
  assert.ok(s.missing.includes("executableQuote"));
  assert.equal(s.evidenceStrength, "INSUFFICIENT");
});

test("missing bars fail closed rather than producing a confident empty state", () => {
  const d = db();
  const s = replayUnderlyingStateOnDb(d, "NVDA", T);
  assert.equal(s.evidenceStrength, "INSUFFICIENT");
  assert.ok(s.missing.includes("bars"));
  assert.equal(s.price, null, "absent is null, never 0");
  assert.equal(s.sessionHigh, null);
  assert.equal(s.compressionPct, null);
});

test("a different symbol's bars cannot leak into this symbol's state", () => {
  const d = db();
  seedBars(d, { count: 31 });
  const before = replayUnderlyingStateOnDb(d, "NVDA", T);
  writeBarsOnDb(d, Array.from({ length: 60 }, (_, i) => ({
    symbol: "AMD", timeframe: "1m", tsMs: OPEN + i * MIN,
    open: 500, high: 900, low: 100, close: 800, volume: 99999, vwap: 800,
  })), { source: SRC, nowMs: OPEN });
  assert.deepEqual(replayUnderlyingStateOnDb(d, "NVDA", T), before);
});

test("settledOnly excludes the bar still forming at T", () => {
  const d = db();
  seedBars(d, { count: 31 }); // last bar OPENS at exactly T
  const all = replayBarsOnDb(d, "NVDA", { asOfMs: T });
  const settled = replayBarsOnDb(d, "NVDA", { asOfMs: T, settledOnly: true });
  assert.equal(all.length, 31);
  assert.equal(settled.length, 30, "a bar that opened at T had not closed at T");
  assert.ok(settled[settled.length - 1].tsMs < T);
});

// ── the one place hindsight is allowed ───────────────────────────────────────

test("forward excursion measures AFTER T, from the ask at T", () => {
  const d = db();
  seedQuotes(d, [
    [T - 1_000, 2.0, 2.1],        // entry: ask 2.10
    [T + 5 * MIN, 2.4, 2.5],      // mid 2.45 → +16.7%
    [T + 12 * MIN, 3.1, 3.3],     // mid 3.20 → +52.4%
    [T + 30 * MIN, 1.0, 1.1],     // mid 1.05 → −50%
  ]);
  const f = forwardExcursionOnDb(d, OCC, { fromMs: T, toMs: T + 60 * MIN });
  assert.equal(f.entry, 2.1);
  assert.equal(f.quotesUsed, 3, "only quotes strictly after T are measured");
  assert.ok(f.mfePct > 52 && f.mfePct < 53);
  assert.ok(f.maePct < -49);
  assert.equal(f.msToMilestone["50"], 12 * MIN, "time-to-milestone is measured from T");
  assert.equal(f.msToMilestone["100"], null, "never reached is null, not 0");
});

test("forward excursion refuses when no executable entry existed at T", () => {
  const d = db();
  seedQuotes(d, [[T + MIN, 5.0, 5.2], [T + 10 * MIN, 20, 21]]);
  const f = forwardExcursionOnDb(d, OCC, { fromMs: T, toMs: T + 60 * MIN });
  assert.equal(f.entry, null);
  assert.equal(f.mfePct, null, "a +300% move from an entry that never existed is not a result");
  assert.equal(f.quotesUsed, 0);
});

test("the forward window cannot reach past its own end", () => {
  const d = db();
  seedQuotes(d, [[T - 1_000, 2.0, 2.1], [T + 5 * MIN, 2.4, 2.5], [T + 120 * MIN, 40, 41]]);
  const f = forwardExcursionOnDb(d, OCC, { fromMs: T, toMs: T + 60 * MIN });
  assert.equal(f.quotesUsed, 1);
  assert.ok(f.mfePct < 20, "the +1800% print two hours later is outside the window");
});
