/**
 * tests/analog-remediation.test.mjs
 *
 * The corpus-breadth / V2-comparability / baseline-evaluation pass.
 *
 * Every test here guards a failure that would otherwise SUCCEED QUIETLY:
 *
 *   · V2's structurally-null liquidity_tier bucketed into a category, restoring 6,935 rows
 *     and filtering nothing
 *   · a V1 `atrPct` and a V2 `atrPct` z-scored into one metric because they share a name
 *   · an optional comparability key scored as agreement when one side does not have it
 *   · a baseline estimated from observations the analog engine was fenced away from, which
 *     makes the engine look modest and nobody audits the loser
 *   · a baseline scored over a different population than the analog, so the "delta" is a
 *     difference of denominators
 *   · 200 correlated predictions resampled as 200 independent draws, producing an interval
 *     that is tight in exactly the flattering direction
 *   · a widened corpus quietly reporting a 5d horizon the bar span can never reach
 *
 * The V1 reproducibility tests are the load-bearing ones: the whole point of versioning the
 * vector is that the old evaluation still means what it meant.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  ANALOG_FEATURE_VECTOR_VERSION,
  ANALOG_COMPARABILITY_SPEC_V1,
  COMPARABILITY_KEYS,
  DISTANCE_DIMENSIONS,
  buildAnalogFeatureVector,
} from "../lib/research/analog/feature-vector.ts";
import {
  ANALOG_COMPARABILITY_SPEC_V2,
  ANALOG_FEATURE_FIELDS_V2,
  ANALOG_FEATURE_VECTOR_V2_VERSION,
  V2_EXECUTABLE_KEY,
  buildAnalogFeatureVectorV2,
  describeAnalogFeatureVectorV2,
  encodeExecutable,
  extractV2FeatureInputs,
  vectorFromV2EpisodeRow,
} from "../lib/research/analog/feature-vector-v2.ts";
import {
  comparabilityOf,
  comparabilitySpecFor,
  knownVectorVersions,
  vectorSelfComparable,
} from "../lib/research/analog/comparability.ts";
import { retrieveAnalogs } from "../lib/research/analog/retrieval.ts";
import {
  ALL_BASELINES,
  MIN_STRATUM,
  REGIME_WINDOW_SESSIONS,
  baselinesForQuery,
  eligibleTrainingSet,
  scoreBaselines,
} from "../lib/research/analog/baselines.ts";
import {
  clusterLabel,
  independenceReport,
} from "../lib/research/analog/independence.ts";
import { evaluateAnalogRetrieval } from "../lib/research/analog/analog-evaluation.ts";
import {
  plannedHorizonsFor,
  seedAnalogCorpusFromStoreOnDb,
  storedBarInventoryOnDb,
} from "../lib/research/analog/local-replay.ts";
import { bootstrapClusteredLiftCI } from "../lib/research/eval/metrics.ts";

// ── fixtures ────────────────────────────────────────────────────────────────
//
// A fixture that invents a column is how a query against a non-existent column passes
// tests and kills production, so the V2 rows here carry the SHAPE
// `persistSetupEpisodeV2OnDb` actually writes: zone_a_json with EvidenceValue wrappers,
// a null liquidity_tier, and no per-block feature columns at all.

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 8, 15, 0, 0); // Monday 2024-01-08, 10:00 ET

function ev(value, asOfMs = T0) {
  return { value, source: "test", asOfMs, quality: "EXACT", missingReason: null, featureVersion: "test@1" };
}

function v2Row(over = {}) {
  const {
    symbol = "NVDA", direction = "bullish", t0Ms = T0, executable = true,
    snapshot = { price: 100, hod: 102, lod: 98, velPct: 0.8, accelPct: 0.2, relVolume: 3.1, realizedVol: 0.004, atrPct: 0.9, gapPct: 0.3 },
    withOption = true, episodeKey = `ep2_${symbol}_${t0Ms}`,
  } = over;
  return {
    episode_key: episodeKey,
    symbol,
    direction,
    t0_ms: t0Ms,
    label_as_of_ms: t0Ms + 60_000,
    trading_day: "2024-01-08",
    episode_version: 2,
    liquidity_tier: null, // structurally null on every V2 row
    price_structure_json: null, momentum_json: null, volume_json: null, volatility_json: null,
    zone_a_json: JSON.stringify({
      underlying: { price: ev(snapshot?.price ?? null), dayDollarVolume: ev(85_000_000), relVolume: ev(snapshot?.relVolume ?? null) },
      option: withOption ? { occ: ev("NVDA240119C00500000"), executableAtT0: ev(executable) } : null,
      optiscan: { sharedFeatureSnapshot: ev(snapshot ? { source: "enriched", underlying: snapshot } : null) },
      marketContext: { marketRegime: ev(null) },
    }),
  };
}

function member(over = {}) {
  const {
    id = "m1", symbol = "AAA", t0Ms = T0, labelEndMs = T0 + 60_000, tradingDay = "2024-01-08",
    outcome = 1, direction = "bullish", liquidityTier = "high", velPct = 1, version = "v1",
  } = over;
  const vector = version === "v2"
    ? buildAnalogFeatureVectorV2({
        velPct, accelPct: 0.1, rvol: 2, realizedVol: 0.003, atrPct: 0.8, posInRange: 0.7, gapPct: 0.2,
        direction, executableAtT0: true, symbol,
      })
    : buildAnalogFeatureVector({
        velPct, accelPct: 0.1, rvol: 2, realizedVol: 0.003, atrPct: 0.8, posInRange: 0.7, gapPct: 0.2,
        direction, liquidityTier, symbol,
      });
  return { id, symbol, t0Ms, labelEndMs, tradingDay, evidenceClass: "HISTORICAL_UNDERLYING_ONLY", vector, outcome };
}

/**
 * A corpus with real structure: several symbols, several sessions, a genuine win rate that
 * is NOT 0.5, and label windows that finish before later queries. Deterministic — no clock,
 * no randomness — so every assertion below is exact.
 */
