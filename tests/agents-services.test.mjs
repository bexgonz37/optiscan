import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("service agents DELEGATE to existing subsystems (no duplicated logic)", () => {
  const src = read("lib/agents/services.ts");
  assert.ok(/@\/lib\/data-freshness/.test(src), "market data agent reuses freshness");
  assert.ok(/@\/lib\/market-context-store/.test(src), "context agent reuses Phase-3 context");
  assert.ok(/@\/lib\/statistics-store/.test(src), "performance agent reuses authoritative statistics");
  assert.ok(/@\/lib\/model-registry/.test(src), "model agent reuses the model registry");
  assert.ok(/@\/lib\/paper-risk/.test(src), "risk agent reuses the paper risk engine");
  // Must NOT re-implement selection/grading math inline.
  assert.ok(!/function\s+selectContract|function\s+gradeOutcome/.test(src));
});

test("risk agent fails closed (no actionability) on any error", () => {
  const src = read("lib/agents/services.ts");
  const riskFn = src.slice(src.indexOf("export function riskAgent"), src.indexOf("export interface MissedOpportunity"));
  assert.ok(/allowed: false/.test(riskFn) && /vetoed: true/.test(riskFn), "risk agent defaults to veto on failure");
});

test("missed-opportunity agent is counterfactual research only (never a graded outcome)", () => {
  const src = read("lib/agents/services.ts");
  assert.ok(/Counterfactual research only/.test(src));
  assert.ok(/not a graded outcome/i.test(src));
});

test("runtime reuses centralized selector + supervisor, never fabricates a fill", () => {
  const src = read("lib/agents/runtime.ts");
  assert.ok(/selectContract/.test(src), "reuses the ONE centralized selector");
  assert.ok(/superviseResults/.test(src), "delegates ranking/dedup to the pure supervisor");
  assert.ok(/fetchOptionChain/.test(src), "fetches via the metered provider");
  assert.ok(!/entry_price|INSERT INTO paper_trades|simulateFill/.test(src), "runtime does not fabricate fills or write trades");
});

test("put agents in the registry are always bearish/research (never actionable direction)", () => {
  const src = read("lib/agents/registry.ts");
  assert.ok(/ALWAYS research-only/.test(src));
});
