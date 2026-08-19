/**
 * tests/tier2-priority.test.mjs
 *
 * The 2026-08-19 MRNA coverage gap, pinned.
 *
 * MRNA cleared Tier-2 eligibility with ~$2.3B of dollar volume against a $20M
 * floor and produced NO OptiScan record of any kind — no scanner row, no case,
 * no NBBO. It was never strategy-rejected because it was never looked at. The
 * cause was `uni.slice(0, 25)` over a list in PROVIDER ORDER: measured against
 * the live snapshot that morning, the eligible universe was 1,347 symbols, MRNA
 * sat at index 605, and it ranked 5th of 1,347 by |day move|. The 25 taken
 * included a short-duration treasury ETF and a gold trust.
 *
 * These tests assert the three properties that failure violated, plus the two
 * that must NOT change: the budget, and the fallback for callers that inject no
 * ranked source.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  rankTier2,
  selectTier2Cycle,
  tier2PriorityConfig,
  DEFAULT_TIER2_PRIORITY,
} from "../lib/research/options/tier2-priority.ts";

/** The shape of that morning's eligible universe: a few real movers in a sea of ETFs. */
function universe({ size = 1347, moverIndex = 605 } = {}) {
  const out = [];
  for (let i = 0; i < size; i += 1) {
    out.push({
      symbol: `SYM${String(i).padStart(4, "0")}`,
      changePercent: 0.3,                 // the mass of the universe barely moves
      dayDollarVolume: 50_000_000 + i,    // all comfortably past the $20M gate
    });
  }
  // MRNA, buried where provider order put it.
  out[moverIndex] = { symbol: "MRNA", changePercent: 133.4, dayDollarVolume: 2_300_000_000 };
  // The other genuine movers from the same snapshot.
  out[12] = { symbol: "MRNX", changePercent: 264.0, dayDollarVolume: 120_000_000 };
  out[900] = { symbol: "RDAC", changePercent: 199.8, dayDollarVolume: 90_000_000 };
  return out;
}

test("the day's largest mover is observed on the FIRST cycle, from index 605", () => {
  const uni = universe();
  assert.equal(uni[605].symbol, "MRNA", "fixture places MRNA where provider order put it");
  assert.ok(
    !uni.slice(0, 25).some((c) => c.symbol === "MRNA"),
    "and the OLD selection could never have reached it",
  );

  const sel = selectTier2Cycle(uni, 0, 25);
  assert.ok(sel.selected.includes("MRNA"), "ranking must reach it on cycle 1");
  assert.ok(sel.priority.includes("MRNA"), "and it must hold a PRIORITY slot, not a rotation slot");
  assert.ok(sel.priority.includes("MRNX") && sel.priority.includes("RDAC"));
});

test("an exceptional mover keeps its slot every cycle while it stays exceptional", () => {
  const uni = universe();
  let cursor = 0;
  for (let cycle = 0; cycle < 40; cycle += 1) {
    const sel = selectTier2Cycle(uni, cursor, 25);
    assert.ok(sel.selected.includes("MRNA"), `cycle ${cycle} must still observe the mover`);
    cursor = sel.nextCursor;
  }
});

test("nothing starves: every eligible symbol is reached in bounded cycles", () => {
  // Small universe so full coverage is checkable exactly.
  const uni = Array.from({ length: 60 }, (_, i) => ({
    symbol: `S${i}`, changePercent: 0.1, dayDollarVolume: 25_000_000,
  }));
  uni[0] = { symbol: "HOT", changePercent: 90, dayDollarVolume: 25_000_000 };

  const seen = new Set();
  let cursor = 0;
  const first = selectTier2Cycle(uni, 0, 25);
  // 1 priority slot taken, so 24 rotate; 59 rotating names => 3 cycles.
  assert.equal(first.cyclesForFullCoverage, Math.ceil(59 / 24));
  for (let cycle = 0; cycle < first.cyclesForFullCoverage; cycle += 1) {
    const sel = selectTier2Cycle(uni, cursor, 25);
    sel.selected.forEach((s) => seen.add(s));
    cursor = sel.nextCursor;
  }
  assert.equal(seen.size, 60, "the whole eligible universe is covered within the reported cycles");
});