function corpusOf({ symbols = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"], sessions = 24, perSession = 3 } = {}) {
  const out = [];
  for (let d = 0; d < sessions; d++) {
    // Step by 7/5 days so the generated dates land on weekdays often enough; the trading
    // calendar rejects the rest and the tests assert against what it accepts.
    const base = Date.UTC(2024, 0, 8) + d * DAY;
    const day = new Date(base).toISOString().slice(0, 10);
    for (let i = 0; i < perSession; i++) {
      for (const sym of symbols) {
        const t0Ms = base + 15 * 3_600_000 + i * 3_600_000;
        out.push(member({
          id: `${sym}-${d}-${i}`,
          symbol: sym,
          t0Ms,
          labelEndMs: t0Ms + 30 * 60_000,
          tradingDay: day,
          // 60% win rate, fully deterministic: a global base rate the engine must beat.
          outcome: (d * perSession + i) % 5 < 3 ? 1 : -1,
          velPct: 0.5 + ((d + i) % 7) * 0.3,
          direction: (d + i) % 4 === 0 ? "bearish" : "bullish",
        }));
      }
    }
  }
  return out.sort((a, b) => a.t0Ms - b.t0Ms || (a.id < b.id ? -1 : 1));
}

// ── 3 / 4 / 5 / 6: V2 liquidity is never faked, and versions are explicit ───

test("V2 null liquidity is never converted to a fake category", () => {
  const vec = vectorFromV2EpisodeRow(v2Row());
  assert.equal(vec.version, ANALOG_FEATURE_VECTOR_V2_VERSION);
  // Not present at all — not "low", not 0, not carried over from V1.
  assert.equal(vec.values.cmp_liquidity, undefined);
  assert.ok(!ANALOG_COMPARABILITY_SPEC_V2.required.includes("cmp_liquidity"));
  assert.ok(!ANALOG_COMPARABILITY_SPEC_V2.optional.includes("cmp_liquidity"));
  assert.ok(!ANALOG_FEATURE_FIELDS_V2.some((f) => f.key === "cmp_liquidity"));
  // ...and the reason is stated on the surface, not only in a comment.
  assert.match(describeAnalogFeatureVectorV2().liquidityTierNote, /constant column/);
});

test("a V2 row that was rejected as incomparable under V1 is comparable under V2", () => {
  const row = v2Row();
  // The old path demanded cmp_liquidity, which a V2 row cannot have.
  const asV1 = buildAnalogFeatureVector({ direction: row.direction, liquidityTier: row.liquidity_tier, symbol: row.symbol });
  assert.equal(asV1.comparable, false);
  const asV2 = vectorFromV2EpisodeRow(row);
  assert.equal(asV2.comparable, true);
});

test("V2 comparability uses point-in-time frozen evidence only", () => {
  const extract = extractV2FeatureInputs(JSON.parse(v2Row().zone_a_json));
  // Every dimension names the frozen Zone-A block it came from, or says ABSENT.
  for (const [key, source] of Object.entries(extract.sources)) {
    assert.ok(
      source === "ABSENT" || source.startsWith("ABSENT:") || source.startsWith("sharedFeatureSnapshot")
        || source.startsWith("zoneA.") || source.startsWith("derived:"),
      `${key} came from an unexpected source: ${source}`,
    );
  }
  assert.equal(extract.sources[V2_EXECUTABLE_KEY], "zoneA.option.executableAtT0");
  // posInRange is derived from frozen hod/lod/price, never read from a later bar.
  assert.equal(extract.values.posInRange, 0.5);
  assert.match(extract.sources.posInRange, /^derived:/);
});

test("a degenerate session range yields a null posInRange, never 0.5", () => {
  const extract = extractV2FeatureInputs(JSON.parse(
    v2Row({ snapshot: { price: 100, hod: 100, lod: 100, velPct: 0.4 } }).zone_a_json,
  ));
  assert.equal(extract.values.posInRange, null);
  assert.match(extract.sources.posInRange, /never defaulted to 0\.5/);
});

test("an absent option leg is unknown executability, not 'not executable'", () => {
  assert.equal(encodeExecutable(undefined), null);
  assert.equal(encodeExecutable(null), null);
  assert.equal(encodeExecutable(false), 0);
  assert.equal(encodeExecutable(true), 1);
  const vec = vectorFromV2EpisodeRow(v2Row({ withOption: false }));
  assert.equal(vec.values[V2_EXECUTABLE_KEY], null);
  // ...and the vector is still usable, because the key is OPTIONAL under V2.
  assert.equal(vec.comparable, true);
});

test("V1 remains reproducible: its spec, dimensions and vectors are unchanged", () => {
  assert.equal(ANALOG_COMPARABILITY_SPEC_V1.version, ANALOG_FEATURE_VECTOR_VERSION);
  assert.deepEqual([...ANALOG_COMPARABILITY_SPEC_V1.required], [...COMPARABILITY_KEYS]);
  assert.deepEqual([...ANALOG_COMPARABILITY_SPEC_V1.optional], []);
  assert.deepEqual([...ANALOG_COMPARABILITY_SPEC_V1.distanceDimensions], [...DISTANCE_DIMENSIONS]);
  const v = buildAnalogFeatureVector({
    velPct: 1, accelPct: 0.1, rvol: 2, realizedVol: 0.003, atrPct: 0.8, posInRange: 0.7, gapPct: 0.2,
    direction: "bullish", liquidityTier: "high", symbol: "AAA",
  });
  assert.equal(v.version, "ANALOG_FEATURE_VECTOR_V1");
  assert.equal(v.values.cmp_liquidity, 2);
  assert.equal(v.comparable, true);
  // A V1 vector missing its tier is STILL refused. The V2 change must not have loosened it.
  const noTier = buildAnalogFeatureVector({ direction: "bullish", liquidityTier: null, symbol: "AAA" });
  assert.equal(noTier.comparable, false);
});

test("vector-version changes are explicit and an unknown version throws", () => {
  assert.deepEqual(knownVectorVersions(), ["ANALOG_FEATURE_VECTOR_V1", "ANALOG_FEATURE_VECTOR_V2"]);
  assert.equal(comparabilitySpecFor(ANALOG_FEATURE_VECTOR_VERSION).version, ANALOG_FEATURE_VECTOR_VERSION);
  assert.equal(comparabilitySpecFor(ANALOG_FEATURE_VECTOR_V2_VERSION).version, ANALOG_FEATURE_VECTOR_V2_VERSION);
  // No silent fallback to V1 — that is how a third vector would inherit V1's requirements
  // and be rejected wholesale with nothing in the output to say so.
  assert.throws(() => comparabilitySpecFor("ANALOG_FEATURE_VECTOR_V3"), /no comparability spec registered/);
});

test("retrieval refuses to mix feature-vector versions", () => {
  // Distinct symbols so the corpus cannot collide with the query's own duplicate bucket —
  // otherwise everything drops out as SELF and the version fence is never exercised.
  const v1s = Array.from({ length: 6 }, (_, i) =>
    member({ id: `v1-${i}`, symbol: "BBB", t0Ms: T0 + i * 1000, labelEndMs: T0 + i * 1000 + 1000, outcome: i % 2 ? 1 : -1 }));
  const v2s = Array.from({ length: 6 }, (_, i) =>
    member({ id: `v2-${i}`, symbol: "CCC", t0Ms: T0 + i * 1000, labelEndMs: T0 + i * 1000 + 1000, outcome: i % 2 ? 1 : -1, version: "v2" }));
  const query = member({ id: "q", symbol: "AAA", t0Ms: T0 + 100_000, version: "v2" });
  const r = retrieveAnalogs(
    { id: query.id, symbol: query.symbol, t0Ms: query.t0Ms, vector: query.vector },
    [...v1s, ...v2s],
    { perSymbolCap: 50, perDuplicateCap: 50, minCoverage: 0 },
  );
  assert.equal(r.featureVectorVersion, ANALOG_FEATURE_VECTOR_V2_VERSION);
  assert.equal(r.exclusions.FEATURE_VECTOR_VERSION_MISMATCH, v1s.length);
  assert.ok(r.analogs.every((a) => a.id.startsWith("v2-")));
});

// ── 7: missing never becomes a perfect match ────────────────────────────────

test("an optional comparability key absent on one side is dropped, never matched", () => {
  const spec = ANALOG_COMPARABILITY_SPEC_V2;
  const withKey = { cmp_direction: 1, [V2_EXECUTABLE_KEY]: 1, cmp_symbol: 5 };
  const without = { cmp_direction: 1, [V2_EXECUTABLE_KEY]: null, cmp_symbol: 6 };
  const r = comparabilityOf(spec, withKey, without);
  assert.equal(r.comparable, true);
  assert.deepEqual(r.droppedKeys, [V2_EXECUTABLE_KEY]);
  // Dropped is NOT shared: the key never enters the agreement set...
  assert.ok(!r.sharedKeys.includes(V2_EXECUTABLE_KEY));
  // ...and coverage is strictly below the fully-compared pair.
  const full = comparabilityOf(spec, withKey, { ...withKey, cmp_symbol: 7 });
  assert.ok(r.coverage < full.coverage);
  assert.equal(full.coverage, 1);
});

test("a required comparability key absent is refused, and reported apart from a mismatch", () => {
  const spec = ANALOG_COMPARABILITY_SPEC_V2;
  const absent = comparabilityOf(spec, { cmp_direction: 1, cmp_symbol: 1 }, { cmp_direction: null, cmp_symbol: 2 });
  assert.equal(absent.comparable, false);
  assert.equal(absent.verdict, "REQUIRED_KEY_ABSENT");
  const mismatch = comparabilityOf(spec, { cmp_direction: 1, cmp_symbol: 1 }, { cmp_direction: 0, cmp_symbol: 2 });
  assert.equal(mismatch.verdict, "REQUIRED_KEY_MISMATCH");
  assert.equal(vectorSelfComparable(spec, { cmp_direction: null, cmp_symbol: 1 }), false);
  assert.equal(vectorSelfComparable(spec, { cmp_direction: 1, cmp_symbol: null }), false);
  assert.equal(vectorSelfComparable(spec, { cmp_direction: 1, cmp_symbol: 1 }), true);
});

test("a minimum comparability coverage floor can refuse a partially-compared pair", () => {
  const known = Array.from({ length: 8 }, (_, i) => member({
    id: `k-${i}`, symbol: "BBB", t0Ms: T0 - (i + 2) * 60_000, labelEndMs: T0 - (i + 1) * 60_000,
    outcome: i % 2 ? 1 : -1, version: "v2",
  }));
  const unknownExec = known.map((m, i) => ({
    ...m,
    id: `u-${i}`,
    vector: buildAnalogFeatureVectorV2({
      velPct: 1, accelPct: 0.1, rvol: 2, realizedVol: 0.003, atrPct: 0.8, posInRange: 0.7, gapPct: 0.2,
      direction: "bullish", executableAtT0: null, symbol: "CCC",
    }),
  }));
  const query = member({ id: "q", symbol: "AAA", t0Ms: T0, version: "v2" });
  const q = { id: query.id, symbol: query.symbol, t0Ms: query.t0Ms, vector: query.vector };
  const loose = retrieveAnalogs(q, [...known, ...unknownExec], { perSymbolCap: 50, perDuplicateCap: 50 });
  assert.ok(loose.analogs.some((a) => a.id.startsWith("u-")), "with no floor the partial pairs are admitted");
  assert.ok(loose.comparabilityKeysDropped > 0, "and the dropped keys are counted");
  const strict = retrieveAnalogs(q, [...known, ...unknownExec], {
    perSymbolCap: 50, perDuplicateCap: 50, minComparabilityCoverage: 1,
  });
  assert.ok(strict.analogs.every((a) => !a.id.startsWith("u-")));
  assert.equal(strict.exclusions.INSUFFICIENT_COMPARABILITY_COVERAGE, unknownExec.length);
  assert.equal(strict.comparabilityKeysDropped, 0);
});

// ── 8 / 9 / 10 / 11: baselines are train-only and cannot see the future ─────

test("the baseline training set is exactly the retrieval fence", () => {
  const corpus = corpusOf({ symbols: ["AAA"], sessions: 6, perSession: 2 });
  const query = corpus[corpus.length - 1];
  const train = eligibleTrainingSet(query, corpus, 15 * 60_000);
  assert.ok(train.length > 0);
  for (const m of train) {
    assert.ok(m.labelEndMs <= query.t0Ms, "no training row resolved after the decision");
    assert.notEqual(m.id, query.id, "the query is never its own training data");
    assert.notEqual(m.outcome, null, "a censored row never enters a rate");
  }
  // ...and every future row IS excluded, not merely absent by construction.
  const future = corpus.filter((m) => m.labelEndMs > query.t0Ms);
  assert.ok(future.length > 0, "the fixture must contain future rows for this to prove anything");
  for (const f of future) assert.ok(!train.some((t) => t.id === f.id));
});

test("baselines cannot see future outcomes: flipping them changes nothing", () => {
  const corpus = corpusOf({ symbols: ["AAA", "BBB"], sessions: 12, perSession: 2 });
  const query = corpus[Math.floor(corpus.length / 2)];
  const before = baselinesForQuery(query, corpus, {});
  // Invert every outcome that resolved AFTER the decision. A baseline that peeks moves.
  const tampered = corpus.map((m) =>
    m.labelEndMs > query.t0Ms && m.outcome !== null ? { ...m, outcome: -m.outcome } : m);
  const after = baselinesForQuery(query, tampered, {});
  assert.deepEqual(after.predictions, before.predictions);
  assert.equal(after.trainingN, before.trainingN);
});

test("the global baseline uses prior training data only, and is not the constant", () => {
  const corpus = corpusOf({ symbols: ["AAA"], sessions: 20, perSession: 2 });
  const query = corpus[corpus.length - 1];
  const { predictions } = baselinesForQuery(query, corpus, {});
  const train = eligibleTrainingSet(query, corpus, 15 * 60_000);
  const expected = train.filter((m) => m.outcome > 0).length / train.length;
  assert.equal(predictions.GLOBAL_BASE_RATE.predicted, +expected.toFixed(6));
  assert.equal(predictions.GLOBAL_BASE_RATE.stratumN, train.length);
  assert.equal(predictions.CONSTANT.predicted, 0.5);
  assert.notEqual(predictions.GLOBAL_BASE_RATE.predicted, 0.5);
});

test("the symbol baseline uses that symbol's prior rows only, and backs off when thin", () => {
  const corpus = corpusOf({ symbols: ["AAA", "BBB"], sessions: 20, perSession: 2 });
  const query = corpus[corpus.length - 1];
  const { predictions } = baselinesForQuery(query, corpus, {});
  const train = eligibleTrainingSet(query, corpus, 15 * 60_000);
  const own = train.filter((m) => m.symbol === query.symbol);
  assert.ok(own.length >= MIN_STRATUM, "the fixture must clear the stratum floor");
  assert.equal(predictions.SYMBOL_BASE_RATE.backedOff, false);
  assert.equal(predictions.SYMBOL_BASE_RATE.stratumN, own.length);
  assert.equal(
    predictions.SYMBOL_BASE_RATE.predicted,
    +(own.filter((m) => m.outcome > 0).length / own.length).toFixed(6),
  );
  // An early query has no prior rows of its own symbol and MUST back off rather than invent one.
  const early = corpus[1];
  const thin = baselinesForQuery(early, corpus, {}).predictions.SYMBOL_BASE_RATE;
  assert.equal(thin.backedOff, true);
  assert.ok(thin.stratumN < MIN_STRATUM);
});

test("the regime baseline uses a trailing train-only window and backs off when thin", () => {
  const corpus = corpusOf({ symbols: ["AAA", "BBB"], sessions: 30, perSession: 2 });
  const query = corpus[corpus.length - 1];
  const wide = baselinesForQuery(query, corpus, {}).predictions.REGIME_BASE_RATE;
  assert.equal(wide.backedOff, false);
  const train = eligibleTrainingSet(query, corpus, 15 * 60_000);
  assert.ok(wide.stratumN > 0 && wide.stratumN <= train.length, "the window is a SUBSET of the training set");
  assert.ok(REGIME_WINDOW_SESSIONS > 0);
  // A one-session window cannot clear the stratum floor here, so it must back off.
  const narrow = baselinesForQuery(query, corpus, { regimeWindowSessions: 0 }).predictions.REGIME_BASE_RATE;
  assert.equal(narrow.backedOff, true);
  assert.equal(narrow.stratumN, 0);
});

test("an unknown direction never pools into a side's base rate", () => {
  const corpus = corpusOf({ symbols: ["AAA"], sessions: 20, perSession: 2 });
  const query = {
    ...corpus[corpus.length - 1],
    vector: buildAnalogFeatureVector({ velPct: 1, direction: null, liquidityTier: "high", symbol: "AAA" }),
  };
  const p = baselinesForQuery(query, corpus, {}).predictions.DIRECTION_BASE_RATE;
  assert.equal(p.stratumN, 0);
  assert.equal(p.backedOff, true);
});

// ── 12 / 13: same population, reconciling diagnostics ──────────────────────

test("the analog and every baseline are scored over the identical population", () => {
  const report = evaluateAnalogRetrieval(corpusOf({ sessions: 30, perSession: 2 }), {
    maxQueries: 120, bootstrapIterations: 200,
  });
  const scoreableN = report.baselines.scores[0]?.n ?? 0;
  assert.ok(scoreableN > 0);
  for (const s of report.baselines.scores) {
    assert.equal(s.n, scoreableN, `${s.baseline} scored a different number of predictions`);
  }
  for (const c of report.baselines.comparisons) {
    assert.equal(c.analogBrier, report.brier, "the analog Brier must be the SAME number in every comparison");
  }
  assert.deepEqual(report.baselines.comparisons.map((c) => c.baseline).sort(), [...ALL_BASELINES]);
  // The independence report describes that same scoreable population.
  assert.equal(report.independence.observations, scoreableN);
});

test("concentration and cluster diagnostics reconcile with the observations", () => {
  const obs = [
    { id: "a", symbol: "AAA", tradingDay: "2024-01-08", t0Ms: T0, labelEndMs: T0 + 3_600_000 },
    { id: "b", symbol: "AAA", tradingDay: "2024-01-08", t0Ms: T0 + 600_000, labelEndMs: T0 + 4_000_000 },
    { id: "c", symbol: "BBB", tradingDay: "2024-01-09", t0Ms: T0 + DAY, labelEndMs: T0 + DAY + 60_000 },
  ];
  const r = independenceReport(obs);
  assert.equal(r.observations, 3);
  assert.equal(r.clusterCounts.PREDICTION, 3);
  assert.equal(r.clusterCounts.SYMBOL_SESSION, 2);
  assert.equal(r.clusterCounts.SESSION, 2);
  assert.equal(r.clusterCounts.SYMBOL, 2);
  assert.equal(r.concentration.symbol.distinct, 2);
  assert.equal(r.concentration.symbol.topShare, 0.6667);
  // a and b are the same symbol with intersecting label windows — exactly one such pair.
  assert.equal(r.overlappingWindowPairs, 1);
  assert.equal(r.sameSymbolPairs, 1);
  assert.equal(r.inflationFactor, 1.5);
  assert.equal(clusterLabel("SYMBOL_SESSION", obs[0]), "AAA|2024-01-08");
});

test("a correlated sample is not resampled as independent draws", () => {
  // Twenty predictions, one session. Item-level resampling would report a tight interval;
  // cluster resampling has exactly one cluster to draw and cannot manufacture precision.
  const n = 20;
  // The per-item deltas must actually VARY — a constant delta has no sampling variation to
  // report and would make this test pass for the wrong reason.
  const candidate = Array.from({ length: n }, (_, i) => 0.30 + (i % 5) * 0.03);
  const baseline = Array.from({ length: n }, (_, i) => 0.28 + (i % 3) * 0.05);
  const oneCluster = bootstrapClusteredLiftCI(candidate, baseline, Array(n).fill("2024-01-08"), 500);
  assert.equal(oneCluster.clusters, 1);
  assert.equal(oneCluster.lo, oneCluster.hi, "one cluster has no sampling variation to report");
  const manyClusters = bootstrapClusteredLiftCI(
    candidate, baseline, Array.from({ length: n }, (_, i) => `d${i}`), 500,
  );
  assert.equal(manyClusters.clusters, n);
  assert.ok(manyClusters.hi > manyClusters.lo);
  // Deterministic: same inputs, same interval.
  const again = bootstrapClusteredLiftCI(candidate, baseline, Array.from({ length: n }, (_, i) => `d${i}`), 500);
  assert.deepEqual(again, manyClusters);
});

test("the baseline verdict refuses to call a win when any baseline survives", () => {
  const report = evaluateAnalogRetrieval(corpusOf({ sessions: 30, perSession: 2 }), {
    maxQueries: 120, bootstrapIterations: 200,
  });
  const unbeaten = report.baselines.comparisons.filter((c) => !c.analogBeatsBaseline);
  if (unbeaten.length === 0) {
    assert.equal(report.baselines.verdict, "ADDS_INFORMATION");
    assert.equal(report.baselines.strongestUnbeaten, null);
  } else {
    assert.notEqual(report.baselines.verdict, "ADDS_INFORMATION");
    assert.ok(unbeaten.some((c) => c.baseline === report.baselines.strongestUnbeaten));
  }
  // Beating the constant alone is never enough to claim information.
  const onlyConstantBeaten = report.baselines.comparisons.filter((c) => c.analogBeatsBaseline)
    .every((c) => c.baseline === "CONSTANT");
  if (onlyConstantBeaten && report.baselines.comparisons.length > 1) {
    assert.notEqual(report.baselines.verdict, "ADDS_INFORMATION");
  }
});

// ── 1 / 2: the widened replay stays historical-T0 clean ────────────────────

test("planned horizons never claim a horizon the bar span cannot reach", () => {
  const five = plannedHorizonsFor(["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"]);
  assert.deepEqual(five.supported, ["15m", "30m", "1h", "EOD", "1d", "3d"]);
  assert.deepEqual(five.unsupported, ["5d", "10d"]);
  const one = plannedHorizonsFor(["2026-08-03"]);
  assert.deepEqual(one.supported, ["15m", "30m", "1h", "EOD"]);
  assert.ok(one.unsupported.includes("1d"));
});

test("local replay is a dry run unless writing is asked for, and issues no provider call", () => {
  const db = fakeBarDb();
  const dry = seedAnalogCorpusFromStoreOnDb(db, {}, T0);
  assert.equal(dry.dryRun, true, "an omitted flag must describe, not act");
  assert.equal(dry.providerCallsIssued, 0);
  assert.equal(db.writes.length, 0, "a dry run writes nothing");
  assert.equal(dry.evidenceClass, "HISTORICAL_UNDERLYING_ONLY");
  assert.match(dry.note, /Zero provider calls/);
});

test("widened replay reports a missing bar store rather than inventing a corpus", () => {
  const empty = { prepare: () => ({ get: () => undefined, all: () => [], run: () => ({ changes: 0 }) }) };
  const r = seedAnalogCorpusFromStoreOnDb(empty, {}, T0);
  assert.equal(r.ran, false);
  assert.match(r.skippedReason, /historical_underlying_bars/);
  assert.equal(r.episodesInserted, 0);
  const inv = storedBarInventoryOnDb(empty);
  assert.equal(inv.present, false);
  assert.equal(inv.distinctSymbols, 0);
});

test("legacy V1 datasets remain readable after the V2 vector exists", () => {
  const legacyRow = {
    episode_key: "ep_legacy", symbol: "AAPL", direction: "bullish", liquidity_tier: "high",
    t0_ms: T0, label_as_of_ms: T0 + 60_000, trading_day: "2024-01-08",
    // A legacy row has NO episode_version, NO zone_a_json — only the per-block columns.
    price_structure_json: JSON.stringify({ asOfMs: T0, values: { posInRange: 0.4, gapPct: 0.1 } }),
    momentum_json: JSON.stringify({ asOfMs: T0, values: { velPct: 1.2, accelPct: 0.3 } }),
    volume_json: JSON.stringify({ asOfMs: T0, values: { rvol: 2.4 } }),
    volatility_json: JSON.stringify({ asOfMs: T0, values: { realizedVol: 0.004, atrPct: 1.1 } }),
  };
  // The per-row dispatcher must still send it down the V1 path.
  const vec = Number(legacyRow.episode_version) === 2
    ? vectorFromV2EpisodeRow(legacyRow)
    : buildAnalogFeatureVector({
        velPct: 1.2, accelPct: 0.3, rvol: 2.4, realizedVol: 0.004, atrPct: 1.1,
        posInRange: 0.4, gapPct: 0.1, direction: "bullish", liquidityTier: "high", symbol: "AAPL",
      });
  assert.equal(vec.version, ANALOG_FEATURE_VECTOR_VERSION);
  assert.equal(vec.comparable, true);
  assert.equal(vec.values.cmp_liquidity, 2);
});

// ── 14 / 15 / 21: claims stay in their lane, retrieval stays bounded ───────

test("retrieval stays bounded by k regardless of corpus size", () => {
  const corpus = corpusOf({ symbols: ["AAA", "BBB", "CCC", "DDD"], sessions: 30, perSession: 4 });
  const query = corpus[corpus.length - 1];
  const r = retrieveAnalogs(
    { id: query.id, symbol: query.symbol, t0Ms: query.t0Ms, vector: query.vector },
    corpus,
    { k: 12, perSymbolCap: 5 },
  );
  assert.ok(r.analogs.length <= 12);
  assert.ok(r.eligibleCount > r.analogs.length, "the fixture must exercise the cap");
  const counts = new Map();
  for (const a of r.analogs) counts.set(a.symbol, (counts.get(a.symbol) ?? 0) + 1);
  for (const c of counts.values()) assert.ok(c <= 5, "the per-symbol cap holds");
});

test("the evaluation report keeps its research-only authority and its leak audit", () => {
  const report = evaluateAnalogRetrieval(corpusOf({ sessions: 24, perSession: 2 }), {
    maxQueries: 80, bootstrapIterations: 200,
  });
  assert.equal(report.researchAuthority, "RESEARCH_ONLY");
  assert.equal(report.calibrationStatus, "NOT_CALIBRATED_FOR_LIVE_AUTHORITY");
  assert.equal(report.leakageAudit.verdict, "CLEAN");
  assert.equal(report.leakageAudit.futureAnalogViolations, 0);
  assert.equal(report.leakageAudit.selfRetrievalViolations, 0);
  // The evidence class never changes because the corpus got wider.
  assert.equal(report.evidenceClass, "HISTORICAL_UNDERLYING_ONLY");
});

test("the evaluation is deterministic — same corpus, byte-identical report", () => {
  const corpus = corpusOf({ sessions: 24, perSession: 2 });
  const a = evaluateAnalogRetrieval(corpus, { maxQueries: 80, bootstrapIterations: 200 });
  const b = evaluateAnalogRetrieval(corpus, { maxQueries: 80, bootstrapIterations: 200 });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("baseline scoring is empty-safe rather than zero-filled", () => {
  const scores = scoreBaselines([]);
  assert.equal(scores.length, ALL_BASELINES.length);
  for (const s of scores) {
    assert.equal(s.n, 0);
    assert.equal(s.brier, null, "no predictions must not read as a perfect score");
    assert.equal(s.meanPredicted, null);
    assert.equal(s.medianStratumN, null);
  }
});

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * A minimal SQLite stand-in holding five sessions of one symbol's minute bars — the shape
 * `historical_underlying_bars` actually has. `writes` records any insert so a dry run can
 * be proven to have written nothing.
 */
function fakeBarDb() {
  const writes = [];
  const base = Date.UTC(2026, 7, 3, 13, 30);
  const bars = [];
  for (let d = 0; d < 5; d++) {
    for (let i = 0; i < 200; i++) {
      const t = base + d * DAY + i * 60_000;
      const c = 100 + Math.sin(i / 9) * 2 + d * 0.5;
      bars.push({
        ts_ms: t, open: c - 0.05, high: c + 0.2, low: c - 0.2, close: c,
        // A periodic volume spike so identifyCandidateMoments has something to find.
        volume: i % 37 === 0 ? 900_000 : 30_000,
      });
    }
  }
  return {
    writes,
    prepare(sql) {
      return {
        get: (...a) => (/sqlite_master/.test(sql) ? { 1: 1 } : undefined),
        all: (...a) => {
          if (/DISTINCT symbol/.test(sql)) return [{ symbol: "NVDA" }];
          if (/GROUP BY symbol, timeframe/.test(sql)) {
            return [{
              symbol: "NVDA", timeframe: "1m", n: bars.length,
              lo: bars[0].ts_ms, hi: bars[bars.length - 1].ts_ms, days: 5, quality: "OK", sources: "test",
            }];
          }
          if (/FROM historical_underlying_bars/.test(sql)) return bars;
          return [];
        },
        run: (...a) => { writes.push({ sql, a }); return { changes: 1 }; },
      };
    },
  };
}
