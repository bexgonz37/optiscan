import test from "node:test";
import assert from "node:assert/strict";
import {
  recordPolygonCall,
  getCallStats,
  __resetCallStatsForTest,
  QuotaExceededError,
  fetchBulkQuotes,
  fetchOptionContractSnapshot,
} from "../lib/polygon-provider.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
  __resetCallStatsForTest();
}

test("meter counts calls per day and per minute", () => {
  resetEnv();
  recordPolygonCall(1_000_000);
  recordPolygonCall(1_000_500);
  const stats = getCallStats(1_000_500);
  assert.equal(stats.callsToday, 2);
  assert.equal(stats.callsThisMinute, 2);
  assert.equal(stats.quotaExceeded, false);
  resetEnv();
});

test("minute bucket resets on the next minute; day count persists", () => {
  resetEnv();
  recordPolygonCall(1_000_000);
  recordPolygonCall(1_000_000 + 61_000); // next minute bucket
  const stats = getCallStats(1_000_000 + 61_000);
  assert.equal(stats.callsToday, 2);
  assert.equal(stats.callsThisMinute, 1);
  resetEnv();
});

test("daily count resets when the ET trading day rolls over", () => {
  resetEnv();
  // 2026-07-06 12:00 ET vs 2026-07-07 12:00 ET
  const day1 = Date.parse("2026-07-06T12:00:00-04:00");
  const day2 = Date.parse("2026-07-07T12:00:00-04:00");
  recordPolygonCall(day1);
  recordPolygonCall(day1 + 1000);
  recordPolygonCall(day2);
  const stats = getCallStats(day2);
  assert.equal(stats.callsToday, 1);
  assert.equal(stats.tradingDay, "2026-07-07");
  resetEnv();
});

test("minute cap throws typed quota_exceeded and refuses the call", () => {
  resetEnv();
  process.env.POLYGON_MINUTE_CALL_CAP = "2";
  const t = 5_000_000;
  recordPolygonCall(t);
  recordPolygonCall(t + 100);
  assert.throws(
    () => recordPolygonCall(t + 200),
    (err) => err instanceof QuotaExceededError && err.code === "quota_exceeded" && err.kind === "minute",
  );
  const stats = getCallStats(t + 300);
  assert.equal(stats.callsThisMinute, 2, "refused call must not be counted as spend");
  assert.equal(stats.quotaExceeded, true);
  assert.equal(stats.quotaExceededCount, 1);
  resetEnv();
});

test("daily cap throws typed quota_exceeded with kind=daily", () => {
  resetEnv();
  process.env.POLYGON_DAILY_CALL_CAP = "1";
  process.env.POLYGON_MINUTE_CALL_CAP = "0"; // disabled
  const t = 6_000_000;
  recordPolygonCall(t);
  assert.throws(
    () => recordPolygonCall(t + 100),
    (err) => err instanceof QuotaExceededError && err.kind === "daily",
  );
  resetEnv();
});

test("cap of 0 disables that cap", () => {
  resetEnv();
  process.env.POLYGON_MINUTE_CALL_CAP = "0";
  process.env.POLYGON_DAILY_CALL_CAP = "0";
  const t = 7_000_000;
  for (let i = 0; i < 500; i++) recordPolygonCall(t + i);
  assert.equal(getCallStats(t + 500).callsToday, 500);
  resetEnv();
});

test("fetchBulkQuotes surfaces quota_exceeded as available:false (loop backs off like 429)", async () => {
  resetEnv();
  process.env.POLYGON_API_KEY = "test-key";
  process.env.POLYGON_MINUTE_CALL_CAP = "1";
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ tickers: [] }) });

  const first = await fetchBulkQuotes(["SPY"]);
  assert.equal(first.available, true);

  const second = await fetchBulkQuotes(["SPY"]);
  assert.equal(second.available, false);
  assert.match(String(second.note), /quota_exceeded/);
  resetEnv();
});

test("quota guard fires BEFORE the network request", async () => {
  resetEnv();
  process.env.POLYGON_API_KEY = "test-key";
  process.env.POLYGON_MINUTE_CALL_CAP = "1";
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return { ok: true, json: async () => ({ tickers: [] }) };
  };
  await fetchBulkQuotes(["SPY"]);
  await fetchBulkQuotes(["SPY"]); // refused by meter
  assert.equal(fetches, 1, "capped call must never reach the network");
  resetEnv();
});

test("exact OCC snapshots reuse one bounded-TTL provider response", async () => {
  resetEnv();
  process.env.POLYGON_API_KEY = "test-key";
  process.env.POLYGON_MINUTE_CALL_CAP = "0";
  process.env.POLYGON_DAILY_CALL_CAP = "0";
  process.env.OPTIONS_EXACT_QUOTE_CACHE_TTL_MS = "5000";
  const occ = "O:SPY260807C00600000";
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return exactOccResponse(occ);
  };

  const first = await fetchOptionContractSnapshot("SPY", occ);
  const second = await fetchOptionContractSnapshot("SPY", occ);

  assert.equal(first.available, true);
  assert.equal(first.cacheHit, false);
  assert.equal(second.available, true);
  assert.equal(second.cacheHit, true);
  assert.equal(second.dedupHit, false);
  assert.equal(fetches, 1, "a fresh exact-contract quote must be shared across compatible consumers");
  resetEnv();
});

test("concurrent exact OCC snapshots deduplicate in-flight work", async () => {
  resetEnv();
  process.env.POLYGON_API_KEY = "test-key";
  process.env.POLYGON_MINUTE_CALL_CAP = "0";
  process.env.POLYGON_DAILY_CALL_CAP = "0";
  process.env.OPTIONS_EXACT_QUOTE_CACHE_TTL_MS = "5000";
  const occ = "O:QQQ260807P00500000";
  let fetches = 0;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async () => {
    fetches += 1;
    await blocked;
    return exactOccResponse(occ);
  };

  const first = fetchOptionContractSnapshot("QQQ", occ);
  const second = fetchOptionContractSnapshot("QQQ", occ);
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.available, true);
  assert.equal(secondResult.available, true);
  assert.equal(secondResult.dedupHit, true);
  assert.equal(fetches, 1, "concurrent readers must await the same provider request");
  resetEnv();
});

function exactOccResponse(occ) {
  return {
    ok: true,
    json: async () => ({
      results: {
        details: { ticker: occ, contract_type: /P\d{8}$/.test(occ) ? "put" : "call" },
        last_quote: {
          bid: 1.2,
          ask: 1.25,
          last_updated: Date.now() * 1_000_000,
        },
        day: { volume: 100 },
        open_interest: 500,
      },
    }),
  };
}
