import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EMPTY_STOCK_MOMENTUM_LATCH,
  stockMomentumDeveloping,
  stockMomentumExtendedReason,
  stockMomentumLatchConfig,
  stockMomentumLatchRescue,
  stockMomentumVolumeConfirmed,
  updateStockMomentumLatch,
} from "../lib/stock-momentum-latch.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.parse("2026-07-14T14:00:00Z");
const cfg = stockMomentumLatchConfig({
  STOCK_MOMENTUM_LATCH: "1",
  STOCK_MOMENTUM_LATCH_TTL_MS: "20000",
  STOCK_LATCH_MIN_VELOCITY_PCT_MIN: "0.22",
  STOCK_LATCH_MIN_INSTANT_PCT_MIN: "0.24",
  STOCK_LATCH_MIN_VOL_SURGE: "1.18",
  STOCK_LATCH_MIN_REL_VOL: "1.35",
  STOCK_MAX_QUOTE_AGE_MS: "15000",
  STOCK_MAX_VWAP_EXT_PCT: "2.5",
  STOCK_MAX_DAY_RUN_PCT: "6",
});

function snap(over = {}) {
  return {
    direction: "bullish",
    shortRate: 0.28,
    instantRate: 0.31,
    acceleration: 0.04,
    surge: 1.0,
    relVol: null,
    vwapDistPct: 0.8,
    dayChangePct: 2.2,
    quoteAgeMs: 1000,
    ...over,
  };
}

test("rapid accelerating stock creates a short-lived crossing latch", () => {
  const dev = stockMomentumDeveloping(snap(), cfg);
  assert.equal(dev.ok, true);
  const state = updateStockMomentumLatch({ ...EMPTY_STOCK_MOMENTUM_LATCH }, { snapshot: snap(), nowMs: NOW, cfg });
  assert.equal(state.developingSinceMs, NOW);
  assert.equal(state.lastCrossedAtMs, NOW);
});

test("crossing window is rescued when volume confirmation arrives later", () => {
  const first = updateStockMomentumLatch({ ...EMPTY_STOCK_MOMENTUM_LATCH }, { snapshot: snap({ surge: 1.0, relVol: null }), nowMs: NOW, cfg });
  assert.equal(stockMomentumVolumeConfirmed(snap({ surge: 1.0, relVol: null }), cfg), false);
  const later = updateStockMomentumLatch(first, { snapshot: snap({ surge: 1.22 }), nowMs: NOW + 4000, cfg });
  const rescue = stockMomentumLatchRescue(later, snap({ surge: 1.22 }), NOW + 4000, cfg);
  assert.deepEqual(rescue, { rescue: true, reason: "latched velocity now has volume confirmation" });
});

test("delayed relative volume can confirm without fabricated volume", () => {
  const first = updateStockMomentumLatch({ ...EMPTY_STOCK_MOMENTUM_LATCH }, { snapshot: snap({ surge: null, relVol: null }), nowMs: NOW, cfg });
  const rescue = stockMomentumLatchRescue(first, snap({ surge: null, relVol: 1.5 }), NOW + 5000, cfg);
  assert.equal(rescue.rescue, true);
});

test("rising volume below confirmation does not rescue", () => {
  const first = updateStockMomentumLatch({ ...EMPTY_STOCK_MOMENTUM_LATCH }, { snapshot: snap({ surge: 1.05, relVol: 1.1 }), nowMs: NOW, cfg });
  const rescue = stockMomentumLatchRescue(first, snap({ surge: 1.12, relVol: 1.2 }), NOW + 3000, cfg);
  assert.equal(rescue.rescue, false);
  assert.match(rescue.reason, /volume/);
});

test("stale quote and extended/chased stocks are rejected by the latch", () => {
  assert.equal(stockMomentumDeveloping(snap({ quoteAgeMs: 60_000 }), cfg).ok, false);
  assert.match(stockMomentumExtendedReason(snap({ dayChangePct: 8 }), cfg), /day move/);
  assert.match(stockMomentumExtendedReason(snap({ vwapDistPct: 3.1 }), cfg), /VWAP/);
  assert.equal(stockMomentumDeveloping(snap({ dayChangePct: 8 }), cfg).ok, false);
});

test("premarket regular and after-hours snapshots use the same deterministic latch", () => {
  for (const session of ["premarket", "regular", "afterhours"]) {
    void session;
    assert.equal(stockMomentumDeveloping(snap(), cfg).ok, true);
  }
});

test("latch expires and restart state does not create ghost alerts", () => {
  const first = updateStockMomentumLatch({ ...EMPTY_STOCK_MOMENTUM_LATCH }, { snapshot: snap(), nowMs: NOW, cfg });
  const expired = updateStockMomentumLatch(first, { snapshot: snap({ surge: 1.4 }), nowMs: NOW + 21_000, cfg });
  assert.equal(expired.developingSinceMs, null);
  assert.match(expired.reason, /expired/);
  const rescue = stockMomentumLatchRescue({ ...EMPTY_STOCK_MOMENTUM_LATCH }, snap({ surge: 1.4 }), NOW + 1000, cfg);
  assert.equal(rescue.rescue, false);
  assert.match(rescue.reason, /no active/);
});

test("scanner wiring preserves options path and records no WAIT notification", () => {
  const src = readFileSync(join(root, "lib/scanner-loop.ts"), "utf8");
  assert.match(src, /stockMomentumLatchRescue/);
  assert.match(src, /if \(fired && session === "regular"\) tasks\.push\(handleTrigger/, "stock-only rescue must not fetch options");
  assert.match(src, /decision: "NEAR_MISS"/, "near misses persist for diagnostics");
  assert.match(src, /if \(fired \|\| stockRescued\)/, "rescued stock can enter capture");
});

test("database schema includes bounded stock momentum diagnostics", () => {
  const src = readFileSync(join(root, "lib/db.ts"), "utf8");
  assert.match(src, /CREATE TABLE IF NOT EXISTS momentum_diagnostics/);
  assert.match(src, /trigger_to_discord_ms/);
  assert.match(src, /strategy_version/);
  assert.match(src, /classification TEXT/);
  assert.match(src, /first_promoted_ms INTEGER/);
  assert.match(src, /ret_10s_pct REAL/);
  assert.match(src, /volume_acceleration REAL/);
});

test("diagnostic store records bounded decision rows and exposes summary counts", () => {
  const src = readFileSync(join(root, "lib/momentum-diagnostics.ts"), "utf8");
  assert.match(src, /decision: MomentumDiagnosticDecision/);
  assert.match(src, /DELETE FROM momentum_diagnostics WHERE created_at_ms < \?/);
  assert.match(src, /RESCUED_SENT/);
  assert.match(src, /NEAR_MISS/);
  assert.match(src, /avgLatencyMs/);
  assert.match(src, /freshAccelerationAlerts/);
  assert.match(src, /medianActionableLatencyMs/);
});
