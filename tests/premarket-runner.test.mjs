import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSnapshotTickers } from "../lib/polygon-provider.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const policy = await import("../lib/stock-momentum-policy.ts");
const cfg = policy.stockMomentumPolicyConfig({});

// ── Part 3: premarket volume + gain formulas ────────────────────────────────

test("day-to-date volume INCLUDES premarket (min.av) when the RTH aggregate is still 0", () => {
  // Premarket: Polygon's day.v (regular-session aggregate) hasn't started, but
  // min.av carries today's accumulated volume including premarket.
  const [q] = parseSnapshotTickers([{
    ticker: "RUNR",
    day: { o: 0, h: 0, l: 0, c: 0, v: 0 },
    min: { c: 3.0, av: 1_200_000, t: Date.now() },
    prevDay: { c: 2.0 },
    lastTrade: { p: 3.0, t: Date.now() * 1e6 },
  }]);
  assert.equal(q.volume, 1_200_000, "premarket accumulated volume must not read as 0");
});

test("regular-hours volume takes the larger of day.v and min.av (no premarket regression)", () => {
  const [q] = parseSnapshotTickers([{
    ticker: "SPY",
    day: { o: 500, h: 505, l: 499, c: 503, v: 40_000_000 },
    min: { c: 503, av: 40_000_000, t: Date.now() },
    prevDay: { c: 498 },
    lastTrade: { p: 503, t: Date.now() * 1e6 },
  }]);
  assert.equal(q.volume, 40_000_000);
});

test("gain is computed from previous regular close using the FRESH premarket price", () => {
  // prev close $2.00, premarket last $3.00, day.c still 0 → +50%, not a fallback.
  const [q] = parseSnapshotTickers([{
    ticker: "RUNR",
    day: { o: 0, h: 0, l: 0, c: 0, v: 0 },
    min: { c: 3.0, av: 1_200_000, t: Date.now() },
    prevDay: { c: 2.0 },
    lastTrade: { p: 3.0, t: Date.now() * 1e6 },
  }]);
  assert.ok(Math.abs(q.changePercent - 50) < 0.001, `expected +50% got ${q.changePercent}`);
});

// ── Part 3: the exact incident example enters fast evaluation immediately ─────

test("prev close $2 → premarket $3 (+50%) with 1.2M volume passes the broad runner floor", () => {
  const [q] = parseSnapshotTickers([{
    ticker: "RUNR",
    day: { o: 0, h: 0, l: 0, c: 0, v: 0 },
    min: { c: 3.0, av: 1_200_000, t: Date.now() },
    prevDay: { c: 2.0 },
    lastTrade: { p: 3.0, t: Date.now() * 1e6 },
  }]);
  const elig = policy.broadStockEligibility(
    { symbol: q.symbol, price: q.price, dayVolume: q.volume, gainFromPrevClosePct: q.changePercent },
    cfg,
  );
  assert.equal(elig.ok, true, elig.reason);
});

test("valid fast acceleration on that runner reaches the fast-mover pass", () => {
  const decision = policy.fastStockMomentumEligibility({
    symbol: "RUNR", price: 3.0, dayVolume: 1_200_000, gainFromPrevClosePct: 50,
    direction: "bullish",
    ret10sPct: 0.5, ret30sPct: 1.2, ret60sPct: 1.8,
    velocityPctPerMin: 2.4, volumeAcceleration: 20, volumeRate: 8000,
    spreadPct: 0.5, quoteAgeMs: 900, aboveVwap: true, hodBreak: true,
    vwapDistPct: 1.4, classification: "FRESH_ACCELERATION",
  }, cfg);
  assert.equal(decision.ok, true, decision.reason);
});

// ── Part 4: slow grinders and falling names stay rejected ────────────────────

test("slow grinder stays rejected even when broad-eligible", () => {
  const d = policy.fastStockMomentumEligibility({
    symbol: "GRIND", price: 12, dayVolume: 3_000_000, gainFromPrevClosePct: 11,
    direction: "bullish",
    ret10sPct: 0.02, ret30sPct: 0.05, ret60sPct: 0.09,
    velocityPctPerMin: 0.2, volumeAcceleration: 1, volumeRate: 1200,
    spreadPct: 0.4, quoteAgeMs: 800, aboveVwap: true, hodBreak: false,
    vwapDistPct: 0.6, classification: "SLOW_GRINDER",
  }, cfg);
  assert.equal(d.ok, false);
  assert.equal(d.failedGate, "classification");
});

test("falling stock (bearish direction) never passes the bullish fast gate", () => {
  const d = policy.fastStockMomentumEligibility({
    symbol: "FALL", price: 9, dayVolume: 2_000_000, gainFromPrevClosePct: 12,
    direction: "bearish",
    ret10sPct: 0.5, ret30sPct: 1.1, ret60sPct: 1.6,
    velocityPctPerMin: 2.2, volumeAcceleration: 8, volumeRate: 3000,
    spreadPct: 0.5, quoteAgeMs: 700, aboveVwap: false, hodBreak: false,
    vwapDistPct: 0.5, classification: "FRESH_ACCELERATION",
  }, cfg);
  assert.equal(d.ok, false);
  assert.equal(d.failedGate, "direction");
});

// ── Part 2/7: discovery is genuinely broad, not the curated list only ────────

test("discovery pulls the WHOLE-MARKET snapshot and filters it by the broad floor", () => {
  const src = readFileSync(join(root, "lib/scanner-loop.ts"), "utf8");
  assert.match(src, /fetchMarketSnapshot\(\)/, "refreshDiscovery must query the whole-market snapshot");
  assert.match(src, /broadStockEligibility\(/, "broad snapshot must be filtered by the runner floor before ranking");
  assert.match(src, /STOCK_BROAD_DISCOVERY !== "0"/, "broad discovery is the default (opt-out only)");
});

test("fetchMarketSnapshot hits the ticker-less whole-market endpoint (all US stocks)", () => {
  const src = readFileSync(join(root, "lib/polygon-provider.js"), "utf8");
  assert.match(src, /export async function fetchMarketSnapshot/, "provider exposes a whole-market snapshot");
  // The whole-market call must NOT pass a tickers filter (that would re-curate it).
  const fn = src.slice(src.indexOf("export async function fetchMarketSnapshot"));
  const body = fn.slice(0, fn.indexOf("export async function fetchTopMovers"));
  assert.match(body, /markets\/stocks\/tickers"\)/, "no tickers= filter on the whole-market snapshot");
  assert.doesNotMatch(body, /tickers:/, "whole-market snapshot must not filter to a ticker list");
});
