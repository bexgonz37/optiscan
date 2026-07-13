import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stockGateConfig, stockNowOnlyEligible, stockExtensionReason } from "../lib/stock-callout.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const NOW = Date.parse("2026-07-13T17:00:00Z"); // 1pm ET, regular session

/** A stock setup that passes EVERY gate except whatever the test varies. */
function base(over = {}) {
  return {
    ticker: "TEST", direction: "bullish", price: 100, bid: 99.98, ask: 100.02,
    quoteAsOfMs: NOW - 1000, confidence: 82, actionableNow: true, session: "regular",
    nowMs: NOW, vwap: 99.8, dayChangePct: 2.0, ...over,
  };
}

test("config exposes the anti-chase thresholds with sane defaults", () => {
  const cfg = stockGateConfig({});
  assert.equal(cfg.maxVwapExtensionPct, 2.5);
  assert.equal(cfg.maxDayRunPct, 6);
});

test("a clean, near-VWAP momentum setup still passes", () => {
  const r = stockNowOnlyEligible(base(), stockGateConfig({}));
  assert.equal(r.ok, true, r.reason);
});

test("a name that has already run too far on the day is blocked as a chase (USO case)", () => {
  // USO-like: up ~+10% on the day, price pushed to the after-hours high.
  const r = stockNowOnlyEligible(base({ dayChangePct: 10.2, session: "afterhours" }), stockGateConfig({ STOCK_EXTENDED_HOURS: "1" }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /extended: already \+10\.2% on the day/);
});

test("price too far above VWAP is blocked as a top-of-candle chase", () => {
  // price 100 vs VWAP 96 = +4.17% extended (> 2.5% default).
  const r = stockNowOnlyEligible(base({ vwap: 96, dayChangePct: 3 }), stockGateConfig({}));
  assert.equal(r.ok, false);
  assert.match(r.reason, /above VWAP/);
});

test("the gate is exactly at the threshold boundary (>= blocks)", () => {
  // dayChangePct exactly 6 → blocked; 5.9 → allowed.
  assert.equal(stockNowOnlyEligible(base({ dayChangePct: 6 }), stockGateConfig({})).ok, false);
  assert.equal(stockNowOnlyEligible(base({ dayChangePct: 5.9 }), stockGateConfig({})).ok, true);
});

test("missing VWAP / day-change does NOT fabricate an extension block (fail-open per dimension)", () => {
  // No vwap and no dayChangePct → extension guards skipped; other gates still pass.
  const r = stockNowOnlyEligible(base({ vwap: null, dayChangePct: null }), stockGateConfig({}));
  assert.equal(r.ok, true, r.reason);
});

test("thresholds set to 0 disable the anti-chase gate (fully overridable)", () => {
  const cfg = stockGateConfig({ STOCK_MAX_DAY_RUN_PCT: "0", STOCK_MAX_VWAP_EXT_PCT: "0" });
  const r = stockNowOnlyEligible(base({ dayChangePct: 25, vwap: 80 }), cfg);
  assert.equal(r.ok, true, "with the gate disabled even a huge run passes the other gates");
});

test("custom thresholds are honored", () => {
  // Tighten day-run to 3% → a +4% day is now a chase.
  const cfg = stockGateConfig({ STOCK_MAX_DAY_RUN_PCT: "3" });
  assert.equal(stockNowOnlyEligible(base({ dayChangePct: 4 }), cfg).ok, false);
});

// ── the shared helper (used by BOTH Discord and paper stock entry) ───────────
test("stockExtensionReason returns a reason when extended, null when clean", () => {
  const cfg = stockGateConfig({});
  assert.equal(stockExtensionReason({ price: 100, vwap: 99.8, dayChangePct: 2 }, cfg), null);
  assert.match(stockExtensionReason({ price: 100, vwap: 99.8, dayChangePct: 10 }, cfg), /on the day/);
  assert.match(stockExtensionReason({ price: 100, vwap: 96, dayChangePct: 3 }, cfg), /above VWAP/);
  // Day-run works from the alert's stored day move even with no VWAP (paper path).
  assert.match(stockExtensionReason({ price: 119.79, vwap: null, dayChangePct: 10.2 }, cfg), /\+10\.2% on the day/);
  assert.equal(stockExtensionReason({ price: null, vwap: null, dayChangePct: null }, cfg), null);
});

test("the paper stock-scalp path applies the SAME anti-chase gate (no chase paper trades)", () => {
  const src = read("lib/paper-engine.ts");
  assert.ok(/import \{ stockExtensionReason, stockGateConfig \} from "@\/lib\/stock-callout"/.test(src));
  const fn = src.slice(src.indexOf("export function autoEnterStockScalps"));
  const body = fn.slice(0, fn.indexOf("\nexport ", 1) === -1 ? fn.length : fn.indexOf("\nexport ", 1));
  assert.ok(/stockExtensionReason\(/.test(body), "paper stock entry checks the extension gate");
  assert.ok(/percent_move_at_alert/.test(body), "uses the alert's stored day move");
  assert.ok(/markStockRefused\(/.test(body), "terminally refuses a chase (not retried)");
});
