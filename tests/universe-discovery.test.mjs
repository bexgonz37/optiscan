import test from "node:test";
import assert from "node:assert/strict";
import { getZeroDteUniverse, getZeroDteDiscoveryUniverse } from "../lib/universe.js";

test("0DTE extras append without replacing the liquid core", () => {
  const symbols = getZeroDteUniverse({ SCANNER_0DTE_UNIVERSE_EXTRA: "SPCX, RIVN" });
  assert.ok(symbols.includes("SPY"));
  assert.ok(symbols.includes("SPCX"));
  assert.ok(symbols.includes("RIVN"));
});

test("explicit 0DTE override still accepts extras and deduplicates", () => {
  assert.deepEqual(
    getZeroDteUniverse({ SCANNER_0DTE_UNIVERSE: "SPCX,SPY", SCANNER_0DTE_UNIVERSE_EXTRA: "SPY,NVDA" }),
    ["SPCX", "SPY", "NVDA"],
  );
});

test("broad discovery defaults beyond 35 names and supports override", () => {
  const defaults = getZeroDteDiscoveryUniverse({});
  assert.ok(defaults.length > 35);
  assert.ok(defaults.includes("SPCX"));
  assert.deepEqual(getZeroDteDiscoveryUniverse({ SCANNER_DISCOVERY_UNIVERSE: "SPCX, SOFI,SPCX" }), ["SPCX", "SOFI"]);
});
