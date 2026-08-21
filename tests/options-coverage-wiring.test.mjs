/**
 * options-coverage-wiring.test.mjs — the step that actually retired the cap.
 *
 * The pure modules are tested elsewhere. What is tested HERE is the monitor
 * wiring: that a full eligible universe arriving from the snapshot really does
 * produce whole-universe cheap coverage and a bounded handful of expensive
 * promotions, and that the three selection paths degrade in the right order.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  __selectTier2SymbolsForTest, __resetOptionsMonitorForTest,
  optionsCoverageMetrics, optionsMonitorMetrics, defaultMonitorConfig,
} from "../lib/research/options/monitor.ts";

const UNIVERSE = 1606;
const NOW = 7_000_000;

/** A full eligible universe as the whole-market snapshot delivers it. */
const quotes = (n = UNIVERSE) => Array.from({ length: n }, (_, i) => ({
  symbol: `SYM${i}`,
  price: 100,
  changePercent: (i % 37) * 0.35,
  volume: 2_000_000,
  dayHigh: 103, dayLow: 98, dayOpen: 100, prevClose: 99, bid: null, ask: null,
}));

const deps = (over = {}) => ({
  now: () => NOW,
  session: () => "regular",
  tier2AwarenessQuotes: () => quotes(),
  ...over,
});

test("a 1,606-symbol universe is cheaply observed in FULL and expensively analysed in PART", async () => {
  __resetOptionsMonitorForTest();
  const selected = await __selectTier2SymbolsForTest(deps(), [], {});

  const cov = optionsCoverageMetrics(NOW);
  assert.equal(cov.eligibleOptionsUniverse, UNIVERSE, "the whole universe was scored");
  assert.equal(cov.cheapObservedThisCycle, UNIVERSE);
  assert.equal(cov.cheapObservationCoveragePct, 100, "cheap coverage is complete every cycle");

  // Expensive work is a small bounded fraction of it.
  assert.equal(selected.length, cov.deepAnalysisPromoted);
  assert.equal(selected.length > 0, true, "something is promoted");
  assert.equal(selected.length < 200, true, `promoted ${selected.length} — bounded, not 1,606`);
  assert.equal(cov.deepAnalysisDeferred, UNIVERSE - selected.length);
  assert.equal(new Set(selected).size, selected.length, "no duplicate expensive work");
});

test("the promotion count is DERIVED and says which constraint bound it", async () => {
  __resetOptionsMonitorForTest();
  await __selectTier2SymbolsForTest(deps(), [], {});
  const cov = optionsCoverageMetrics(NOW);

  assert.equal(typeof cov.capacityExplain, "string");
  assert.match(cov.capacityExplain, /bound by (provider_budget|latency_slo|hard_ceiling|no_headroom)/);
  assert.equal(["provider_budget", "latency_slo", "hard_ceiling", "no_headroom"].includes(cov.capacityBoundBy), true);
  assert.equal(cov.promotionCapacity >= 0, true);
  assert.equal(cov.providerHeadroom >= 0 && cov.providerHeadroom <= 1, true);
});

test("cheap coverage and deep analysis are reported as SEPARATE recency metrics", async () => {
  __resetOptionsMonitorForTest();
  await __selectTier2SymbolsForTest(deps(), [], {});
  const cov = optionsCoverageMetrics(NOW);

  // Everything was cheaply observed just now.
  assert.equal(cov.medianTimeSinceCheapObservationMs, 0);
  assert.equal(cov.p95TimeSinceCheapObservationMs, 0);
  // Deep-analysis recency covers only what was actually promoted — a symbol
  // never deeply analysed is ABSENT, not recorded as age zero.
  assert.equal(cov.medianTimeSinceDeepAnalysisMs, 0);
  assert.notEqual(cov.eligibleOptionsUniverse, cov.deepAnalysisPromoted,
    "the two populations are genuinely different sizes");
});

