import test from "node:test";
import assert from "node:assert/strict";
import { rankDiscovery, promotionSet, moveVelocityPctPerMin, discoveryRankConfig } from "../lib/discovery-ranking.ts";

const cfg = discoveryRankConfig({});
const NOW = 1_000_000_000_000;
const prevAt = (changePercent, secAgo) => ({ changePercent, atMs: NOW - secAgo * 1000 });

test("move-velocity is Δmove/min from the prior snapshot, null when stale/missing", () => {
  assert.equal(moveVelocityPctPerMin(3.0, prevAt(2.0, 30), NOW), 2.0); // +1% in 30s → 2%/min
  assert.equal(moveVelocityPctPerMin(3.0, undefined, NOW), null);
  assert.equal(moveVelocityPctPerMin(3.0, prevAt(2.0, 600), NOW), null); // 10min stale
});

test("fresh fast mover outranks a slow grinder that is already up more", () => {
  const prev = new Map([
    ["FAST", prevAt(10.0, 30)],  // was +10.0%, now +12.0% -> +4%/min fresh accel
    ["SLOW", prevAt(14.9, 30)],  // was +14.9%, now +15.0% -> ~0.2%/min, already extended-ish
  ]);
  const quotes = [
    { symbol: "FAST", price: 20, changePercent: 12.0, volume: 2_000_000 },
    { symbol: "SLOW", price: 20, changePercent: 15.0, volume: 2_000_000 },
  ];
  const ranked = rankDiscovery(quotes, prev, NOW, cfg);
  const fast = ranked.find((r) => r.symbol === "FAST");
  const slow = ranked.find((r) => r.symbol === "SLOW");
  assert.ok(fast.rank < slow.rank, `FAST rank ${fast.rank} < SLOW rank ${slow.rank}`);
  assert.ok(fast.score > slow.score);
});

test("exceptional fresh mover is flagged for immediate promotion", () => {
  const prev = new Map([["ROCKET", prevAt(10.5, 20)]]); // +10.5% -> +12.0% in 20s = 4.5%/min
  const ranked = rankDiscovery([{ symbol: "ROCKET", price: 15, changePercent: 12.0, volume: 500_000 }], prev, NOW, cfg);
  assert.equal(ranked[0].immediatePromote, true);
  assert.match(ranked[0].reason, /immediate promote/);
});

test("a reversal (giving back gains) gets no fresh-accel boost", () => {
  const prev = new Map([["FADE", prevAt(14.0, 30)]]); // was +14%, now +12% -> negative velocity
  const ranked = rankDiscovery([{ symbol: "FADE", price: 15, changePercent: 12.0, volume: 500_000 }], prev, NOW, cfg);
  assert.equal(ranked[0].immediatePromote, false);
  assert.ok(ranked[0].moveVelocityPctPerMin < 0);
});

test("a fresh mover beats an extended-and-slow one (not up-a-lot wins)", () => {
  const prev = new Map([
    ["FRESH", prevAt(10.0, 30)],  // +10% -> +12% = fresh +4%/min
    ["EXTSLOW", prevAt(23.9, 30)], // +24% day but only +0.2%/min and extended
  ]);
  const ranked = rankDiscovery([
    { symbol: "FRESH", price: 20, changePercent: 12.0, volume: 1_000_000 },
    { symbol: "EXTSLOW", price: 20, changePercent: 24.0, volume: 1_000_000 },
  ], prev, NOW, cfg);
  assert.ok(
    ranked.find((r) => r.symbol === "FRESH").rank < ranked.find((r) => r.symbol === "EXTSLOW").rank,
    "the fresh accelerator outranks the already-extended slow mover",
  );
});

test("below-min-volume, out-of-band price, and sub-10% movers are filtered out", () => {
  const ranked = rankDiscovery([
    { symbol: "THIN", price: 20, changePercent: 12, volume: 100 },
    { symbol: "ZERO", price: 0, changePercent: 12, volume: 5_000_000 },
    { symbol: "META", price: 650, changePercent: 12, volume: 5_000_000 },
    { symbol: "FLAT", price: 20, changePercent: 9.9, volume: 5_000_000 },
    { symbol: "OK", price: 20, changePercent: 12, volume: 5_000_000 },
  ], new Map(), NOW, cfg);
  assert.deepEqual(ranked.map((r) => r.symbol), ["OK"]);
});

test("promotionSet includes an immediate-promote name beyond topN", () => {
  const smallCfg = { ...cfg, topN: 1 };
  const prev = new Map([["ROCKET", prevAt(10.2, 20)]]);
  const quotes = [
    { symbol: "BIG", price: 20, changePercent: 18, volume: 9_000_000 },   // ranks #1 on volume+move
    { symbol: "MID", price: 20, changePercent: 13.0, volume: 8_000_000 },
    { symbol: "ROCKET", price: 20, changePercent: 12.0, volume: 500_000 },  // fresh accel -> immediate
  ];
  const ranked = rankDiscovery(quotes, prev, NOW, smallCfg);
  const promoted = promotionSet(ranked, smallCfg).map((r) => r.symbol);
  assert.ok(promoted.includes("ROCKET"), "immediate-promote survives a topN=1 cut");
});
