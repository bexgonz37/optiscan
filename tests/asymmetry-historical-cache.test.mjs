/**
 * Historical cache keying and the client's truncation reporting.
 *
 * The key assertions here guard against the one failure mode a cache can have
 * that is worse than having no cache: serving one contract's data under
 * another contract's question. Nothing downstream could detect that, so it has
 * to be impossible by construction.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  historicalCacheKey, windowKey, isSettledWindow, HistoricalCache,
  PROVIDER_VERSION, DATA_VERSION, SETTLE_MARGIN_MS,
} from "../lib/research/asymmetry/historical/cache.ts";
import {
  nsToMs, quoteAsOf, extremes, sanitize,
  fetchHistoricalOptionQuotes, fetchQuoteAtInstant,
} from "../lib/research/asymmetry/historical/massive-historical.ts";
import { RequestAccountant } from "../lib/research/asymmetry/historical/request-accounting.ts";

const OCC = "O:NVDA260807C00200000";

test("cache key contains OCC, window, data type, provider version and data version", () => {
  const k = historicalCacheKey({ occ: OCC, fromMs: 1000, toMs: 2000, dataType: "QUOTES" });
  const parts = k.split("|");
  assert.equal(parts[0], OCC);
  assert.equal(parts[1], "1000-2000");
  assert.equal(parts[2], "QUOTES");
  assert.equal(parts[3], PROVIDER_VERSION);
  assert.equal(parts[4], DATA_VERSION);
});

test("changing ANY key component changes the key", () => {
  const base = { occ: OCC, fromMs: 1000, toMs: 2000, dataType: "QUOTES" };
  const k = historicalCacheKey(base);
  assert.notEqual(k, historicalCacheKey({ ...base, occ: "O:NVDA260807C00205000" }), "different contract");
  assert.notEqual(k, historicalCacheKey({ ...base, fromMs: 1001 }), "different window start");
  assert.notEqual(k, historicalCacheKey({ ...base, toMs: 2001 }), "different window end");
  assert.notEqual(k, historicalCacheKey({ ...base, dataType: "TRADES" }), "different data type");
  assert.notEqual(k, historicalCacheKey({ ...base, providerVersion: "OTHER" }), "different provider version");
  assert.notEqual(k, historicalCacheKey({ ...base, dataVersion: "OTHER" }), "different data version");
});

test("cache key is deterministic and case-normalizing on the OCC", () => {
  const a = historicalCacheKey({ occ: OCC.toLowerCase(), fromMs: 1, toMs: 2, dataType: "QUOTES" });
  const b = historicalCacheKey({ occ: OCC, fromMs: 1, toMs: 2, dataType: "QUOTES" });
  assert.equal(a, b);
});

test("cache key refuses to be built from incomplete parts", () => {
  assert.throws(() => historicalCacheKey({ occ: "", fromMs: 1, toMs: 2, dataType: "QUOTES" }), /occ is required/);
  assert.throws(() => historicalCacheKey({ occ: OCC, fromMs: NaN, toMs: 2, dataType: "QUOTES" }), /finite/);
});

test("settled windows never expire; unsettled ones respect the TTL", () => {
  const c = new HistoricalCache({ ttlMs: 1000 });
  c.put("settled", [1, 2], true, 0);
  c.put("live", [3], false, 0);
  assert.deepEqual(c.get("settled", 10_000_000), [1, 2], "settled data is immutable, so it stays");
  assert.equal(c.get("live", 5_000), undefined, "unsettled data past TTL is re-fetched");
  assert.deepEqual(c.get("live", 500), undefined, "already evicted by the previous read");
});

test("a window is settled only once it is past the correction margin", () => {
  const now = 1_000_000;
  assert.equal(isSettledWindow(now - SETTLE_MARGIN_MS - 1, now), true);
  assert.equal(isSettledWindow(now - 1, now), false, "the live tail can still be revised");
  assert.equal(isSettledWindow(now + 60_000, now), false, "a future window is never settled");
});

test("cache evicts least-recently-used past its bound", () => {
  const c = new HistoricalCache({ maxEntries: 16 });
  for (let i = 0; i < 20; i++) c.put(`k${i}`, i, true, 0);
  assert.ok(c.size <= 16, `size ${c.size} must stay bounded`);
  assert.equal(c.get("k19", 0), 19, "most recent survives");
});

test("windowKey floors to integers so a float never forks the key", () => {
  assert.equal(windowKey(1000.7, 2000.2), "1000-2000");
});

test("nanosecond provider stamps are normalized to milliseconds at the boundary", () => {
  assert.equal(nsToMs(1785418500061263000), 1785418500061);
  assert.equal(nsToMs(0), null);
  assert.equal(nsToMs(null), null);
  assert.equal(nsToMs("not a number"), null);
});

test("quoteAsOf returns the last quote at or before the instant", () => {
  const qs = [
    { atMs: 100, bid: 1, ask: 1.1, bidSize: 1, askSize: 1 },
    { atMs: 200, bid: 2, ask: 2.1, bidSize: 1, askSize: 1 },
    { atMs: 300, bid: 3, ask: 3.1, bidSize: 1, askSize: 1 },
  ];
  assert.equal(quoteAsOf(qs, 250, 1000)?.atMs, 200);
  assert.equal(quoteAsOf(qs, 300, 1000)?.atMs, 300, "inclusive at the instant");
  assert.equal(quoteAsOf(qs, 50, 1000), null, "nothing before the first quote");
});

test("quoteAsOf refuses to reach across a gap larger than tolerance", () => {
  const qs = [{ atMs: 100, bid: 1, ask: 1.1, bidSize: 1, askSize: 1 }];
  assert.equal(quoteAsOf(qs, 100 + 60_000, 120_000)?.atMs, 100, "inside tolerance");
  assert.equal(quoteAsOf(qs, 100 + 200_000, 120_000), null,
    "outside tolerance returns null — a contract with no nearby quote was not executable");
});

test("extremes ignores null and non-positive sides rather than treating them as zero", () => {
  const e = extremes([
    { atMs: 1, bid: null, ask: 2, bidSize: null, askSize: null },
    { atMs: 2, bid: 0, ask: 5, bidSize: null, askSize: null },
    { atMs: 3, bid: 1.5, ask: 3, bidSize: null, askSize: null },
  ]);
  assert.equal(e.peakAsk, 5);
  assert.equal(e.peakAskAtMs, 2);
  assert.equal(e.peakBid, 1.5, "a null and a zero bid are not bids");
  assert.equal(e.lowBid, 1.5);
});

test("extremes on an empty window reports null, never zero", () => {
  const e = extremes([]);
  assert.equal(e.peakAsk, null);
  assert.equal(e.peakBid, null);
  assert.equal(e.lowBid, null);
});

test("provider notes never echo an api key", () => {
  assert.equal(sanitize("failed https://x/y?apiKey=SECRETVALUE&z=1"), "failed https://x/y?apiKey=***&z=1");
});

// ── client behaviour against a stubbed provider ─────────────────────────────

const stub = (rows, { status = 200 } = {}) => async () => ({
  ok: status === 200, status,
  json: async () => ({ results: rows }),
  text: async () => JSON.stringify({ results: rows }),
});

const row = (tsMs, bid, ask) => ({
  sip_timestamp: tsMs * 1_000_000, bid_price: bid, ask_price: ask, bid_size: 10, ask_size: 10,
});

test("a full-limit response is reported TRUNCATED, never as a complete window", async () => {
  const accountant = new RequestAccountant();
  const rows = Array.from({ length: 3 }, (_, i) => row(1000 + i, 1, 1.1));
  const res = await fetchHistoricalOptionQuotes(OCC, 0, 10_000, {
    accountant, env: { POLYGON_API_KEY: "k" }, fetchImpl: stub(rows),
  }, { limit: 3 });
  assert.equal(res.rows.length, 3);
  assert.equal(res.truncated, true, "exactly the requested limit means the window is not covered");
  assert.match(res.outcome.note, /TRUNCATED/);
  assert.equal(res.confirmedEmpty, false);
});

test("an under-limit response is complete and not truncated", async () => {
  const accountant = new RequestAccountant();
  const res = await fetchHistoricalOptionQuotes(OCC, 0, 10_000, {
    accountant, env: { POLYGON_API_KEY: "k" }, fetchImpl: stub([row(1000, 1, 1.1)]),
  }, { limit: 5 });
  assert.equal(res.truncated, false);
  assert.equal(res.outcome.note, "OK");
});

test("an empty response is confirmedEmpty — a real absence, not a failure", async () => {
  const accountant = new RequestAccountant();
  const res = await fetchHistoricalOptionQuotes(OCC, 0, 10_000, {
    accountant, env: { POLYGON_API_KEY: "k" }, fetchImpl: stub([]),
  }, { limit: 5 });
  assert.equal(res.confirmedEmpty, true);
  assert.equal(res.outcome.ok, true);
});

test("a capped request returns PROVIDER_BUDGET_BLOCKED and issues no fetch", async () => {
  const accountant = new RequestAccountant({ ...new RequestAccountant().caps, maxHistoricalPerRun: 0 });
  let called = 0;
  const res = await fetchHistoricalOptionQuotes(OCC, 0, 10_000, {
    accountant, env: { POLYGON_API_KEY: "k" },
    fetchImpl: async () => { called += 1; throw new Error("must not be called"); },
  });
  assert.equal(called, 0, "a blocked request must never reach the network");
  assert.equal(res.outcome.ok, false);
  assert.equal(res.outcome.blocked, true);
  assert.match(res.outcome.note, /PROVIDER_BUDGET_BLOCKED/);
  assert.deepEqual(res.rows, [], "blocked means no value — never a fabricated one");
});

test("missing provider key returns no rows and issues no fetch", async () => {
  const accountant = new RequestAccountant();
  let called = 0;
  const res = await fetchHistoricalOptionQuotes(OCC, 0, 10_000, {
    accountant, env: {}, fetchImpl: async () => { called += 1; throw new Error("nope"); },
  });
  assert.equal(called, 0);
  assert.equal(res.outcome.note, "NO_PROVIDER_KEY");
});

test("a 429 is retried with backoff, then counted as rate limited", async () => {
  const accountant = new RequestAccountant({ ...new RequestAccountant().caps, maxRetries: 2, backoffBaseMs: 1 });
  let calls = 0;
  const res = await fetchHistoricalOptionQuotes(OCC, 0, 10_000, {
    accountant, env: { POLYGON_API_KEY: "k" }, sleep: async () => {},
    fetchImpl: async () => { calls += 1; return { ok: false, status: 429, text: async () => "slow down", json: async () => ({}) }; },
  });
  assert.equal(calls, 3, "initial attempt plus two retries");
  assert.equal(accountant.ledger.retries, 2);
  assert.equal(accountant.ledger.rateLimited429, 3);
  assert.equal(res.outcome.note, "RATE_LIMITED_429");
  assert.deepEqual(res.rows, []);
});

test("a cache hit is served without a second fetch and is counted", async () => {
  const accountant = new RequestAccountant();
  const cache = new (await import("../lib/research/asymmetry/historical/cache.ts")).HistoricalCache();
  let calls = 0;
  const deps = {
    accountant, cache, env: { POLYGON_API_KEY: "k" }, nowMs: () => 10_000_000,
    fetchImpl: async () => { calls += 1; return { ok: true, status: 200, json: async () => ({ results: [row(1000, 1, 1.1)] }), text: async () => "" }; },
  };
  await fetchHistoricalOptionQuotes(OCC, 0, 10_000, deps, { limit: 5 });
  const second = await fetchHistoricalOptionQuotes(OCC, 0, 10_000, deps, { limit: 5 });
  assert.equal(calls, 1, "the settled window is served from cache");
  assert.equal(second.outcome.cached, true);
  assert.equal(accountant.ledger.cacheHits, 1);
  assert.equal(accountant.ledger.cacheMisses, 1);
});

test("point-in-time query asks a descending limit-1 question and cannot be truncated wrong", async () => {
  const accountant = new RequestAccountant();
  let params = null;
  const res = await fetchQuoteAtInstant(OCC, 5_000, {
    accountant, env: { POLYGON_API_KEY: "k" },
    fetchImpl: async (url) => {
      params = url.searchParams;
      return { ok: true, status: 200, json: async () => ({ results: [row(4_900, 3.2, 3.25)] }), text: async () => "" };
    },
  }, { toleranceMs: 120_000 });
  assert.equal(params.get("order"), "desc", "must ask for the LAST quote before the instant");
  assert.equal(params.get("limit"), "1");
  assert.equal(res.quote.ask, 3.25);
  assert.equal(res.quote.atMs, 4_900);
});

test("point-in-time query returns null when the window holds no quote", async () => {
  const accountant = new RequestAccountant();
  const res = await fetchQuoteAtInstant(OCC, 5_000, {
    accountant, env: { POLYGON_API_KEY: "k" },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ results: [] }), text: async () => "" }),
  });
  assert.equal(res.quote, null, "no quote near the instant means not executable — never a substitute");
});
