/**
 * tests/provider-exact-occ-and-attribution.test.mjs
 *
 * Gate B5 CLOSE — the four defects that live production measurement exposed on
 * 2026-08-03, with the numbers that proved each one.
 *
 * The provider ran pinned at 280/280 requests per minute for the entire session
 * while refusing ~2,900 requests every minute. `/api/system/provider-usage` said:
 *
 *   unattributed        32,044 req  66.6%   6,060,360 records
 *   options_paper_mark  12,975 req  27.0%   3,124,152 records   (241 records/request)
 *   scanner              2,833 req   5.9%
 *   asymmetry_mark         263 req   0.6%   78,595 quota blocks  (99.7% starved)
 *
 *   /v3/snapshot/options/:sym (WHOLE CHAIN)  34,116 req  70.9%
 *   exact-OCC snapshots, all 21 combined        323 req   0.7%
 *
 * Four separate defects, one per suite below. The fourth is in the METER: three
 * blind spots that were harmless while marking pulled whole chains, and become
 * actively misleading the moment marking moves onto the exact-OCC path — the
 * report would have shown the fix as a regression.
 *
 *  1. EXACT OCC. Reading one contract by downloading its whole chain. Fixed on the
 *     asymmetry lane 2026-08-02; the subscriber grade lane and the alert tracker
 *     still did it. 241 records per request is that defect in one number.
 *
 *  2. ATTRIBUTION. The largest consumer in the system was `unattributed`, so the
 *     biggest spender could not be named. Every scheduler that reaches the provider
 *     must now run inside a consumer scope.
 *
 *  3. DIAGNOSTICS. A diagnostic route spent live requests against the same saturated
 *     cap it was being used to investigate.
 *
 *  4. THE METER. Percent-encoded OCCs never collapsed, so every contract got its own
 *     endpoint bucket. Object-shaped `results` counted as zero records, so exact-OCC
 *     reads looked empty. The endpoint table dropped its tail silently, so it never
 *     summed to the total. And cache/dedup savings were never emitted at all.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** Source with comments stripped, so prose naming a removed call never satisfies a check. */
function code(path) {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

// ── 1. Exact OCC: one contract must never cost a whole chain ───────────────────

/**
 * The BODY of buildLiveGradeDeps().getQuote — the implementation, not the type
 * declaration above it. `getQuote:` appears in both, so anchor on the last
 * occurrence; slicing from the first one reads the interface and would pass
 * against a completely unfixed implementation.
 */
function gradeGetQuoteBody() {
  const src = code("lib/research/options/live-deps.ts");
  const start = src.lastIndexOf("getQuote:");
  const end = src.lastIndexOf("fetchUnderlying:");
  assert.ok(start > 0 && end > start, "buildLiveGradeDeps must still expose getQuote then fetchUnderlying");
  return src.slice(start, end);
}

test("the subscriber grade lane reads one exact OCC, not a whole chain", async () => {
  const provider = await import("../lib/polygon-provider.js");
  assert.equal(typeof provider.fetchOptionContractSnapshot, "function");

  const getQuote = gradeGetQuoteBody();
  assert.match(getQuote, /fetchOptionContractSnapshot/,
    "getQuote must read the single-contract snapshot");
  assert.equal(/fetchOptionChain/.test(getQuote), false,
    "reading one contract must never fetch a whole chain — this cost 27% of the day's budget");
});

test("the grade lane distinguishes a budget refusal from a missing quote", () => {
  const getQuote = (() => {
    return gradeGetQuoteBody();
  })();
  assert.match(getQuote, /quotaExceeded/,
    "a quota block must be handled explicitly, never collapsed into `no quote`");
});

test("grade-lane freshness is judged against the observation clock", () => {
  const getQuote = gradeGetQuoteBody();
  assert.match(getQuote, /observedAtMs/,
    "quoteAgeMs must be measured from when the provider answered, not from sweep start "
    + "(the FUTURE_QUOTE fix, which must not regress on this lane)");
  assert.equal(/quoteFreshness\([^)]*,\s*nowMs\)/.test(getQuote), false,
    "the stale sweep-start clock must not come back");
});

test("the alert tracker reads one exact OCC at finalize", () => {
  const src = code("lib/alert-tracker.ts");
  assert.match(src, /fetchOptionContractSnapshot/);
  assert.equal(/fetchOptionChain/.test(src), false,
    "finalizeOptionOutcome downloaded a 500-contract chain to read one row");
});

// ── 2. Attribution: no scheduler may reach the provider unattributed ───────────

const SCOPED = [
  ["lib/scanner-loop.ts", "scanner"],
  ["lib/alert-tracker.ts", "alert_capture"],
  ["lib/research/options/monitor.ts", "options_discovery"],
  ["lib/research/options/grade.ts", "options_paper_mark"],
  ["lib/research/options/shadow-outcomes.ts", "options_shadow_mark"],
  ["lib/research/options/zero-dte-research/runtime.ts", "zero_dte_context"],
  ["lib/swing-scan.ts", "swing_scan"],
  ["lib/research/asymmetry/paper/runner.ts", "asymmetry_mark"],
  ["lib/research/watchlist/professional-runner.ts", "watchlist"],
  ["lib/research/watchlist/market-context-job.ts", "premarket"],
];