test("the priority band can never consume every slot", () => {
  // Everything is exceptional — the pathological day.
  const uni = Array.from({ length: 500 }, (_, i) => ({
    symbol: `M${String(i).padStart(3, "0")}`, changePercent: 50 + i, dayDollarVolume: 30_000_000,
  }));
  const sel = selectTier2Cycle(uni, 0, 25);
  assert.equal(sel.priority.length, DEFAULT_TIER2_PRIORITY.maxPrioritySlots);
  assert.ok(sel.rotated.length > 0, "rotation slots always remain, so nothing is frozen out");
  assert.equal(sel.selected.length, 25);

  // And rotation still advances across cycles under maximum priority pressure.
  const seen = new Set(sel.selected);
  let cursor = sel.nextCursor;
  for (let i = 0; i < 5; i += 1) {
    const s = selectTier2Cycle(uni, cursor, 25);
    s.selected.forEach((x) => seen.add(x));
    cursor = s.nextCursor;
  }
  assert.ok(seen.size > 25, "later cycles reach names the first cycle did not");
});

test("THE BUDGET IS UNCHANGED — exactly the configured slot count, never more", () => {
  for (const size of [0, 1, 10, 25, 26, 1347]) {
    const uni = universe({ size: Math.max(size, 1) }).slice(0, size);
    const sel = selectTier2Cycle(uni, 0, 25);
    assert.equal(sel.selected.length, Math.min(25, uni.length), `size ${size}`);
    assert.equal(new Set(sel.selected).size, sel.selected.length, "and no symbol is fetched twice");
  }
});

test("the order is reproducible — ties break deterministically, not by input order", () => {
  const a = [
    { symbol: "BBB", changePercent: 20, dayDollarVolume: 100 },
    { symbol: "AAA", changePercent: 20, dayDollarVolume: 100 },
    { symbol: "CCC", changePercent: 20, dayDollarVolume: 999 },
  ];
  const forward = rankTier2(a).map((r) => r.symbol);
  const reversed = rankTier2([...a].reverse()).map((r) => r.symbol);
  assert.deepEqual(forward, reversed, "input order must not affect the result");
  assert.deepEqual(forward, ["CCC", "AAA", "BBB"], "dollar volume breaks the move tie, then symbol");
});

test("liquidity is a gate upstream, not a second weight — a huge quiet name loses to a small mover", () => {
  const ranked = rankTier2([
    { symbol: "MEGA", changePercent: 0.4, dayDollarVolume: 20_000_000_000 },
    { symbol: "SMALL", changePercent: 40, dayDollarVolume: 21_000_000 },
  ]);
  assert.equal(ranked[0].symbol, "SMALL");
});

test("direction is irrelevant to observation — a big DOWN move ranks like a big up move", () => {
  const ranked = rankTier2([
    { symbol: "UP", changePercent: 30, dayDollarVolume: 100 },
    { symbol: "DOWN", changePercent: -45, dayDollarVolume: 100 },
  ]);
  assert.equal(ranked[0].symbol, "DOWN", "puts are opportunities too; observation must not be long-biased");
});

test("config is env-overridable and defaults are the documented ones", () => {
  assert.deepEqual(tier2PriorityConfig({}), { exceptionalMovePct: 10, maxPrioritySlots: 15 });
  assert.deepEqual(
    tier2PriorityConfig({ OPTIONS_TIER2_EXCEPTIONAL_MOVE_PCT: "25", OPTIONS_TIER2_MAX_PRIORITY_SLOTS: "5" }),
    { exceptionalMovePct: 25, maxPrioritySlots: 5 },
  );
});
