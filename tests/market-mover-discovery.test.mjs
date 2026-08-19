/**
 * tests/market-mover-discovery.test.mjs
 *
 * THE PROPERTY UNDER TEST is the 2026-08-19 coverage gap: MRNA gapped
 * premarket, opened around +84%, ran to +133% on ~$2.3B, and OptiScan produced
 * NO record of it anywhere — while MRNY, the leveraged ETF on it, WAS scanned
 * at +125.8%. The system saw the derivative and not the underlying, because
 * broad discovery admits $0.50-$50 and MRNA opened at $116.
 *
 * Measured against the live snapshot at 10:55 ET that morning: 67 movers >=
 * +10% passed the floor with the $50 ceiling, 78 without it, so 11 movers —
 * including the two largest in the market — were invisible to every lane
 * outside the curated list.
 *
 * The assertions below pin the separation that fixes it (observation eligibility
 * is not trading eligibility), and equally pin what must NOT happen: this layer
 * has no live authority and invents no feature it cannot observe.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MARKET_DISCOVERY,
  marketDiscoveryConfig,
  marketDiscoveryEligible,
  moverVelocityPctPerMin,
  rangeExpansionPctOf,
  rankMarketMovers,
  spreadPctOf,
} from "../lib/research/discovery/market-movers.ts";
import { broadStockEligibility } from "../lib/stock-momentum-policy.ts";
import {
  ensureMarketMoverSchema,
  getMarketMoverOnDb,
  listMarketMoversOnDb,
  recordMarketMoversOnDb,
} from "../lib/research/discovery/mover-store.ts";
import {
  __resetMoverRecorderForTest,
  recordMarketMoverCycle,
} from "../lib/research/discovery/mover-recorder.ts";

let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch { Database = null; }
const skip = Database ? false : "better-sqlite3 unavailable";

const NOW = Date.parse("2026-08-19T13:45:00Z"); // 09:45 ET
const SESSION = "2026-08-19";

/** MRNA as the snapshot actually reported it that morning. */
const MRNA = {
  symbol: "MRNA", price: 146.93, changePercent: 133.37, volume: 91_865_992,
  dayHigh: 149.63, dayLow: 112.0, prevClose: 62.96, bid: 146.90, ask: 146.96,
};
/** MRNY, the leveraged ETF that WAS scanned, under the ceiling. */
const MRNY = {
  symbol: "MRNY", price: 12.4, changePercent: 124.5, volume: 40_000_000,
  dayHigh: 12.9, dayLow: 6.0, prevClose: 5.52, bid: 12.39, ask: 12.41,
};

test("an MRNA-shaped mover over $50 is DISCOVERABLE, while the trading gate still rejects it", () => {
  // The trading lane's answer is unchanged — this is the gate that must keep its ceiling.
  const trading = broadStockEligibility({
    symbol: MRNA.symbol, price: MRNA.price, dayVolume: MRNA.volume, gainFromPrevClosePct: MRNA.changePercent,
  });
  assert.equal(trading.ok, false, "the stock-momentum trading lane still refuses it");
  assert.equal(trading.failedGate, "price");
  assert.match(trading.reason, /outside \$0\.5-50/);

  // The OBSERVATION answer is different, which is the entire point.
  const discovery = marketDiscoveryEligible(MRNA);
  assert.equal(discovery.eligible, true, "but it is discoverable");
  assert.deepEqual(discovery.rejections, []);
});

test("the derivative no longer outranks the underlying it derives from", () => {
  const ranked = rankMarketMovers([MRNY, MRNA], new Map(), NOW);
  const symbols = ranked.map((r) => r.symbol);
  assert.deepEqual(symbols.slice(0, 2).sort(), ["MRNA", "MRNY"], "both are now visible at all");
  assert.equal(ranked[0].symbol, "MRNA", "and the bigger, deeper move ranks first");
  assert.ok(ranked[0].extreme);
});