for (const [file, consumer] of SCOPED) {
  test(`${file} attributes its provider work to \`${consumer}\``, async () => {
    const src = code(file);
    assert.match(src, /withProviderConsumer/, `${file} must open an attribution scope`);
    assert.ok(
      new RegExp(`withProviderConsumer\\(\\s*["'\`]${consumer}["'\`]`).test(src)
      || new RegExp(`consumer:\\s*["'\`]${consumer}["'\`]`).test(src),
      `${file} must attribute to ${consumer}`,
    );
  });
}

test("every scoped consumer is a declared consumer with a category", async () => {
  const { PROVIDER_CONSUMERS, providerCategoryFor } = await import("../lib/provider-context.ts");
  for (const [, consumer] of SCOPED) {
    assert.ok(PROVIDER_CONSUMERS.includes(consumer), `${consumer} must be declared`);
    assert.ok(providerCategoryFor(consumer), `${consumer} must roll up to a category`);
  }
});

test("research lanes are categorised as research so budgets can starve them first", async () => {
  const { providerCategoryFor } = await import("../lib/provider-context.ts");
  // Gate B7 stops optional work before live work. These three are the lanes that
  // must yield: shadow marking, 0DTE research and the swing scan are all research.
  assert.equal(providerCategoryFor("options_shadow_mark"), "research");
  assert.equal(providerCategoryFor("zero_dte_context"), "research");
  assert.equal(providerCategoryFor("swing_scan"), "research");
  // ...while the lanes that must be protected are not.
  assert.equal(providerCategoryFor("scanner"), "scanner");
  assert.equal(providerCategoryFor("options_paper_mark"), "mark");
  assert.equal(providerCategoryFor("asymmetry_mark"), "mark");
});

test("a scope really does label calls made arbitrarily deep inside it", async () => {
  const { withProviderConsumer, currentProviderConsumer } = await import("../lib/provider-context.ts");
  const deep = async () => {
    await new Promise((r) => setTimeout(r, 1));
    return currentProviderConsumer();
  };
  assert.equal(currentProviderConsumer(), "unattributed");
  const seen = await withProviderConsumer("options_discovery", () => deep());
  assert.equal(seen, "options_discovery", "attribution must survive an await boundary");
  assert.equal(currentProviderConsumer(), "unattributed", "and must not leak out of the scope");
});

// ── 3. Diagnostics: zero provider requests ────────────────────────────────────

import { readdirSync, existsSync } from "node:fs";

const PROVIDER_FETCHES = [
  "fetchCandles", "fetchOptionChain", "fetchOptionContractSnapshot", "fetchQuote",
  "fetchBulkQuotes", "fetchMarketSnapshot", "fetchTopMovers", "fetchNews", "polyFetch", "polyRequest",
];

