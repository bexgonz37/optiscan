import test from "node:test";
import assert from "node:assert/strict";
import { simulateFill, defaultFillConfig, intrinsicValue } from "../lib/paper-fill-model.ts";

const NOW = Date.parse("2026-07-09T15:00:00Z");
const cfg = defaultFillConfig({});
const q = (bid, ask, over = {}) => ({
  optionSymbol: "O:SPY_C500", bid, ask,
  mid: bid != null && ask != null ? +((bid + ask) / 2).toFixed(4) : null,
  spreadPct: bid && ask ? +(((ask - bid) / ((ask + bid) / 2)) * 100).toFixed(2) : null,
  asOfMs: NOW, ...over,
});
const buy = (over = {}) => ({ side: "buy_to_open", assetClass: "option", units: 1, limit: 1.25, session: "regular", ...over });
const sell = (over = {}) => ({ side: "sell_to_close", assetClass: "option", units: 1, limit: null, marketableExit: true, session: "regular", ...over });

// ── conservative entry ───────────────────────────────────────────────────────

test("long entry pays ask + bounded slippage, never the mid, capped at the limit", () => {
  const r = simulateFill(buy({ limit: 1.25 }), q(1.10, 1.20), cfg, NOW);
  assert.equal(r.filled, true);
  // ask 1.20 + slip (0.25 * 0.10 = 0.025) = 1.225, under the 1.25 limit
  assert.ok(r.price > 1.20 && r.price <= 1.25, `price ${r.price}`);
  assert.notEqual(r.price, q(1.10, 1.20).mid, "must not fill at mid");
  assert.ok(r.fees > 0, "fees applied");
  assert.ok(r.assumptions.slippageApplied > 0);
});

test("entry never fills above the limit (limit-order semantics)", () => {
  const r = simulateFill(buy({ limit: 1.15 }), q(1.10, 1.20), cfg, NOW);
  assert.equal(r.filled, false);
  assert.match(r.reason, /above limit/);
});

test("entry slippage is capped by maxSlippageAbs and never exceeds the limit", () => {
  const wide = defaultFillConfig({ PAPER_ENTRY_SLIPPAGE_FRAC: "1", PAPER_MAX_SLIPPAGE_ABS: "0.03", PAPER_FILL_MAX_SPREAD_PCT: "50" });
  const r = simulateFill(buy({ limit: 5 }), q(1.0, 1.4), wide, NOW);
  assert.equal(r.filled, true);
  assert.ok(r.assumptions.slippageApplied <= 0.03 + 1e-9, `slip ${r.assumptions.slippageApplied}`);
});

// ── conservative exit ────────────────────────────────────────────────────────

test("exit leaves at bid − bounded slippage, floored at 0", () => {
  const r = simulateFill(sell(), q(1.50, 1.60), cfg, NOW);
  assert.equal(r.filled, true);
  assert.ok(r.price < 1.50, "gives up slippage vs the bid");
  assert.ok(r.price >= 0);
});

// ── invalid quotes rejected ──────────────────────────────────────────────────

test("no fill on one-sided / missing quote", () => {
  assert.equal(simulateFill(buy(), q(null, 1.2), cfg, NOW).filled, false);
  assert.equal(simulateFill(buy(), q(1.1, null), cfg, NOW).filled, false);
});

test("no fill on crossed quote (ask < bid)", () => {
  const r = simulateFill(buy({ limit: 5 }), q(1.30, 1.10), cfg, NOW);
  assert.equal(r.filled, false);
  assert.match(r.reason, /crossed/);
});

test("no fill on a stale quote", () => {
  const r = simulateFill(buy(), q(1.1, 1.2, { asOfMs: NOW - 120_000 }), cfg, NOW);
  assert.equal(r.filled, false);
  assert.match(r.reason, /stale/);
});

test("no fill when spread exceeds the fill-protection limit", () => {
  const r = simulateFill(buy({ limit: 5 }), q(1.0, 1.6), cfg, NOW); // 46% spread
  assert.equal(r.filled, false);
  assert.match(r.reason, /spread/);
});

test("no fill on invalid unit count", () => {
  assert.equal(simulateFill(buy({ units: 0 }), q(1.1, 1.2), cfg, NOW).filled, false);
  assert.equal(simulateFill(buy({ units: NaN }), q(1.1, 1.2), cfg, NOW).filled, false);
});

// ── extended-hours slippage ──────────────────────────────────────────────────

test("extended-hours widens slippage vs regular session", () => {
  // tight spread so the abs cap does not bind and the multiplier is visible
  const reg = simulateFill(buy({ session: "regular", limit: 5 }), q(1.04, 1.12), cfg, NOW);
  const ext = simulateFill(buy({ session: "premarket", limit: 5 }), q(1.04, 1.12), cfg, NOW);
  assert.ok(ext.assumptions.slippageApplied > reg.assumptions.slippageApplied, "premarket slips more");
});

// ── fees ─────────────────────────────────────────────────────────────────────

test("fees scale with units and are recorded as a separate line", () => {
  const r = simulateFill(buy({ units: 3, limit: 5 }), q(1.10, 1.20), cfg, NOW);
  assert.equal(r.filled, true);
  assert.equal(r.fees, +(cfg.feePerContract * 3).toFixed(2));
});

// ── intrinsic value at expiry ────────────────────────────────────────────────

test("intrinsicValue: ITM call/put positive, OTM worthless", () => {
  assert.equal(intrinsicValue("call", 500, 503.4), 3.4);
  assert.equal(intrinsicValue("call", 500, 498), 0);
  assert.equal(intrinsicValue("put", 500, 496.5), 3.5);
  assert.equal(intrinsicValue("put", 500, 502), 0);
  assert.equal(intrinsicValue("call", null, 500), 0, "missing strike → worthless, never fabricated");
});
