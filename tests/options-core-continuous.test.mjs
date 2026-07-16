import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// buildCycleUniverse is pure (no @/lib alias imports) so it is directly testable.
// cycleUniverse itself pulls the DB/scanner via @/lib and can only be inspected.
import { buildCycleUniverse, DEFAULT_SUPERVISOR_CORE_TICKERS, parseTickerList } from "../lib/supervisor-universe.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORE = parseTickerList(DEFAULT_SUPERVISOR_CORE_TICKERS);

test("every core options ticker is evaluated each cycle (independent of stock movers)", () => {
  // Empty dynamic candidates (no stock promotion) — full core must still appear.
  const uni = buildCycleUniverse(DEFAULT_SUPERVISOR_CORE_TICKERS, [], CORE.length);
  for (const t of CORE) assert.ok(uni.includes(t), `core ticker ${t} must be in every cycle`);
});

test("core is included even when strong stock movers compete for slots", () => {
  const movers = ["RUNR", "BURST", "SOAR", "ZOOM", "FLYY"];
  const uni = buildCycleUniverse(DEFAULT_SUPERVISOR_CORE_TICKERS, movers, CORE.length);
  for (const t of CORE) assert.ok(uni.includes(t), `core ticker ${t} must outrank dynamic movers`);
});

test("core includes confirmed liquid names with no stock-price/gain rule (SPY, AAPL)", () => {
  const uni = buildCycleUniverse(DEFAULT_SUPERVISOR_CORE_TICKERS, [], CORE.length);
  // SPY (an index ETF) and AAPL (>$50) — the options universe has no $0.50–$50
  // price cap and no +10% underlying-gain requirement.
  assert.ok(uni.includes("SPY"));
  assert.ok(uni.includes("AAPL"));
});

test("cycleUniverse raises the effective cap to fit the FULL core (no starvation)", () => {
  const cycle = readFileSync(join(root, "lib/supervisor-cycle.ts"), "utf8");
  // The effective cap is at least the core count, so a tiny SUPERVISOR_MAX_TICKERS
  // can never drop core options names from a cycle.
  assert.match(cycle, /Math\.max\(configuredCap, coreCount\)/, "effective cap covers the whole core");
  assert.match(cycle, /parseTickerList\(coreCsv\)\.length/, "core count derived from the core list");
});

test("the options cycle applies NO stock-momentum filters (price band / +10% gain)", () => {
  const cycle = readFileSync(join(root, "lib/supervisor-cycle.ts"), "utf8");
  assert.doesNotMatch(cycle, /broadStockEligibility|fastStockMomentum|STOCK_MOMENTUM_MAX_PRICE|MIN_GAIN_FROM_PREV/,
    "options underlyings must not be gated by the broad stock-momentum filters");
});

test("the options core universe runs on its own timer, gated only by SUPERVISOR_RUNTIME (not stock promotion)", () => {
  const sched = readFileSync(join(root, "lib/scheduler.ts"), "utf8");
  assert.match(sched, /runSupervisorCycle/);
  assert.match(sched, /supervisorRuntimeEnabled/);
});