test("Tier-0 symbols are excluded from the broad cycle, as before", async () => {
  __resetOptionsMonitorForTest();
  const withSpy = () => [
    ...quotes(50),
    { symbol: "SPY", price: 600, changePercent: 9, volume: 90_000_000, dayHigh: 605, dayLow: 590, dayOpen: 595, prevClose: 550, bid: null, ask: null },
  ];
  const selected = await __selectTier2SymbolsForTest(
    deps({ tier2AwarenessQuotes: withSpy }), ["SPY"], {});
  assert.equal(selected.includes("SPY"), false, "Tier 0 owns SPY on its own faster timer");
});

test("an accelerating name is promoted the very next cycle, not after ~160 of them", async () => {
  __resetOptionsMonitorForTest();
  const quiet = [...quotes(1605),
    { symbol: "COIN", price: 300, changePercent: 0.4, volume: 300_000, dayHigh: 301, dayLow: 299, dayOpen: 300, prevClose: 299, bid: null, ask: null }];
  const moving = [...quotes(1605),
    { symbol: "COIN", price: 305.4, changePercent: 2.2, volume: 2_400_000, dayHigh: 305.5, dayLow: 299, dayOpen: 300, prevClose: 299, bid: null, ask: null }];

  // Cycle 1 establishes the prior observation.
  let feed = quiet;
  const d = deps({ tier2AwarenessQuotes: () => feed, now: () => NOW });
  await __selectTier2SymbolsForTest(d, [], {});

  // Cycle 2, 60s later: COIN is accelerating.
  feed = moving;
  const d2 = deps({ tier2AwarenessQuotes: () => feed, now: () => NOW + 60_000 });
  const selected = await __selectTier2SymbolsForTest(d2, [], {});
  assert.equal(selected.includes("COIN"), true, "promoted on merit on the next cycle");
});

/* ── capacity must respect the REAL provider meter ─────────────────────────*/

test("capacity is bounded by the GLOBAL provider meter, not just the lane's local bucket", async () => {
  // The lane bucket is process-local and knows nothing about the shared 280/min
  // cap. Planning a large cycle into a saturated provider does not get more
  // data — it converts headroom into refusals, and a refusal still costs a
  // request while returning nothing. That is the 11,449-quota-block state.
  __resetOptionsMonitorForTest();
  await __selectTier2SymbolsForTest(
    deps({ providerStats: () => ({ minuteCap: 280, callsThisMinute: 0 }) }), [], {});
  const idle = optionsCoverageMetrics(NOW).promotionCapacity;
  assert.equal(idle > 0, true, "an idle provider allows real depth");

  // Now the shared meter is nearly exhausted by OTHER lanes.
  __resetOptionsMonitorForTest();
  await __selectTier2SymbolsForTest(
    deps({ providerStats: () => ({ minuteCap: 280, callsThisMinute: 275 }) }), [], {});
  const saturated = optionsCoverageMetrics(NOW);

  assert.equal(saturated.promotionCapacity < idle, true,
    `saturated capacity ${saturated.promotionCapacity} must be below idle ${idle}`);
  assert.equal(saturated.promotionCapacity, 0,
    "5 requests left against a 20-request critical reserve — nothing may be promoted");
  assert.equal(saturated.capacityBoundBy, "no_headroom");
  // And cheap awareness is COMPLETELY UNAFFECTED: seeing everything costs nothing,
  // so a saturated provider blinds the deep stage without blinding the system.
  assert.equal(saturated.cheapObservationCoveragePct, 100);
  assert.equal(saturated.eligibleOptionsUniverse, UNIVERSE);
});

test("capacity scales smoothly with real global headroom", async () => {
  const capacityAt = async (callsThisMinute) => {
    __resetOptionsMonitorForTest();
    await __selectTier2SymbolsForTest(
      deps({ providerStats: () => ({ minuteCap: 280, callsThisMinute }) }), [], {});
    return optionsCoverageMetrics(NOW).promotionCapacity;
  };
  const roomy = await capacityAt(0);
  const mid = await capacityAt(150);
  const tight = await capacityAt(250);
  assert.equal(roomy > mid, true, `${roomy} > ${mid}`);
  assert.equal(mid > tight, true, `${mid} > ${tight}`);
  assert.equal(tight >= 0, true);
});

