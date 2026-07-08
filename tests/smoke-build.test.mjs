import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Build smoke test (audit T10 / P0-1 guard).
 * A truncated lib/scanner-loop.ts once reached the working tree: the app
 * built nowhere and the scanner silently never started. These checks make a
 * truncated or export-stripped core file fail `npm test` before any deploy.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

test("scanner-loop.ts is intact: line count and key exports", () => {
  const src = read("lib/scanner-loop.ts");
  const lines = src.split("\n").length;
  assert.ok(lines > 550, `lib/scanner-loop.ts has ${lines} lines — expected > 550 (truncation guard)`);
  assert.match(src, /export function startScannerLoop\(/);
  assert.match(src, /export function loopState\(/);
  assert.ok(!src.includes("\u0000"), "scanner-loop.ts contains NUL bytes (corruption)");
});

test("polygon-provider.js exports the quota meter API", async () => {
  const mod = await import("../lib/polygon-provider.js");
  assert.equal(typeof mod.getCallStats, "function");
  assert.equal(typeof mod.recordPolygonCall, "function");
  assert.equal(typeof mod.QuotaExceededError, "function");
  const stats = mod.getCallStats();
  assert.equal(typeof stats.callsToday, "number");
  assert.equal(typeof stats.callsThisMinute, "number");
});

test("health builder exports exist", async () => {
  const mod = await import("../lib/health.ts");
  assert.equal(typeof mod.buildHealth, "function");
  assert.equal(typeof mod.isLoopStalled, "function");
});

test("critical lib files are not truncated (balanced braces, no NULs)", () => {
  const files = [
    "lib/scanner-loop.ts",
    "lib/polygon-provider.js",
    "lib/alert-capture.ts",
    "lib/trade-verdict.ts",
    "lib/zero-dte.js",
    "lib/db.ts",
    "lib/auth.ts",
    "lib/health.ts",
  ];
  for (const f of files) {
    const src = read(f);
    assert.ok(!src.includes("\u0000"), `${f} contains NUL bytes (corruption)`);
    // Cheap truncation heuristic: brace balance. Not a parser, but a file cut
    // mid-function always trips it (string literals with lone braces would
    // false-positive; none of these files have any).
    const opens = (src.match(/\{/g) ?? []).length;
    const closes = (src.match(/\}/g) ?? []).length;
    assert.equal(opens, closes, `${f}: unbalanced braces (${opens} vs ${closes}) — truncated?`);
  }
});