test("no price ceiling exists anywhere in discovery eligibility", () => {
  for (const price of [1, 50, 50.01, 116, 500, 5000]) {
    const q = { symbol: "X", price, changePercent: 40, volume: 10_000_000 };
    assert.equal(marketDiscoveryEligible(q).eligible, true, `price ${price} must be discoverable`);
  }
  // The FLOOR still exists — a sub-dollar print is noise, not a market.
  assert.deepEqual(
    marketDiscoveryEligible({ symbol: "X", price: 0.4, changePercent: 90, volume: 100_000_000 }).rejections,
    ["price_below_floor"],
  );
});

test("this is not a whole-market dump — liquidity and move floors still bind", () => {
  const quiet = { symbol: "QUIET", price: 100, changePercent: 0.5, volume: 50_000_000 };
  assert.deepEqual(marketDiscoveryEligible(quiet).rejections, ["move_below_floor"]);

  const illiquid = { symbol: "THIN", price: 100, changePercent: 90, volume: 500 };
  assert.deepEqual(marketDiscoveryEligible(illiquid).rejections, ["insufficient_dollar_volume"]);

  // A realistic snapshot must reduce to a handful, not thousands.
  const market = Array.from({ length: 13_132 }, (_, i) => ({
    symbol: `S${i}`, price: 20 + (i % 300), changePercent: (i % 7) - 3, volume: 100_000 + i,
  }));
  const ranked = rankMarketMovers([...market, MRNA, MRNY], new Map(), NOW);
  assert.ok(ranked.length < 50, `expected a shortlist, got ${ranked.length}`);
  assert.ok(ranked.some((r) => r.symbol === "MRNA"));
});

test("a merely-large name never outranks a moving one", () => {
  const mega = { symbol: "MEGA", price: 250, changePercent: 11, volume: 80_000_000 }; // $20B
  const runner = { symbol: "RUN", price: 8, changePercent: 95, volume: 2_000_000 };   // $16M
  const ranked = rankMarketMovers([mega, runner], new Map(), NOW);
  assert.equal(ranked[0].symbol, "RUN", "the liquidity term breaks ties, it does not drive the ranking");
});

test("a big DOWN move is discovered exactly like a big up move", () => {
  const down = { symbol: "DOWN", price: 40, changePercent: -52, volume: 5_000_000 };
  assert.equal(marketDiscoveryEligible(down).eligible, true);
  const ranked = rankMarketMovers([down, { symbol: "UP", price: 40, changePercent: 30, volume: 5_000_000 }], new Map(), NOW);
  assert.equal(ranked[0].symbol, "DOWN", "observation must not be long-biased; puts are opportunities too");
});

test("no feature is invented when the snapshot cannot support it", () => {
  // No relative volume anywhere in the output — there is no baseline to compute it from.
  const ranked = rankMarketMovers([MRNA], new Map(), NOW);
  assert.ok(!("relativeVolume" in ranked[0]), "RVOL must not appear without a baseline");
  assert.ok(!("rvol" in ranked[0]));

  // Missing quote sides yield null, never a fabricated spread.
  assert.equal(spreadPctOf({ symbol: "X", price: 1, changePercent: 1, volume: 1 }), null);
  assert.equal(spreadPctOf({ symbol: "X", price: 1, changePercent: 1, volume: 1, bid: 5, ask: 4 }), null, "crossed is not a spread");
  assert.ok(Math.abs(spreadPctOf(MRNA) - 0.041) < 0.01);

  // Missing OHLC yields null range expansion.
  assert.equal(rangeExpansionPctOf({ symbol: "X", price: 1, changePercent: 1, volume: 1 }), null);
  assert.ok(rangeExpansionPctOf(MRNA) > 0);

  // Velocity is null on first sight and on a stale prior — never zero-filled.
  assert.equal(moverVelocityPctPerMin(50, undefined, NOW), null);
  assert.equal(moverVelocityPctPerMin(50, { changePercent: 40, atMs: NOW - 10 * 60_000 }, NOW), null, "a 10-minute-old prior is not a delta");
  assert.equal(moverVelocityPctPerMin(50, { changePercent: 40, atMs: NOW - 60_000 }, NOW), 10);
});

