import test from "node:test";
import assert from "node:assert/strict";
import { stickyMembership, makeStickyState, WATCH_DWELL_MS } from "../lib/sticky-list.ts";
import { computeStockVerdict as stockVerdict } from "../lib/stock-signals.ts";

const T = 1_800_000_000_000;

// ── Watchlist membership dwell (the "flashing symbols" fix) ──
test("a symbol that stops qualifying stays listed as cooling for the dwell", () => {
  const st = makeStickyState();
  let r = stickyMembership(["RIVN", "SPY"], st, T);
  assert.deepEqual(r.symbols, ["RIVN", "SPY"]);
  // next tick RIVN no longer qualifies — must NOT vanish
  r = stickyMembership(["SPY"], st, T + 1000);
  assert.ok(r.symbols.includes("RIVN"), "RIVN stays listed");
  assert.ok(r.cooling.has("RIVN"), "…marked cooling");
  assert.ok(!r.cooling.has("SPY"));
  // after the dwell it drops
  r = stickyMembership(["SPY"], st, T + WATCH_DWELL_MS + 1001);
  assert.ok(!r.symbols.includes("RIVN"), "dropped after dwell");
});

test("re-qualifying clears the cooling state and resets the clock", () => {
  const st = makeStickyState();
  stickyMembership(["RIVN"], st, T);
  stickyMembership([], st, T + 1000);
  const r = stickyMembership(["RIVN"], st, T + 2000);
  assert.ok(!r.cooling.has("RIVN"));
  const later = stickyMembership([], st, T + 2000 + WATCH_DWELL_MS - 1);
  assert.ok(later.symbols.includes("RIVN"), "dwell measured from last qualification");
});

test("cooling list is bounded so a volatile day can't flood the UI", () => {
  const st = makeStickyState();
  stickyMembership(Array.from({ length: 30 }, (_, i) => `SYM${i}`), st, T);
  const r = stickyMembership([], st, T + 1000);
  assert.ok(r.symbols.length <= 10, `bounded (got ${r.symbols.length})`);
});

// ── Stock day-trend alignment (the "NVDA short" fix) ──
const BASE = {
  direction: "bearish", directionConfidence: 80, shortRate: -0.4, accel: -0.02,
  surge: 2.5, relVol: 3, efficiency: 0.6, aboveVwap: false,
  hodBreak: false, lodBreak: false,
};

test("a 10-second bearish read on a stock UP big on the day is WAIT, not SHORT", () => {
  const v = stockVerdict({ ...BASE, movePct: 3.2 });
  assert.equal(v.action, "WAIT", "counter-day-trend short blocked");
  assert.match(v.reason, /against the day trend/);
});

test("the same short WITH an LOD break is structural — allowed through", () => {
  const v = stockVerdict({ ...BASE, movePct: 3.2, lodBreak: true });
  assert.notEqual(v.reason.includes("against the day trend"), true);
});

test("a short aligned with a down day is unaffected", () => {
  const v = stockVerdict({ ...BASE, movePct: -2.1 });
  assert.ok(!String(v.reason).includes("against the day trend"));
});

test("counter-trend LONG gets the mirrored treatment", () => {
  const v = stockVerdict({
    ...BASE, direction: "bullish", shortRate: 0.4, aboveVwap: true, movePct: -2.5,
  });
  assert.equal(v.action, "WAIT");
  assert.match(v.reason, /needs an HOD break/);
});

test("small day moves (±0.75%) never trip the gate — intraday reversals stay tradable", () => {
  const v = stockVerdict({ ...BASE, movePct: 0.4 });
  assert.ok(!String(v.reason).includes("against the day trend"));
});
