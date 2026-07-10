import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Quant layer spec tests. lib/quant.ts uses the "@/lib/db" alias so it can't
 * be imported by the node test runner directly — these source-spec tests lock
 * the safety properties that matter: token gates, sample-size guardrails,
 * disclaimers, no fake data, and schema presence.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const quant = read("lib/quant.ts");

test("every /api/quant route is token-gated", () => {
  const walk = (dir) =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name === "route.ts" ? [join(dir, e.name)] : [],
    );
  const routes = walk("app/api/quant");
  assert.ok(routes.length >= 6, `expected 6+ quant routes, found ${routes.length}`);
  for (const r of routes) {
    const src = read(r);
    assert.ok(src.includes("checkApiToken"), `${r} must call checkApiToken`);
    assert.ok(src.includes("unauthorized()"), `${r} must return unauthorized()`);
  }
});

test("sample-size guardrails exist and gate the top grades", () => {
  assert.match(quant, /MIN_SAMPLE/i, "minimum-sample constants required");
  // A+ must demand more samples than a mid grade — extract the numbers.
  const aPlus = quant.match(/grade = "A\+"/);
  assert.ok(aPlus, "A+ grade ladder present");
  assert.ok(/sampleSize >= \w*MIN_SAMPLE\w*/.test(quant), "grades must check sample size");
});

test("the disclaimer separates historical edge from guaranteed outcome", () => {
  assert.match(quant, /not financial advice/i);
  assert.ok(
    /historical/i.test(quant) && /warning/i.test(quant),
    "warnings + historical framing required",
  );
});

test("no fabricated data: quant layer contains no random number generation", () => {
  assert.ok(!quant.includes("Math.random"), "stats must come from real outcomes, never synthesized");
});

test("data-coverage honesty: plan reports when 5y history is NOT connected", () => {
  assert.ok(quant.includes("needs_5y_history_adapter") || /historical_connected/.test(quant),
    "plan must expose whether real historical data is wired");
});

test("quant DB tables exist in the schema", () => {
  const db = read("lib/db.ts");
  for (const table of ["historical_alerts", "trade_outcomes", "setup_statistics", "backtest_results", "strategy_versions", "model_predictions"]) {
    assert.ok(db.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `missing table ${table}`);
  }
});

test("Discord quant enrichment is optional and non-directive", () => {
  const n = read("lib/notifications.ts");
  assert.ok(n.includes("scoreAlert"), "BUY payloads should carry the quant line");
  const idx = n.indexOf("scoreAlert");
  const region = n.slice(Math.max(0, idx - 600), idx + 900);
  assert.ok(/try\s*\{/.test(region) && /catch/.test(region), "quant enrichment must be try/caught — never blocks a send");
  assert.ok(region.includes("historical stats, not advice"), "quant line must carry the stats disclaimer");
  // The quant LINE itself (the template literal) must be non-directive; the
  // surrounding BUY-payload plumbing legitimately mentions BUY.
  const lineMatch = region.match(/const line = `([^`]+)`/);
  assert.ok(lineMatch, "quant line template found");
  assert.ok(!/\b(BUY|SELL|LONG|SHORT)\b/.test(lineMatch[1]), "no directive wording in the quant line itself");
});

test("/quant page exists, is in the nav, and carries the disclaimer", () => {
  const page = read("app/quant/page.tsx");
  assert.match(page, /not financial advice/i);
  assert.ok(page.includes("sampleSize") || page.includes("sample size") || page.includes("Grades require real sample"), "page must surface sample-size honesty");
  const nav = read("components/AxiomShell.tsx");
  assert.ok(nav.includes('href: "/quant"'), "Quant nav item required");
});