test("ranking is reproducible — input order cannot change the result", () => {
  const rows = [
    { symbol: "BBB", price: 10, changePercent: 30, volume: 5_000_000 },
    { symbol: "AAA", price: 10, changePercent: 30, volume: 5_000_000 },
    { symbol: "CCC", price: 10, changePercent: 30, volume: 9_000_000 },
  ];
  const a = rankMarketMovers(rows, new Map(), NOW).map((r) => r.symbol);
  const b = rankMarketMovers([...rows].reverse(), new Map(), NOW).map((r) => r.symbol);
  assert.deepEqual(a, b);
  assert.deepEqual(a, ["CCC", "AAA", "BBB"]);
});

test("first observation is immutable; only the peak advances", { skip }, () => {
  const db = new Database(":memory:");
  ensureMarketMoverSchema(db);
  const early = rankMarketMovers([{ ...MRNA, changePercent: 84.0 }], new Map(), NOW);
  recordMarketMoversOnDb(db, [{ sessionDate: SESSION, sessionPhase: "regular", mover: early[0], atMs: NOW }]);

  const later = rankMarketMovers([MRNA], new Map(), NOW + 20 * 60_000);
  recordMarketMoversOnDb(db, [{ sessionDate: SESSION, sessionPhase: "regular", mover: later[0], atMs: NOW + 20 * 60_000 }]);

  const rowNow = getMarketMoverOnDb(db, SESSION, "MRNA");
  assert.equal(rowNow.firstObservedAtMs, NOW, "the first observation instant never moves");
  assert.ok(Math.abs(rowNow.firstMovePct - 84.0) < 0.01, "nor the move it was first seen at");
  assert.ok(Math.abs(rowNow.peakAbsMovePct - 133.37) < 0.01, "but the peak advances");
  assert.equal(rowNow.peakObservedAtMs, NOW + 20 * 60_000);
  assert.equal(rowNow.observations, 2);
  db.close();
});

test("a symbol OptiScan never admitted still becomes durable evidence", { skip }, () => {
  __resetMoverRecorderForTest();
  const db = new Database(":memory:");
  // The scanner's own universe never contained MRNA. The recorder is handed the
  // RAW snapshot, so the record exists regardless.
  const res = recordMarketMoverCycle([MRNA, MRNY, { symbol: "KO", price: 60, changePercent: 0.2, volume: 5_000_000 }], {
    nowMs: NOW, sessionDate: SESSION, sessionPhase: "regular", getDb: () => db, env: {},
  });
  assert.equal(res.ran, true);
  assert.equal(res.ranked, 2, "KO is not a mover");
  assert.ok(res.recorded >= 2);

  const listed = listMarketMoversOnDb(db, SESSION, { limit: 10 });
  assert.deepEqual(listed.map((r) => r.symbol), ["MRNA", "MRNY"]);
  assert.equal(listed[0].firstObservedPhase, "regular");
  db.close();
});

test("the recorder is inert when switched off, and never throws on a broken db", { skip }, () => {
  __resetMoverRecorderForTest();
  const off = recordMarketMoverCycle([MRNA], {
    nowMs: NOW, sessionDate: SESSION, sessionPhase: "regular", getDb: () => null,
    env: { MARKET_MOVER_OBSERVATION: "0" },
  });
  assert.equal(off.ran, false);
  assert.equal(off.reason, "MARKET_MOVER_OBSERVATION=0");

  __resetMoverRecorderForTest();
  const broken = recordMarketMoverCycle([MRNA], {
    nowMs: NOW, sessionDate: SESSION, sessionPhase: "regular",
    getDb: () => { throw new Error("db exploded"); }, env: {},
  });
  assert.equal(broken.recorded, 0, "a database failure is absorbed, not propagated");
  assert.ok(broken.reason);
});

test("config is env-overridable and the defaults are the documented ones", () => {
  assert.deepEqual(marketDiscoveryConfig({}), DEFAULT_MARKET_DISCOVERY);
  assert.equal(marketDiscoveryConfig({ MARKET_DISCOVERY_MIN_MOVE_PCT: "20" }).minMovePct, 20);
  assert.equal(DEFAULT_MARKET_DISCOVERY.minPrice, 1);
  assert.equal(Object.hasOwn(DEFAULT_MARKET_DISCOVERY, "maxPrice"), false, "there is no ceiling to configure");
});