test("an unreadable provider meter falls back to the lane bucket rather than to zero", async () => {
  __resetOptionsMonitorForTest();
  await __selectTier2SymbolsForTest(
    deps({ providerStats: () => { throw new Error("meter unavailable"); } }), [], {});
  const cov = optionsCoverageMetrics(NOW);
  assert.equal(cov.promotionCapacity > 0, true,
    "a broken meter must not silently stop all deep analysis");
});

/* ── graceful degradation ──────────────────────────────────────────────────*/

test("without the snapshot source it falls back to the previous ranked behaviour", async () => {
  __resetOptionsMonitorForTest();
  const selected = await __selectTier2SymbolsForTest({
    now: () => NOW, session: () => "regular",
    tier2Candidates: () => Array.from({ length: 100 }, (_, i) => ({
      symbol: `OLD${i}`, changePercent: i, dayDollarVolume: 5e7,
    })),
  }, [], {});
  // The old path: a hard 25-symbol horizon.
  assert.equal(selected.length, defaultMonitorConfig({}).maxSymbolsPerTier2Cycle);
  assert.equal(selected.length, 25);
});

test("with neither source it falls back to provider order, exactly as before", async () => {
  __resetOptionsMonitorForTest();
  const selected = await __selectTier2SymbolsForTest({
    now: () => NOW, session: () => "regular",
    tier2Universe: () => Array.from({ length: 100 }, (_, i) => `RAW${i}`),
  }, [], {});
  assert.equal(selected.length, 25);
  assert.equal(selected[0], "RAW0", "unranked provider order — the original behaviour");
});

test("OPTIONS_AWARENESS=0 disables the new path without disabling coverage entirely", async () => {
  __resetOptionsMonitorForTest();
  const selected = await __selectTier2SymbolsForTest(
    deps({ tier2Candidates: () => [{ symbol: "FALLBACK", changePercent: 5, dayDollarVolume: 5e7 }] }),
    [], { OPTIONS_AWARENESS: "0" });
  assert.deepEqual(selected, ["FALLBACK"], "falls through to the ranked path, not to nothing");
});

/* ── observability ─────────────────────────────────────────────────────────*/

test("coverage is published on the monitor metrics surface", async () => {
  __resetOptionsMonitorForTest();
  await __selectTier2SymbolsForTest(deps(), [], {});
  const m = optionsMonitorMetrics();
  assert.equal(typeof m.coverage, "object");
  assert.equal(m.coverage.eligibleOptionsUniverse, UNIVERSE);
  assert.equal(m.coverage.cheapObservationCoveragePct, 100);
  // The legacy surface keeps reporting, with its new meaning.
  assert.equal(m.tier2Selection.universeSize, UNIVERSE);
  assert.equal(m.tier2Selection.cyclesForFullCoverage, 1, "cheap coverage completes every cycle now");
});

test("the observation cache does not grow across cycles", async () => {
  __resetOptionsMonitorForTest();
  const d = deps();
  for (let i = 0; i < 5; i++) await __selectTier2SymbolsForTest(d, [], {});
  const cov = optionsCoverageMetrics(NOW);
  assert.equal(cov.eligibleOptionsUniverse, UNIVERSE, "still exactly the universe after 5 cycles");
  assert.equal(cov.cheapObservedThisCycle, UNIVERSE);
});

test("an empty universe degrades to zero rather than throwing", async () => {
  __resetOptionsMonitorForTest();
  const selected = await __selectTier2SymbolsForTest(deps({ tier2AwarenessQuotes: () => [] }), [], {});
  assert.deepEqual(selected, []);
  const cov = optionsCoverageMetrics(NOW);
  assert.equal(cov.eligibleOptionsUniverse, 0);
  assert.equal(cov.cheapObservationCoveragePct, 0);
  assert.equal(cov.medianTimeSinceCheapObservationMs, null, "no sample means null, not a fabricated 0");
});
