import test from "node:test";
import assert from "node:assert/strict";
import { SETUP_TIERS, LANES, isTradeableTier, setupIdOf } from "../lib/research/types.ts";
import { researchFlags } from "../lib/research/flags.ts";

/**
 * Phase 0 design-contract guards. These lock the normalized vocabulary and the
 * one invariant that matters most this phase: every new research flag defaults
 * OFF, so committing this infrastructure to main cannot change production.
 */

test("setup tiers + lanes are the exact approved vocabulary", () => {
  assert.deepEqual([...SETUP_TIERS], [
    "PRODUCTION_QUALITY",
    "EXPERIMENTAL_VALID",
    "NEAR_MISS_VALID",
    "REJECTED_INVALID",
  ]);
  assert.deepEqual([...LANES], [
    "PRODUCTION_DISCORD",
    "PRIMARY_PAPER",
    "CHALLENGE_PAPER",
    "RESEARCH",
    "HISTORICAL_QUANT",
  ]);
});

test("REJECTED_INVALID is never tradeable; the other three are", () => {
  assert.equal(isTradeableTier("PRODUCTION_QUALITY"), true);
  assert.equal(isTradeableTier("EXPERIMENTAL_VALID"), true);
  assert.equal(isTradeableTier("NEAR_MISS_VALID"), true);
  assert.equal(isTradeableTier("REJECTED_INVALID"), false);
});

test("setupId is deterministic and scoped per trading day + contract", () => {
  const base = { strategyAgent: "call_0DTE", ticker: "nvda", direction: "bullish", horizon: "0DTE", optionSymbol: "O:NVDA260710C00210000" };
  const a = setupIdOf(base, "2026-07-10");
  const b = setupIdOf(base, "2026-07-10");
  const nextDay = setupIdOf(base, "2026-07-13");
  assert.equal(a, b, "same inputs → same id (dedup-safe)");
  assert.notEqual(a, nextDay, "new trading day → new episode id");
  assert.match(a, /^call_0DTE\|NVDA\|O:NVDA260710C00210000\|2026-07-10$/);
});

test("stock (no option symbol) folds direction+horizon into the identity", () => {
  const id = setupIdOf({ strategyAgent: "momentum_stock_long", ticker: "PLUG", direction: "bullish", horizon: "STOCK", optionSymbol: null }, "2026-07-10");
  assert.equal(id, "momentum_stock_long|PLUG|bullish:STOCK|2026-07-10");
});

test("SAFETY: every research feature flag defaults OFF (no env set)", () => {
  const f = researchFlags({});
  for (const [key, value] of Object.entries(f)) {
    assert.equal(value, false, `${key} must default OFF so committing infra cannot change production`);
  }
});

test("flags turn on only with an explicit '1'", () => {
  assert.equal(researchFlags({ RESEARCH_LANE_ENABLED: "1" }).researchLane, true);
  assert.equal(researchFlags({ RESEARCH_LANE_ENABLED: "true" }).researchLane, false, "only '1' enables");
  assert.equal(researchFlags({ RESEARCH_LANE_ENABLED: "0" }).researchLane, false);
});
