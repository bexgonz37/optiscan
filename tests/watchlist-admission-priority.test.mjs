/**
 * watchlist-admission-priority.test.mjs
 *
 * Regression guard for the defect where the professional Watchlist's slot
 * allocation was the alphabet.
 *
 * The old admission was `[...static, ...momentum, ...catalysts].sort().slice(0, 60)`
 * against a 78-symbol curated universe. Nothing failed — a slice always
 * succeeds — so the entire XL* sector-ETF family was cut on every run for as
 * long as the code existed. The tests below are written so that the SAME class
 * of defect fails loudly next time: they assert the property (nothing is cut
 * for sorting late) rather than the current symbol list.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ADMISSION_BAND_ORDER,
  DEFAULT_ADMISSION_PRIORITY,
  GUARANTEED_BANDS,
  allocateAdmissionSlots,
  rankMomentumForSlots,
  slotsRequiredForFullCoverage,
} from "../lib/research/watchlist/admission-priority.ts";
import {
  CORE_INDEX_SYMBOLS,
  SECTOR_ETF_SYMBOLS,
  LARGE_CAP_LIQUID_SYMBOLS,
  staticUniverseSymbols,
} from "../lib/research/watchlist/universe.ts";
import { providerCallsRequiredFor } from "../lib/research/watchlist/professional-runner.ts";
import { momentumCandidatesFromMoversOnDb } from "../lib/research/watchlist/momentum-from-movers.ts";

/** The 18 names the old `.sort().slice(0, 60)` cut on every single run. */
const PREVIOUSLY_STARVED = [
  "V", "VZ", "WFC", "WMT", "XBI", "XLB", "XLC", "XLE", "XLF", "XLI",
  "XLK", "XLP", "XLRE", "XLU", "XLV", "XLY", "XOM", "XOP",
];

const baseInput = (over = {}) => ({
  core: CORE_INDEX_SYMBOLS,
  sectorEtf: SECTOR_ETF_SYMBOLS,
  largeCap: LARGE_CAP_LIQUID_SYMBOLS,
  momentum: [],
  catalysts: [],
  ...over,
  config: {
    maxSymbols: 94,
    maxCatalystSlots: DEFAULT_ADMISSION_PRIORITY.maxCatalystSlots,
    maxMomentumSlots: DEFAULT_ADMISSION_PRIORITY.maxMomentumSlots,
    rotationCursor: 0,
    ...(over.config ?? {}),
  },
});

test("the whole curated universe is admitted at the shipped default cap", () => {
  const res = allocateAdmissionSlots(baseInput());
  const admitted = new Set(res.symbols);
  for (const s of staticUniverseSymbols()) {
    assert.ok(admitted.has(s), `curated symbol ${s} was not admitted`);
  }
  assert.deepEqual(res.deferred, [], "nothing should be deferred at the default cap");
  assert.deepEqual(res.starvedBands, []);
  assert.equal(res.guaranteedCoverageBroken, false);
});

test("late-alphabet ETFs are not systematically excluded", () => {
  const res = allocateAdmissionSlots(baseInput());
  const admitted = new Set(res.symbols);
  for (const s of PREVIOUSLY_STARVED) {
    assert.ok(admitted.has(s), `${s} is starved again — the alphabet is back`);
  }
});

test("the last-sorting symbol is admitted at every cap that fits the guaranteed bands", () => {
  // The property, not the list: whatever sorts last must not be the thing that
  // gets cut. Checked across caps so a future universe growth cannot reintroduce
  // alphabetical starvation quietly.
  const lastAlphabetically = [...staticUniverseSymbols()].sort().at(-1);
  for (const maxSymbols of [28, 40, 60, 78, 94, 120]) {
    const res = allocateAdmissionSlots(baseInput({ config: { maxSymbols } }));
    if (maxSymbols >= CORE_INDEX_SYMBOLS.length + SECTOR_ETF_SYMBOLS.length) {
      assert.equal(res.guaranteedCoverageBroken, false, `cap ${maxSymbols} broke guaranteed coverage`);
      for (const s of SECTOR_ETF_SYMBOLS) {
        assert.ok(res.symbols.includes(s), `sector ETF ${s} cut at cap ${maxSymbols}`);
      }
    }
    if (maxSymbols >= staticUniverseSymbols().length) {
      assert.ok(res.symbols.includes(lastAlphabetically), `cap ${maxSymbols} cut ${lastAlphabetically}`);
    }
  }
});

