/**
 * Gate B5/B6 — provider consumer attribution and durable request accounting.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  PROVIDER_CONSUMERS,
  currentProviderConsumer,
  providerCategoryFor,
  withProviderConsumer,
} from "../lib/provider-context.ts";
import {
  accountingTradingDate,
  buildProviderUsageReportOnDb,
  normalizeEndpoint,
  providerRequestsPerMinuteOnDb,
  pruneProviderAccountingOnDb,
  recordProviderRequestOnDb,
  topProviderSymbolsOnDb,
} from "../lib/provider-accounting.ts";
import {
  __setProviderAccountingDb,
  emitProviderRequest,
  flushProviderAccounting,
} from "../lib/provider-accounting-sink.ts";

const ENV = { RAILWAY_GIT_COMMIT_SHA: "abcdef0123456789" };
const T = Date.UTC(2026, 6, 22, 15, 0, 0); // 11:00 ET

function db() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE provider_request_minute (
      trading_date TEXT NOT NULL, minute_bucket_ms INTEGER NOT NULL, deployment_id TEXT NOT NULL,
      consumer TEXT NOT NULL, category TEXT NOT NULL, endpoint TEXT NOT NULL,
      historical INTEGER NOT NULL DEFAULT 0,
      requests INTEGER NOT NULL DEFAULT 0, cache_hits INTEGER NOT NULL DEFAULT 0,
      dedup_avoided INTEGER NOT NULL DEFAULT 0, retries INTEGER NOT NULL DEFAULT 0,
      http_429 INTEGER NOT NULL DEFAULT 0, provider_errors INTEGER NOT NULL DEFAULT 0,
      quota_blocks INTEGER NOT NULL DEFAULT 0, paginated INTEGER NOT NULL DEFAULT 0,
      records_returned INTEGER NOT NULL DEFAULT 0, latency_ms_total INTEGER NOT NULL DEFAULT 0,
      latency_ms_max INTEGER NOT NULL DEFAULT 0, accounting_version INTEGER NOT NULL DEFAULT 1,
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (trading_date, minute_bucket_ms, deployment_id, consumer, endpoint, historical)
    );
    CREATE TABLE provider_request_symbol_day (
      trading_date TEXT NOT NULL, consumer TEXT NOT NULL, symbol TEXT NOT NULL,
      option_symbol TEXT NOT NULL DEFAULT '', requests INTEGER NOT NULL DEFAULT 0,
      records_returned INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (trading_date, consumer, symbol, option_symbol)
    );
  `);
  return d;
}

const rec = (d, over = {}) =>
  recordProviderRequestOnDb(d, {
    consumer: "scanner", endpoint: "/v2/snapshot/locale/us/markets/stocks/tickers",
    status: "ok", atMs: T, latencyMs: 100, recordsReturned: 5, ...over,
  }, ENV);

// ── Attribution scope ───────────────────────────────────────────────────────
test("provider scope attributes calls, nests innermost-wins, and defaults to unattributed", async () => {
  assert.equal(currentProviderConsumer(), "unattributed");

  const seen = withProviderConsumer("scanner", () => currentProviderConsumer());
  assert.equal(seen, "scanner");

  const nested = withProviderConsumer("scanner", () =>
    withProviderConsumer("options_paper_mark", () => currentProviderConsumer()));
  assert.equal(nested, "options_paper_mark", "a shared helper bills to its actual caller");

  // The scope must survive awaits — provider calls are always async.
  const acrossAwait = await withProviderConsumer("asymmetry_mark", async () => {
    await new Promise((r) => setTimeout(r, 1));
    return currentProviderConsumer();
  });
  assert.equal(acrossAwait, "asymmetry_mark");

  assert.equal(currentProviderConsumer(), "unattributed", "the scope does not leak out");
});

test("every consumer maps to a category", () => {
  for (const c of PROVIDER_CONSUMERS) {
    assert.ok(providerCategoryFor(c), `${c} has a category`);
  }
  assert.equal(providerCategoryFor("scanner"), "scanner");
  assert.equal(providerCategoryFor("options_paper_mark"), "mark");
  assert.equal(providerCategoryFor("historical_research"), "research");
});

// ── Endpoint normalisation ──────────────────────────────────────────────────
test("endpoints collapse symbols and OCCs so buckets stay low-cardinality", () => {
  assert.equal(normalizeEndpoint("/v3/snapshot/options/AAPL/O:AAPL260724P00220000"), "/v3/snapshot/options/:sym/:occ");
  assert.equal(normalizeEndpoint("/v2/aggs/ticker/NVDA/range/1/minute/2026-07-22/2026-07-23"), "/v2/aggs/ticker/:sym/range/:n/minute/:date/:date");
  assert.equal(normalizeEndpoint("/v2/snapshot/locale/us/markets/stocks/tickers"), "/v2/snapshot/locale/us/markets/stocks/tickers");
  assert.equal(normalizeEndpoint(""), "unknown");
});

// ── Accounting semantics ────────────────────────────────────────────────────
test("cache hits, dedup, and quota blocks are not counted as provider requests", () => {
  const d = db();
  rec(d);
  rec(d, { status: "cache_hit" });
  rec(d, { status: "dedup_avoided" });
  rec(d, { status: "quota_block" });
  const report = buildProviderUsageReportOnDb(d, accountingTradingDate(T));
  assert.equal(report.totalRequests, 1, "only the call that reached the provider counts");
  assert.equal(report.totalCacheHits, 1);
  assert.equal(report.totalDedupAvoided, 1);
  assert.equal(report.totalQuotaBlocks, 1, "our own budget refusal is not missing market data");
});

test("errors, 429s, and retries are attributed separately from successful spend", () => {
  const d = db();
  rec(d);
  rec(d, { status: "http_429" });
  rec(d, { status: "provider_error" });
  rec(d, { status: "timeout" });
  rec(d, { retry: true });
  const report = buildProviderUsageReportOnDb(d, accountingTradingDate(T));
  assert.equal(report.total429, 1);
  assert.equal(report.totalProviderErrors, 2, "a timeout is a provider error");
  assert.equal(report.totalRetries, 1);
  assert.equal(report.totalRequests, 5, "failed calls still consumed the budget");
});

test("the report ranks consumers by spend and shows each one's share", () => {
  const d = db();
  for (let i = 0; i < 10; i++) rec(d, { consumer: "scanner", atMs: T + i * 1000 });
  for (let i = 0; i < 30; i++) {
    rec(d, { consumer: "asymmetry_mark", endpoint: "/v3/snapshot/options/AAPL/O:AAPL260724P00220000", atMs: T + i * 1000 });
  }
  const report = buildProviderUsageReportOnDb(d, accountingTradingDate(T));
  assert.equal(report.totalRequests, 40);
  assert.equal(report.byConsumer[0].consumer, "asymmetry_mark", "largest consumer first");
  assert.equal(report.byConsumer[0].requests, 30);
  assert.equal(report.byConsumer[0].pctOfRequests, 75);
  assert.equal(report.byEndpoint[0].endpoint, "/v3/snapshot/options/:sym/:occ");
});

test("the daily total survives a deployment", () => {
  const d = db();
  for (let i = 0; i < 5; i++) rec(d, { atMs: T + i * 1000 });
  // Same trading date, new deployment id — as after a mid-session deploy.
  for (let i = 0; i < 7; i++) {
    recordProviderRequestOnDb(d, {
      consumer: "scanner", endpoint: "/v2/snapshot/locale/us/markets/stocks/tickers",
      status: "ok", atMs: T + 120_000 + i * 1000,
    }, { RAILWAY_GIT_COMMIT_SHA: "9999999aaaa" });
  }
  const report = buildProviderUsageReportOnDb(d, accountingTradingDate(T));
  assert.equal(report.totalRequests, 12, "the day's total spans deployments");
  assert.equal(report.deployments.length, 2);
});

test("per-minute buckets expose the saturated minute", () => {
  const d = db();
  for (let i = 0; i < 3; i++) rec(d, { atMs: T + i * 1000 });
  for (let i = 0; i < 9; i++) rec(d, { atMs: T + 60_000 + i * 1000 });
  const report = buildProviderUsageReportOnDb(d, accountingTradingDate(T));
  assert.equal(report.peakRequestsPerMinute, 9);
  assert.equal(report.peakMinuteBucketMs, Math.floor((T + 60_000) / 60_000) * 60_000);
  assert.equal(report.minutesObserved, 2);
  const series = providerRequestsPerMinuteOnDb(d, T - 60_000, T + 120_000);
  assert.deepEqual(series.map((r) => r.requests), [3, 9]);
});

test("per-symbol and per-OCC spend is tracked for the calls that name a target", () => {
  const d = db();
  for (let i = 0; i < 4; i++) {
    rec(d, {
      consumer: "options_paper_mark", symbol: "aapl",
      optionSymbol: "O:AAPL260724P00220000",
      endpoint: "/v3/snapshot/options/AAPL/O:AAPL260724P00220000", atMs: T + i * 1000,
    });
  }
  rec(d, { consumer: "options_paper_mark", symbol: "NVDA", atMs: T });
  const top = topProviderSymbolsOnDb(d, accountingTradingDate(T));
  assert.equal(top[0].symbol, "AAPL");
  assert.equal(top[0].requests, 4);
  assert.equal(top[0].optionSymbol, "O:AAPL260724P00220000");
  assert.equal(top[1].symbol, "NVDA");
  assert.equal(top[1].optionSymbol, null);
});

test("accounting is inert without the schema and prunes to a bounded history", () => {
  const bare = new Database(":memory:");
  assert.equal(rec(bare), false, "a pre-migration database is a no-op, not a crash");
  assert.equal(buildProviderUsageReportOnDb(bare, "2026-07-22").totalRequests, 0);

  const d = db();
  for (let day = 0; day < 5; day++) rec(d, { atMs: T - day * 24 * 60 * 60_000 });
  assert.equal(pruneProviderAccountingOnDb(d, 10), 0, "nothing to prune inside the window");
  assert.ok(pruneProviderAccountingOnDb(d, 2) > 0);
  const dates = d.prepare("SELECT COUNT(DISTINCT trading_date) n FROM provider_request_minute").get().n;
  assert.equal(dates, 2);
});

// ── Buffered sink ───────────────────────────────────────────────────────────
test("the sink buffers a minute in memory and writes one row per bucket", () => {
  const d = db();
  __setProviderAccountingDb(d);
  try {
    for (let i = 0; i < 50; i++) {
      emitProviderRequest({
        endpoint: "/v2/snapshot/locale/us/markets/stocks/tickers",
        status: "ok", atMs: T + i * 100, latencyMs: 10,
      });
    }
    const beforeFlush = d.prepare("SELECT COUNT(*) n FROM provider_request_minute").get().n;
    assert.equal(beforeFlush, 0, "no fsync in the hot path — nothing is written yet");

    assert.equal(flushProviderAccounting(), 1, "50 calls collapse into one minute row");
    const row = d.prepare("SELECT consumer, requests FROM provider_request_minute").get();
    assert.equal(row.requests, 50);
    assert.equal(row.consumer, "unattributed", "calls outside a scope are visibly unattributed");
  } finally {
    __setProviderAccountingDb(null);
  }
});

test("crossing a minute boundary flushes the completed minute automatically", () => {
  const d = db();
  __setProviderAccountingDb(d);
  try {
    emitProviderRequest({ endpoint: "/v2/x", status: "ok", atMs: T });
    emitProviderRequest({ endpoint: "/v2/x", status: "ok", atMs: T + 60_000 });
    assert.equal(
      d.prepare("SELECT COUNT(*) n FROM provider_request_minute").get().n,
      1,
      "the finished minute lands without waiting for an explicit flush",
    );
    flushProviderAccounting();
    assert.equal(d.prepare("SELECT COUNT(*) n FROM provider_request_minute").get().n, 2);
  } finally {
    __setProviderAccountingDb(null);
  }
});

test("the sink attributes buffered calls to the ambient consumer", () => {
  const d = db();
  __setProviderAccountingDb(d);
  try {
    withProviderConsumer("scanner", () => {
      emitProviderRequest({ endpoint: "/v2/snapshot", status: "ok", atMs: T });
    });
    withProviderConsumer("options_paper_mark", () => {
      emitProviderRequest({ endpoint: "/v3/snapshot/options/AAPL/O:AAPL260724P00220000", status: "ok", atMs: T });
      emitProviderRequest({ endpoint: "/v3/snapshot/options/AAPL/O:AAPL260724P00220000", status: "ok", atMs: T });
    });
    flushProviderAccounting();
    const report = buildProviderUsageReportOnDb(d, accountingTradingDate(T));
    assert.equal(report.totalRequests, 3);
    assert.equal(report.byConsumer[0].consumer, "options_paper_mark");
    assert.equal(report.byConsumer[0].requests, 2);
    assert.equal(report.byConsumer[1].consumer, "scanner");
  } finally {
    __setProviderAccountingDb(null);
  }
});

// ── Report scoping (Gate B7 measurement) ────────────────────────────────────
// A trading date that spans a deploy mixes the session before a change with the
// session after it. These assert the report can be narrowed to a window that can
// actually answer a before/after question.

const OLD_ENV = { RAILWAY_GIT_COMMIT_SHA: "0000aaa1111" }; // -> "0000aaa"
const NEW_ENV = { RAILWAY_GIT_COMMIT_SHA: "226ba96b42c" }; // -> "226ba96"

test("a report scoped to one deployment excludes every other deployment's spend", () => {
  const d = db();
  const date = accountingTradingDate(T);
  // Before the deploy: marking is starved — 2 requests, 40 refusals.
  for (let i = 0; i < 2; i++) {
    recordProviderRequestOnDb(d, {
      consumer: "asymmetry_mark", endpoint: "/v3/snapshot/options/:sym/:occ",
      status: "ok", atMs: T, latencyMs: 10, recordsReturned: 1,
    }, OLD_ENV);
  }
  for (let i = 0; i < 40; i++) {
    recordProviderRequestOnDb(d, {
      consumer: "asymmetry_mark", endpoint: "/v3/snapshot/options/:sym/:occ",
      status: "quota_block", atMs: T,
    }, OLD_ENV);
  }
  // After the deploy: the reserve is reachable — 30 requests, 1 refusal.
  for (let i = 0; i < 30; i++) {
    recordProviderRequestOnDb(d, {
      consumer: "asymmetry_mark", endpoint: "/v3/snapshot/options/:sym/:occ",
      status: "ok", atMs: T + 60_000, latencyMs: 10, recordsReturned: 1,
    }, NEW_ENV);
  }
  recordProviderRequestOnDb(d, {
    consumer: "asymmetry_mark", endpoint: "/v3/snapshot/options/:sym/:occ",
    status: "quota_block", atMs: T + 60_000,
  }, NEW_ENV);

  const whole = buildProviderUsageReportOnDb(d, date);
  assert.equal(whole.totalRequests, 32, "the unscoped report still sums the whole date");
  assert.deepEqual(whole.deployments, ["0000aaa", "226ba96"]);
  assert.equal(whole.scope.deploymentId, null, "an unscoped report says so");

  const after = buildProviderUsageReportOnDb(d, date, { deploymentId: "226ba96" });
  assert.equal(after.totalRequests, 30);
  assert.equal(after.totalQuotaBlocks, 1);
  assert.deepEqual(after.deployments, ["226ba96"], "the scope narrows the deployment list too");
  assert.equal(after.scope.deploymentId, "226ba96", "the report names its own scope");
  assert.equal(after.byConsumer[0].consumer, "asymmetry_mark");
  assert.equal(after.byConsumer[0].requests, 30);
  assert.equal(after.byConsumer[0].quotaBlocks, 1);

  // The mixed total would have read as 32/41 = 78% admission; the honest
  // post-deploy answer is 30/31 = 97%. Scoping is what separates them.
  const before = buildProviderUsageReportOnDb(d, date, { deploymentId: "0000aaa" });
  assert.equal(before.totalRequests, 2);
  assert.equal(before.totalQuotaBlocks, 40);
});

test("a report scoped to a minute window bounds both ends inclusively", () => {
  const d = db();
  const date = accountingTradingDate(T);
  for (const offset of [0, 60_000, 120_000, 180_000]) {
    recordProviderRequestOnDb(d, {
      consumer: "scanner", endpoint: "/v2/snapshot", status: "ok",
      atMs: T + offset, latencyMs: 5, recordsReturned: 1,
    }, NEW_ENV);
  }
  assert.equal(buildProviderUsageReportOnDb(d, date).totalRequests, 4);

  const mid = buildProviderUsageReportOnDb(d, date, { sinceMs: T + 60_000, untilMs: T + 120_000 });
  assert.equal(mid.totalRequests, 2, "both bounds are inclusive");
  assert.equal(mid.minutesObserved, 2);
  assert.equal(mid.scope.sinceMs, T + 60_000);
  assert.equal(mid.scope.untilMs, T + 120_000);

  const from = buildProviderUsageReportOnDb(d, date, { sinceMs: T + 120_000 });
  assert.equal(from.totalRequests, 2, "an open upper bound is allowed");

  // Deployment and window compose.
  const both = buildProviderUsageReportOnDb(d, date, {
    deploymentId: "226ba96", sinceMs: T + 180_000,
  });
  assert.equal(both.totalRequests, 1);
  const none = buildProviderUsageReportOnDb(d, date, {
    deploymentId: "0000aaa", sinceMs: T + 180_000,
  });
  assert.equal(none.totalRequests, 0, "a scope matching nothing reports zero, not the whole day");
});

test("scoped endpoint percentages are computed against the scoped total", () => {
  const d = db();
  const date = accountingTradingDate(T);
  recordProviderRequestOnDb(d, {
    consumer: "scanner", endpoint: "/v2/old", status: "ok", atMs: T, latencyMs: 5,
  }, OLD_ENV);
  for (let i = 0; i < 3; i++) {
    recordProviderRequestOnDb(d, {
      consumer: "scanner", endpoint: "/v2/new", status: "ok", atMs: T, latencyMs: 5,
    }, NEW_ENV);
  }
  const after = buildProviderUsageReportOnDb(d, date, { deploymentId: "226ba96" });
  assert.equal(after.byEndpoint.length, 1, "the other deployment's endpoint is not listed");
  assert.equal(after.byEndpoint[0].endpoint, "/v2/new");
  assert.equal(after.byEndpoint[0].pctOfRequests, 100, "100% of the SCOPED total, not 75% of the day");
  assert.equal(after.byConsumer[0].pctOfRequests, 100);
});
