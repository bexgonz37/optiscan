import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regression: the data-freshness service must LOAD and EXECUTE on the callout
 * path in the Next standalone runtime. The live failure was
 *   "freshness unavailable: Cannot find module '@/lib/data-freshness'"
 * caused by a `require(variable)` indirection in lib/agents/services.ts that
 * webpack could not resolve/bundle (only static-literal `@/` requests are
 * bundled). This proves the module resolves + classifies, and that no dynamic
 * `@/…` import remains in the affected runtime path.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

// ── the actual freshness module loads and executes (relative deps, no @/ alias) ──
const fresh = await import("../lib/data-freshness.ts");

test("data-freshness loads and actionableFreshness executes without MODULE_NOT_FOUND", () => {
  assert.equal(typeof fresh.actionableFreshness, "function");
  const res = fresh.actionableFreshness("ZZTEST", ["stock_quote"]);
  assert.equal(typeof res.ok, "boolean");
  assert.ok("reason" in res, "returns a structured freshness result, not a thrown module error");
});

test("closed-market (Sunday) data is non-actionable (MARKET_CLOSED, blocked)", () => {
  // 2026-07-05 is a Sunday — market closed in ET. (A past date: the freshness
  // normalizer rejects future-skewed timestamps, so fixtures must be in the past.)
  const receivedAt = Date.parse("2026-07-05T14:00:00-04:00");
  const s = fresh.recordDataSample({
    symbol: "SUNCLOSED", kind: "stock_quote",
    providerTimestamp: receivedAt - 5_000, receivedAt,
  });
  assert.equal(s.market_session, "closed");
  assert.equal(s.freshness_status, "MARKET_CLOSED");
  const a = fresh.actionableFreshness("SUNCLOSED", ["stock_quote"]);
  assert.equal(a.ok, false, "closed-market setups stay non-actionable");
});

test("genuine stale data (RTH, old timestamp) is still classified STALE", () => {
  // 2026-07-06 is a Monday (past date, RTH); 14:00 ET is regular hours. A 10-minute-old quote is
  // well past the stock_quote threshold (20s LIVE, 60s DELAYED) → STALE.
  const receivedAt = Date.parse("2026-07-06T14:00:00-04:00");
  const s = fresh.recordDataSample({
    symbol: "STALEONE", kind: "stock_quote",
    providerTimestamp: receivedAt - 600_000, receivedAt,
  });
  assert.equal(s.market_session, "regular");
  assert.equal(s.freshness_status, "STALE");
  assert.equal(fresh.actionableFreshness("STALEONE", ["stock_quote"]).ok, false);
});

test("fresh RTH data remains actionable (control — fix does not over-block)", () => {
  const receivedAt = Date.parse("2026-07-06T14:00:00-04:00");
  const s = fresh.recordDataSample({
    symbol: "FRESHONE", kind: "stock_quote",
    providerTimestamp: receivedAt - 5_000, receivedAt,
  });
  assert.equal(s.freshness_status, "LIVE");
  assert.equal(fresh.actionableFreshness("FRESHONE", ["stock_quote"]).ok, true);
});

// ── no dynamic `@/…` import remains in the affected path ─────────────────────
test("services.ts has NO require(variable) and loads data-freshness statically", () => {
  const src = read("lib/agents/services.ts");
  // Strip comments so prose describing the old bug does not trip the checks.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/function\s+req\b/.test(code), "the req() indirection helper must be gone");
  assert.ok(!/require\(\s*[A-Za-z_$]/.test(code), "no require(variable) — webpack cannot bundle it");
  assert.ok(!/req\(/.test(code), "no req() indirection calls remain");
  // The freshness module is now a static, bundler-safe import.
  assert.match(code, /import\s*\{[^}]*actionableFreshness[^}]*\}\s*from\s*"@\/lib\/data-freshness"/);
  // Every remaining @/ dependency is a STRING-LITERAL require (statically analyzable).
  const dynamicAlias = code.match(/require\((?!\s*")[^)]*@\//g);
  assert.equal(dynamicAlias, null, "all @/ requires must be string literals");
});

test("callout runtime path uses only static/literal @/ requests (no require(variable))", () => {
  // horizon agents · supervisor · callout generation · service agents · boot · scheduler
  for (const f of [
    "lib/agents/runtime.ts", "lib/agents/services.ts", "lib/agents/supervisor.ts",
    "lib/agents/horizon-agent.ts", "lib/callouts/runtime.ts", "lib/supervisor-cycle.ts",
    "lib/server-boot.ts", "lib/scheduler.ts",
  ]) {
    const code = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/require\(\s*[A-Za-z_$]/.test(code), `${f} must not use require(variable)`);
    assert.ok(!/import\(\s*[A-Za-z_$]/.test(code), `${f} must not use import(variable)`);
  }
});

// ── production-standalone smoke test (build artifact) ────────────────────────
// After `npm run build`, the data-freshness module must be bundled into the
// server graph (the callout route imports it). Skips when no build is present.
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.js$/.test(name)) out.push(p);
  }
  return out;
}

test("production build bundles data-freshness into the server output", { skip: !existsSync(join(root, ".next", "server")) }, () => {
  const files = walk(join(root, ".next", "server"));
  // A string literal unique to data-freshness (emitted on the callout path when a
  // required data kind was never observed). Its presence proves the module was
  // bundled server-side rather than left as an unresolved `@/` alias.
  const marker = "required data type has not been observed in this process";
  const bundled = files.some((f) => readFileSync(f, "utf8").includes(marker));
  assert.ok(bundled, "data-freshness code must be present in the built server output");
  // And the raw unresolved alias require must NOT survive anywhere in the server output.
  const leaked = files.some((f) => /require\(\s*["']@\/lib\/data-freshness["']\s*\)/.test(readFileSync(f, "utf8")));
  assert.ok(!leaked, "no unresolved require('@/lib/data-freshness') may remain in the build");
});
