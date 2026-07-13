import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("supervisor cycle delegates to the canonical callout path, never a provider directly", () => {
  const src = read("lib/supervisor-cycle.ts");
  assert.ok(/buildCalloutsForTickers/.test(src), "delegates to the single canonical callout path");
  // No direct provider fetch: the metered chain fetch lives in the agent runtime.
  assert.ok(!/polyFetch\(|fetchOptionChain\(|fetchBulkQuotes\(|https?:\/\//.test(src), "no direct provider calls");
  // No brokerage / live-execution import in the cycle.
  assert.ok(!/robinhood|alpaca|broker|place_order|live-execution/i.test(src), "no brokerage/live-exec");
});

test("supervisor runtime is OFF by default (safe accidental-deploy default)", () => {
  const src = read("lib/supervisor-cycle.ts");
  assert.ok(/SUPERVISOR_RUNTIME === "1"/.test(src), "explicit opt-in flag, value '1'");
});

test("agent runtime filters horizons by real chain coverage (no silent widening)", () => {
  const src = read("lib/agents/runtime.ts");
  assert.ok(/relevantOptionAgents/.test(src), "uses relevance filter");
  assert.ok(/chainDteCoverage/.test(src), "derives coverage from the fetched chain");
  // Threads supervisor prior state for lifecycle hysteresis.
  assert.ok(/nextPriorState/.test(src) && /previous:\s*opts\.previous/.test(src), "threads lifecycle prior state");
});

test("agent runtime still routes every provider call through the metered provider", () => {
  const src = read("lib/agents/runtime.ts");
  // The only provider entry point is fetchOptionChain from the metered provider.
  assert.ok(/from "@\/lib\/polygon-provider"/.test(src));
  assert.ok(!/fetch\(`?https?:/.test(src), "no raw HTTP");
});

test("supervisor uses owner core fallback, cap 12, overlap guard, and bounded chain concurrency", () => {
  const cycle = read("lib/supervisor-cycle.ts");
  const runtime = read("lib/callouts/runtime.ts");
  assert.ok(/OWNER_CORE_TICKERS/.test(cycle), "owner core env feeds supervisor when supervisor core env is absent");
  assert.ok(/SUPERVISOR_MAX_TICKERS \?\? 12/.test(cycle), "default cap covers all ten core tickers plus movers");
  assert.ok(/__optiscanSupervisorRunning/.test(cycle), "overlapping cycles are prevented");
  assert.ok(/SUPERVISOR_CHAIN_CONCURRENCY/.test(runtime), "options chain ticker work is bounded-parallel");
  assert.ok(/mapLimit/.test(runtime), "runtime uses the shared bounded queue");
});
