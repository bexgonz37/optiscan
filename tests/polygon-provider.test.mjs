import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSnapshotTickers,
  parseAggregates,
  parseOptionsSnapshot,
  fetchOptionChain,
  normalizeDayChangePercent,
  isRecapNoiseSymbol,
} from "../lib/polygon-provider.js";

test("normalizeDayChangePercent uses session move when prev close is a spin-off stub", () => {
  const pct = normalizeDayChangePercent({
    price: 36.6,
    dayOpen: 35.5,
    prevClose: 6.59,
    changePercent: 455.39,
  });
  assert.ok(Math.abs(pct - 3.1) < 0.15);
});

test("normalizeDayChangePercent keeps regular prev-close day change", () => {
  const pct = normalizeDayChangePercent({
    price: 13.84,
    dayOpen: 9.59,
    prevClose: 7,
    changePercent: 107.86,
  });
  assert.ok(Math.abs(pct - 97.71) < 0.2);
});

test("isRecapNoiseSymbol flags warrants and class shares", () => {
  assert.equal(isRecapNoiseSymbol("ONFOW", 0.02), true);
  assert.equal(isRecapNoiseSymbol("TE.WS", 0.01), true);
  assert.equal(isRecapNoiseSymbol("CLRO", 14.55), false);
  assert.equal(isRecapNoiseSymbol("MFP", 36.6), false);
});

test("parseSnapshotTickers uses session close for day change when last trade is extended", () => {
  const [clro] = parseSnapshotTickers([
    {
      ticker: "CLRO",
      lastTrade: { p: 14.55 },
      day: { o: 9.59, c: 13.84, v: 1e7 },
      prevDay: { c: 7 },
      todaysChangePerc: 107.86,
    },
  ]);
  assert.ok(Math.abs(clro.changePercent - 97.71) < 0.2);
  assert.equal(clro.price, 14.55);
});

test("parseSnapshotTickers normalizes and falls back through price sources", () => {
  const out = parseSnapshotTickers([
    { ticker: "aapl", lastTrade: { p: 190.5 }, day: { o: 188, v: 1e6 }, prevDay: { c: 188.2 }, todaysChangePerc: 1.2, todaysChange: 2.3 },
    { ticker: "MSFT", min: { c: 410, av: 5e5 }, day: {} },
    { notATicker: true },
    null,
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].symbol, "AAPL");
  assert.equal(out[0].price, 190.5);
  assert.ok(Math.abs(out[0].changePercent - 1.22) < 0.1);
  assert.equal(out[1].price, 410); // min.c fallback
});

test("parseAggregates maps OHLCV and tolerates junk", () => {
  assert.deepEqual(parseAggregates(null), []);
  assert.deepEqual(parseAggregates({ results: "nope" }), []);
  const [bar] = parseAggregates({ results: [{ t: 1, o: 2, h: 3, l: 1.5, c: 2.5, v: 100 }] });
  assert.deepEqual(bar, { t: 1, o: 2, h: 3, l: 1.5, c: 2.5, v: 100 });
});

test("parseOptionsSnapshot: mid from bid/ask, spreadPct, dte", () => {
  const now = Date.parse("2026-07-05T00:00:00Z");
  const [c] = parseOptionsSnapshot(
    {
      results: [
        {
          details: { ticker: "O:X", contract_type: "CALL", strike_price: 100, expiration_date: "2026-07-15" },
          last_quote: { bid: 1.0, ask: 1.2 },
          day: { volume: 500, close: 1.1 },
          open_interest: 900,
          implied_volatility: 0.5,
          greeks: { delta: 0.4 },
          underlying_asset: { price: 98 },
        },
      ],
    },
    now,
  );
  assert.equal(c.side, "call");
  assert.equal(c.mid, 1.1);
  assert.equal(c.spreadPct, 18.18);
  assert.equal(c.dte, 10);
  assert.equal(c.openInterest, 900);
});

test("fetchOptionChain paginates via next_url up to maxPages", async (t) => {
  process.env.POLYGON_API_KEY = "test-key";
  const exp = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  const mkResult = (ticker) => ({
    details: { ticker, contract_type: "call", strike_price: 100, expiration_date: exp },
    last_quote: { bid: 1, ask: 1.1 },
    day: { volume: 10 },
    open_interest: 50,
  });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    const u = String(url);
    calls.push(u);
    const page = u.includes("cursor=2")
      ? { results: [mkResult("O:PAGE2")], next_url: "https://api.polygon.io/v3/snapshot/options/TST?cursor=3" }
      : u.includes("cursor=3")
        ? { results: [mkResult("O:PAGE3")] }
        : { results: [mkResult("O:PAGE1")], next_url: "https://api.polygon.io/v3/snapshot/options/TST?cursor=2" };
    return { ok: true, json: async () => page };
  });

  const res = await fetchOptionChain("TST", { dteMin: 3, dteMax: 45 });
  assert.equal(res.available, true);
  assert.deepEqual(
    res.contracts.map((c) => c.optionSymbol),
    ["O:PAGE1", "O:PAGE2", "O:PAGE3"],
  );
  assert.equal(calls.length, 3);
  // every request (incl. next_url pages) must carry the API key
  assert.ok(calls.every((u) => u.includes("apiKey=test-key")));

  // page cap respected
  const capped = await fetchOptionChain("TST", { dteMin: 3, dteMax: 45, maxPages: 2 });
  assert.deepEqual(
    capped.contracts.map((c) => c.optionSymbol),
    ["O:PAGE1", "O:PAGE2"],
  );
});

test("fetchOptionChain surfaces provider errors as available:false", async (t) => {
  process.env.POLYGON_API_KEY = "test-key";
  t.mock.method(globalThis, "fetch", async () => ({
    ok: false,
    status: 429,
    text: async () => "rate limit",
  }));
  const res = await fetchOptionChain("TST");
  assert.equal(res.available, false);
  assert.match(res.note, /429/);
  assert.match(res.note, /rate limited/);
  assert.deepEqual(res.contracts, []);
});
