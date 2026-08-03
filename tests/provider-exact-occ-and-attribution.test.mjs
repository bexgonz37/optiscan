/**
 * tests/provider-exact-occ-and-attribution.test.mjs
 *
 * Gate B5 CLOSE — the three defects that live production measurement exposed on
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
 * Three separate defects, one per suite below:
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
