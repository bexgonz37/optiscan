import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Source-spec tests. lib/explanation-adapters.ts uses the "@/lib/db" alias so it
 * cannot be imported by the node test runner directly (same convention as the
 * quant/opportunity-store layers). The pure builder it delegates to is
 * runtime-tested in tests/trade-explanation.test.mjs; these lock the adapter
 * guarantees + API wiring at the source level.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("adapters delegate to the ONE pure builder", () => {
  const src = read("lib/explanation-adapters.ts");
  assert.ok(/from "@\/lib\/trade-explanation"/.test(src), "imports the pure builder");
  for (const fn of ["explanationForSelection", "explanationForOpportunity", "explanationForAlert"]) {
    assert.ok(new RegExp(`export function ${fn}`).test(src), `${fn} exported`);
  }
  const buildCalls = (src.match(/buildTradeExplanation\(/g) ?? []).length;
  assert.ok(buildCalls >= 3, "each adapter calls buildTradeExplanation");
});

test("evidence lookup is READ-ONLY (no INSERT/UPDATE/refresh writes)", () => {
  const src = read("lib/explanation-adapters.ts");
  assert.ok(/SELECT sample_size, win_rate, expectancy, data_quality FROM setup_statistics/.test(src), "read-only setup stats query");
  assert.ok(!/INSERT INTO|UPDATE |refreshSetupStatistics|scoreAlert/.test(src), "adapters must not write or recompute stats");
});

test("opportunity adapter maps short/bear → put and long → call", () => {
  const src = read("lib/explanation-adapters.ts");
  assert.ok(/setup_type\.includes\("short"\)/.test(src) && /setup_type\.includes\("bear"\)/.test(src), "bearish detection");
  assert.ok(/setup_type\.includes\("long"\)/.test(src), "bullish detection");
});

test("alert adapter reuses deterministic explain.js narrative (no model calls)", () => {
  const src = read("lib/explanation-adapters.ts");
  assert.ok(/from "@\/lib\/explain"/.test(src), "imports buildExplanation from explain.js");
  assert.ok(!/openai|anthropic|fetch\(/i.test(src), "no LLM / network in the adapter");
});

test("alert adapter never fabricates a contract when none exists", () => {
  const src = read("lib/explanation-adapters.ts");
  assert.ok(/const hasContract =/.test(src), "guards contract presence");
  assert.ok(/hasContract\s*\?[\s\S]*?:\s*null/.test(src), "contract is null when absent");
});

test("adapters are wrapped so failures never throw into a read", () => {
  const src = read("lib/explanation-adapters.ts");
  assert.ok((src.match(/catch/g) ?? []).length >= 2, "defensive catches present");
});

// ── API wiring ───────────────────────────────────────────────────────────────

test("GET /api/opportunities attaches an explanation per record", () => {
  const src = read("app/api/opportunities/route.ts");
  assert.ok(/explanationForOpportunity/.test(src), "uses opportunity adapter");
  assert.ok(/explanation: exp/.test(src), "attaches explanation to records");
});

test("GET /api/options/:ticker attaches an explanation per side from the selection", () => {
  const src = read("app/api/options/[ticker]/route.ts");
  assert.ok(/explanationForSelection/.test(src), "uses selection adapter");
  assert.ok(/explanation:\s*\{[\s\S]*call:[\s\S]*put:/.test(src), "call + put explanations");
});

test("GET /api/alerts attaches an explanation per row, additively", () => {
  const src = read("app/api/alerts/route.ts");
  assert.ok(/explanationForAlert/.test(src), "uses alert adapter");
  assert.ok(/explanation: explanationForAlert\(a\)/.test(src), "attaches per row");
  assert.ok(/catch\s*\{[\s\S]*?return a;?\s*\}/.test(src), "row-level failure keeps the raw alert");
});