test("normal core symbols remain represented", () => {
  const res = allocateAdmissionSlots(baseInput());
  for (const s of CORE_INDEX_SYMBOLS) assert.ok(res.symbols.includes(s));
  for (const s of ["AAPL", "NVDA", "TSLA", "SPY", "QQQ", "IWM"]) {
    assert.ok(res.symbols.includes(s), `${s} missing`);
  }
});

test("an MRNA-like extreme mover earns a watchlist slot", () => {
  const res = allocateAdmissionSlots(baseInput({
    momentum: [
      { symbol: "MRNA", absMovePct: 133.2, dollarVolume: 2_300_000_000 },
      { symbol: "SOMEQUIETNAME", absMovePct: 3.4, dollarVolume: 60_000_000 },
    ],
  }));
  assert.ok(res.symbols.includes("MRNA"), "MRNA did not earn a slot");
  assert.equal(res.bandOf.MRNA, "HIGH_VOLUME_MOMENTUM");
  // Earning a slot must not evict the standing coverage.
  assert.equal(res.guaranteedCoverageBroken, false);
  for (const s of SECTOR_ETF_SYMBOLS) assert.ok(res.symbols.includes(s));
});

test("a mover earns its slot by displacing a lower band, never by widening the bound", () => {
  const withoutMover = allocateAdmissionSlots(baseInput({ config: { maxSymbols: 60 } }));
  const withMover = allocateAdmissionSlots(baseInput({
    momentum: [{ symbol: "MRNA", absMovePct: 133.2, dollarVolume: 2_300_000_000 }],
    config: { maxSymbols: 60 },
  }));
  assert.ok(withMover.symbols.includes("MRNA"));
  assert.equal(withMover.symbols.length, withoutMover.symbols.length,
    "admitting a mover changed the number of symbols quoted — that is a provider-cost change");
  assert.ok(withMover.symbols.length <= 60);
});

test("movers cannot take every slot", () => {
  const flood = Array.from({ length: 300 }, (_, i) => ({
    symbol: `M${String(i).padStart(3, "0")}`,
    absMovePct: 500 - i,
    dollarVolume: 1e9,
  }));
  const res = allocateAdmissionSlots(baseInput({ momentum: flood }));
  assert.equal(res.byBand.HIGH_VOLUME_MOMENTUM.length, DEFAULT_ADMISSION_PRIORITY.maxMomentumSlots);
  for (const s of SECTOR_ETF_SYMBOLS) assert.ok(res.symbols.includes(s), `${s} evicted by a mover flood`);
  for (const s of CORE_INDEX_SYMBOLS) assert.ok(res.symbols.includes(s));
});

test("momentum is ranked by |move| then dollar volume then symbol", () => {
  const ranked = rankMomentumForSlots([
    { symbol: "BBB", absMovePct: 10, dollarVolume: 100 },
    { symbol: "AAA", absMovePct: 10, dollarVolume: 100 },
    { symbol: "CCC", absMovePct: 10, dollarVolume: 900 },
    { symbol: "DDD", absMovePct: -99, dollarVolume: 1 },
  ]).map((m) => m.symbol);
  assert.deepEqual(ranked, ["DDD", "CCC", "AAA", "BBB"]);
});

test("output stays bounded at every cap", () => {
  for (const maxSymbols of [0, 1, 5, 28, 60, 94, 200]) {
    const res = allocateAdmissionSlots(baseInput({
      momentum: [{ symbol: "MRNA", absMovePct: 133, dollarVolume: 2.3e9 }],
      catalysts: ["ZZZZ"],
      config: { maxSymbols },
    }));
    assert.ok(res.symbols.length <= maxSymbols, `cap ${maxSymbols} exceeded`);
    assert.equal(new Set(res.symbols).size, res.symbols.length, "duplicate admitted");
  }
});

test("overflow rotates instead of truncating, so nothing is starved forever", () => {
  // Force overflow by capping below the curated universe.
  const cap = 40;
  const seen = new Set();
  let cursor = 0;
  for (let run = 0; run < 12; run++) {
    const res = allocateAdmissionSlots(baseInput({ config: { maxSymbols: cap, rotationCursor: cursor } }));
    for (const s of res.symbols) seen.add(s);
    assert.equal(res.nextRotationCursor === cursor && res.deferred.length > 0, false,
      "cursor did not advance while work was deferred — that is a fixed cutoff");
    cursor = res.nextRotationCursor;
  }
  for (const s of LARGE_CAP_LIQUID_SYMBOLS) {
    assert.ok(seen.has(s), `${s} was never admitted across 12 rotations — permanent starvation`);
  }
});