test("no diagnostic route makes a provider request on its default path", () => {
  const dir = "app/api/diagnostics";
  const routes = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `${dir}/${e.name}/route.ts`)
    .filter((p) => existsSync(p));
  assert.ok(routes.length >= 4, "the diagnostics routes must still be discoverable");

  for (const route of routes) {
    const src = code(route);
    const calls = PROVIDER_FETCHES.filter((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(src));
    if (calls.length === 0) continue;
    // A route that still touches the provider must (a) require an explicit opt-in
    // and (b) attribute the spend. Silent diagnostic spend is the defect.
    assert.match(src, /NOT_AVAILABLE_WITHOUT_LIVE_CALL/,
      `${route} calls ${calls.join(", ")} — it must answer NOT_AVAILABLE_WITHOUT_LIVE_CALL by default`);
    assert.match(src, /withProviderConsumer\(\s*["'`]diagnostics["'`]/,
      `${route} must attribute any authorised spend to the diagnostics consumer`);
    assert.match(src, /["']live["']\s*\)\s*===\s*["']1["']|live\s*=\s*[^;]*===\s*["']1["']/,
      `${route} must gate the provider call behind an explicit opt-in`);
  }
});

test("alert-decision refuses to spend by default and says exactly why", () => {
  const src = readFileSync("app/api/diagnostics/alert-decision/route.ts", "utf8");
  assert.match(src, /status:\s*"NOT_AVAILABLE_WITHOUT_LIVE_CALL"/);
  assert.match(src, /retryWith/, "the refusal must tell the caller how to authorise the cost");
  // The refusal must come BEFORE the provider import, or the default path still pays.
  assert.ok(
    src.indexOf("NOT_AVAILABLE_WITHOUT_LIVE_CALL") < src.indexOf('await import("@/lib/polygon-provider")'),
    "the default path must return before the provider module is even loaded",
  );
});

// ── 4. The meter itself: it must not misreport the fix it is measuring ────────
//
// Every check here failed against the code that produced the 2026-08-03 session.
// Each defect was harmless while marking pulled whole chains and became actively
// misleading the moment marking moved onto the exact-OCC path.

import { normalizeEndpoint, buildProviderUsageReportOnDb, recordProviderRequestOnDb } from "../lib/provider-accounting.ts";
import Database from "better-sqlite3";

const ACCT_DDL = `
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
`;

test("a percent-encoded OCC collapses to one endpoint bucket", () => {
  // This is EXACTLY what URL.pathname yields after encodeURIComponent(occ), and it is
  // what production actually recorded: 21 separate per-contract rows in the top 25.
  assert.equal(
    normalizeEndpoint("/v3/snapshot/options/NVDA/O%3ANVDA260807C00200000"),
    "/v3/snapshot/options/:sym/:occ",
  );
  // Unencoded form must keep working.
  assert.equal(
    normalizeEndpoint("/v3/snapshot/options/NVDA/O:NVDA260807C00200000"),
    "/v3/snapshot/options/:sym/:occ",
  );
  // Two different contracts must land in the SAME bucket, or the report fragments.
  assert.equal(
    normalizeEndpoint("/v3/snapshot/options/XOM/O%3AXOM260807C00155000"),
    normalizeEndpoint("/v3/snapshot/options/BAC/O%3ABAC260814P00062000"),
  );
});

test("a malformed escape never breaks metering", () => {
  assert.equal(typeof normalizeEndpoint("/v3/snapshot/options/%E0%A4%A"), "string");
});

test("the endpoint report adds up to the total, or says what it dropped", () => {
  const d = new Database(":memory:");
  d.exec(ACCT_DDL);
  const at = Date.UTC(2026, 7, 3, 15, 0, 0);
  // 30 distinct endpoints — more than the top-25 window.
  for (let i = 0; i < 30; i += 1) {
    recordProviderRequestOnDb(d, {
      consumer: "options_paper_mark", endpoint: `/v3/endpoint-${i}`, status: "ok",
      atMs: at, recordsReturned: 1,
    }, { deploymentId: "test" });
  }
  const report = buildProviderUsageReportOnDb(d, "2026-08-03");
  const summed = report.byEndpoint.reduce((s, r) => s + r.requests, 0);
  assert.equal(summed, report.totalRequests,
    "the endpoint column must sum to the total — a silent LIMIT 25 made it never add up");
  assert.match(report.byEndpoint[report.byEndpoint.length - 1].endpoint, /more endpoints/,
    "the dropped tail must be named, not hidden");
  d.close();
});

test("an untruncated report carries no remainder row", () => {
  const d = new Database(":memory:");
  d.exec(ACCT_DDL);
  const at = Date.UTC(2026, 7, 3, 15, 0, 0);
  for (let i = 0; i < 3; i += 1) {
    recordProviderRequestOnDb(d, {
      consumer: "scanner", endpoint: `/v3/endpoint-${i}`, status: "ok", atMs: at,
    }, { deploymentId: "test" });
  }
  const report = buildProviderUsageReportOnDb(d, "2026-08-03");
  assert.equal(report.byEndpoint.length, 3);
  assert.equal(report.byEndpoint.some((r) => /more endpoints/.test(r.endpoint)), false);
  d.close();
});

test("a single-resource response counts as one record, not zero", () => {
  const src = readFileSync("lib/polygon-provider.js", "utf8");
  assert.match(src, /function countResults/,
    "record counting must handle object-shaped `results`");
  const body = src.slice(src.indexOf("function countResults"));
  assert.match(body.slice(0, 400), /typeof r === "object"/,
    "the exact-OCC snapshot returns `results` as an OBJECT — counting only arrays scored it 0");
  assert.equal(/recordsReturned: Array\.isArray\(json\?\.results\)/.test(src), false,
    "the array-only count must not come back");
});

test("cache hits and dedupe avoidance are actually emitted", () => {
  const src = code("lib/polygon-provider.js");
  assert.match(src, /accountAvoided\(\s*MARKET_SNAP_ENDPOINT\s*,\s*"cache_hit"\s*\)/,
    "a TTL cache hit must be recorded — both counters read 0 across 48,135 requests");
  assert.match(src, /accountAvoided\(\s*MARKET_SNAP_ENDPOINT\s*,\s*"dedup_avoided"\s*\)/,
    "an inflight dedupe must be recorded");
});

test("an avoided request is never counted as a request", async () => {
  const { recordProviderRequestOnDb: rec, buildProviderUsageReportOnDb: build } =
    await import("../lib/provider-accounting.ts");
  const d = new Database(":memory:");
  d.exec(ACCT_DDL);
  const at = Date.UTC(2026, 7, 3, 15, 0, 0);
  rec(d, { consumer: "scanner", endpoint: "/x", status: "ok", atMs: at }, { deploymentId: "t" });
  rec(d, { consumer: "scanner", endpoint: "/x", status: "cache_hit", atMs: at }, { deploymentId: "t" });
  rec(d, { consumer: "scanner", endpoint: "/x", status: "dedup_avoided", atMs: at }, { deploymentId: "t" });
  const r = build(d, "2026-08-03");
  assert.equal(r.totalRequests, 1, "only the call we actually paid for is a request");
  assert.equal(r.totalCacheHits, 1);
  assert.equal(r.totalDedupAvoided, 1);
  d.close();
});
