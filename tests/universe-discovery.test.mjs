import test from "node:test";
import assert from "node:assert/strict";
import { getZeroDteUniverse, getZeroDteDiscoveryUniverse, getCoreWatchUniverse, isCoreSymbol } from "../lib/universe.js";

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

// ── Core Watch (default UI universe) ─────────────────────────────────────────
test("core watch: user's names present and always inside the 1s loop universe", () => {
  const core = getCoreWatchUniverse({});
  for (const t of ["AAPL", "NVDA", "META", "TSLA", "AMZN", "MSFT", "SPY", "QQQ", "HOOD", "SPCX"]) {
    assert.ok(core.includes(t), `core watch missing ${t}`);
  }
  assert.ok(core.length >= 16 && core.length <= 20, `core watch should be ~18, got ${core.length}`);
  const loop = getZeroDteUniverse({});
  for (const t of core) assert.ok(loop.includes(t), `1s loop must scan core name ${t}`);
});

test("core watch: isCoreSymbol + env override", () => {
  assert.equal(isCoreSymbol("AAPL", {}), true);
  assert.equal(isCoreSymbol("aapl", {}), true);
  assert.equal(isCoreSymbol("WULF", {}), false); // extended universe
  assert.equal(isCoreSymbol("AAPL", { SCANNER_CORE_WATCH: "TSLA,NVDA" }), false);
  assert.equal(isCoreSymbol("TSLA", { SCANNER_CORE_WATCH: "TSLA,NVDA" }), true);
});