test("guaranteed bands are the ones the old slice was cutting", () => {
  assert.deepEqual([...GUARANTEED_BANDS], ["CORE_INDEX", "SECTOR_ETF"]);
  assert.equal(ADMISSION_BAND_ORDER[0], "CORE_INDEX");
  assert.equal(ADMISSION_BAND_ORDER.at(-1), "LARGE_CAP_LIQUID");
});

test("breaking guaranteed coverage is reported, never silent", () => {
  const res = allocateAdmissionSlots(baseInput({ config: { maxSymbols: 5 } }));
  assert.equal(res.guaranteedCoverageBroken, true);
  assert.ok(res.starvedBands.includes("SECTOR_ETF"));
  assert.ok(res.deferred.length > 0);
});

test("the shipped cap covers the universe, and the call budget covers the cap", () => {
  const required = slotsRequiredForFullCoverage({
    core: CORE_INDEX_SYMBOLS,
    sectorEtf: SECTOR_ETF_SYMBOLS,
    largeCap: LARGE_CAP_LIQUID_SYMBOLS,
  });
  assert.equal(required, staticUniverseSymbols().length
    + DEFAULT_ADMISSION_PRIORITY.maxCatalystSlots
    + DEFAULT_ADMISSION_PRIORITY.maxMomentumSlots);
  // The runner's default cap must not sit below what full coverage needs — that
  // is the exact arithmetic that failed before (78 curated against a cap of 60).
  const src = new URL("../lib/research/watchlist/professional-runner.ts", import.meta.url);
  const text = readFileSync(src, "utf8");
  const cap = Number(/const DEFAULT_MAX_SYMBOLS = (\d+)/.exec(text)?.[1]);
  assert.ok(Number.isFinite(cap), "DEFAULT_MAX_SYMBOLS not found");
  assert.ok(cap >= required, `default cap ${cap} is below full coverage ${required}`);
  // And a cap it cannot fund is a cap that starves symbols it admitted.
  const budget = Number(/const DEFAULT_CALL_BUDGET = (\d+)/.exec(text)?.[1]);
  assert.ok(budget >= providerCallsRequiredFor(cap) - 0,
    `budget ${budget} cannot fund cap ${cap} (needs ${providerCallsRequiredFor(cap)})`);
});

test("provider cost per run is bounded by the cap, not by the universe", () => {
  assert.equal(providerCallsRequiredFor(0), 3);
  assert.equal(providerCallsRequiredFor(60), 123);
  assert.equal(providerCallsRequiredFor(94), 191);
});

// ---------------------------------------------------------------------------
// The momentum feed: real rows, zero provider cost.
// ---------------------------------------------------------------------------

function moverDb(rows, latest) {
  return {
    prepare(sql) {
      if (/sqlite_master/.test(sql)) return { get: () => ({ name: "market_mover_observations" }), all: () => [] };
      if (/MAX\(session_date\)/.test(sql)) return { get: () => ({ d: latest }), all: () => [] };
      return { get: () => null, all: () => rows };
    },
  };
}

test("momentum candidates come from observed movers and never from the future", () => {
  const nowMs = 1_787_000_000_000;
  const db = moverDb([
    { symbol: "mrna", peak_abs_move_pct: 133.2, dollar_volume: 2.3e9, last_observed_at_ms: nowMs - 60_000,
      first_observed_at_ms: nowMs - 600_000, session_date: "2026-08-19", observation_version: 1, observations: 4 },
    { symbol: "FUTURE", peak_abs_move_pct: 90, dollar_volume: 1e9, last_observed_at_ms: nowMs + 60_000,
      first_observed_at_ms: nowMs + 60_000, session_date: "2026-08-19", observation_version: 1, observations: 1 },
  ], "2026-08-19");
  const { candidates, sessionUsed } = momentumCandidatesFromMoversOnDb(db, {
    sessionDate: "2026-08-19", nowMs,
  });
  assert.equal(sessionUsed, "2026-08-19");
  assert.deepEqual(candidates.map((c) => c.symbol), ["MRNA"]);
  assert.equal(candidates[0].absMovePct, 133.2);
  assert.ok(candidates[0].observedAtMs <= nowMs);
});

test("an empty observation table yields no candidates and no invented session", () => {
  const db = { prepare: () => ({ get: () => null, all: () => [] }) };
  const res = momentumCandidatesFromMoversOnDb(db, { sessionDate: "2026-08-19", nowMs: Date.now() });
  assert.deepEqual(res.candidates, []);
  assert.equal(res.sessionUsed, null);
});
