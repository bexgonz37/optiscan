/**
 * tests/analog-convergence.test.mjs
 *
 * The Historical Analog Engine convergence layer: evidence classes, the canonical feature
 * vector, leak-fenced retrieval, class-gated outcome distributions, and the chronological
 * evaluator.
 *
 * Most of these assert a REFUSAL. That is deliberate — every failure guarded here returns a
 * number rather than an error, and the number looks fine:
 *
 *   · an option probability computed from a corpus with no option in it
 *   · an episode retrieved as its own best analog, at distance 0
 *   · a "prior" cohort assembled from setups that had not finished resolving yet
 *   · a missing feature scored as an exact match on that dimension
 *   · one afternoon's forty near-identical observations counted as forty confirmations
 *
 * The production corpus makes the first one urgent rather than theoretical: it is 11,679
 * labels, all REAL_UNDERLYING, and zero option outcomes.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  ALL_EVIDENCE_CLASSES,
  EvidencePoolingError,
  assertSingleEvidenceClass,
  evidenceClassComposition,
  evidenceClassSpec,
  isAnalogEvidenceClass,
  optionReturnProbabilityAllowed,
} from "../lib/research/analog/evidence-class.ts";
import {
  ANALOG_FEATURE_FIELDS,
  ANALOG_FEATURE_VECTOR_VERSION,
  buildAnalogFeatureVector,
  describeAnalogFeatureVector,
  encodeDirection,
  encodeLiquidityTier,
  symbolHash,
  vectorFromEpisodeRow,
} from "../lib/research/analog/feature-vector.ts";
import { fitMetric, mdist, mdistPartial } from "../lib/research/analog/similarity.ts";
import {
  duplicateKeyFor,
  retrieveAnalogs,
} from "../lib/research/analog/retrieval.ts";
import {
  ANALOG_MIN_INDEPENDENT_SESSIONS,
  ANALOG_MIN_OBSERVATIONS,
  OptionClaimNotPermittedError,
  availableOutcomeDistributions,
  optionOutcomeDistribution,
  underlyingOutcomeDistribution,
} from "../lib/research/analog/cohort-outcomes.ts";
import { evaluateAnalogRetrieval } from "../lib/research/analog/analog-evaluation.ts";
import { buildDecisionSnapshot } from "../lib/research/shadow/analog-bridge.ts";

// ── fixtures ────────────────────────────────────────────────────────────────
// Real trading sessions (weekdays, no US holidays) so the independent-session floor is
// cleared honestly rather than by a Saturday.
const SESSIONS = [
  "2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05",
  "2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11", "2026-06-12",
];
const DAY_MS = 86_400_000;
const dayStart = (i) => Date.parse(`${SESSIONS[i]}T13:30:00.000Z`);

const vec = (over = {}) =>
  buildAnalogFeatureVector({
    velPct: 1, accelPct: 0.2, rvol: 2, realizedVol: 0.3, atrPct: 1.4,
    posInRange: 0.6, gapPct: 0.1, liquidityTier: "high", direction: "bullish",
    symbol: "NVDA", ...over,
  });

/** A corpus spread across `SESSIONS`, several symbols, all labels resolved same day. */
function corpus({ perSession = 4, symbols = ["NVDA", "AAPL", "MSFT", "AMD"], evidenceClass = "HISTORICAL_UNDERLYING_ONLY" } = {}) {
  const out = [];
  SESSIONS.forEach((day, di) => {
    for (let i = 0; i < perSession; i++) {
      const symbol = symbols[(di * perSession + i) % symbols.length];
      const t0 = dayStart(di) + i * 3_600_000;
      out.push({
        id: `ep_${di}_${i}`,
        symbol,
        t0Ms: t0,
        labelEndMs: t0 + 2 * 3_600_000,
        tradingDay: day,
        evidenceClass,
        vector: vec({ symbol, velPct: 1 + (i % 3), rvol: 1 + (i % 4) / 2, posInRange: ((di + i) % 10) / 10 }),
        outcome: (di + i) % 3 === 0 ? 12 : -6,
      });
    }
  });
  return out;
}

const query = (over = {}) => ({
  id: "QUERY", symbol: "NVDA",
  t0Ms: dayStart(9) + 20 * 3_600_000, // after every fixture label has resolved
  vector: vec(),
  ...over,
});

// ── 1. no future data may enter a T0 feature vector ─────────────────────────

test("1 — the canonical vector exposes clock semantics and a point-in-time source for every field", () => {
  const d = describeAnalogFeatureVector();
  assert.equal(d.version, ANALOG_FEATURE_VECTOR_VERSION);
  assert.ok(d.fields.length > 0);
  for (const f of ANALOG_FEATURE_FIELDS) {
    assert.ok(f.definition.length > 10, `${f.key} defines itself`);
    assert.ok(f.units.length > 0, `${f.key} states units`);
    assert.ok(f.source.length > 0, `${f.key} names a source`);
    assert.ok(f.clockSemantics.length > 0, `${f.key} states clock semantics`);
    assert.ok(f.nullSemantics.length > 0, `${f.key} states null semantics`);
  }
  // posInRange must be the as-of-T0 range, never the whole session.
  const pos = ANALOG_FEATURE_FIELDS.find((f) => f.key === "posInRange");
  assert.match(pos.clockSemantics, /as-of-T0|never the whole-session/i);
});

// ── 2 & 3 & 20. self / future / duplicate retrieval leakage ─────────────────

test("2 — a query episode can never retrieve itself", () => {
  const c = corpus();
  const self = c[0];
  const r = retrieveAnalogs(
    { id: self.id, symbol: self.symbol, t0Ms: dayStart(9) + 20 * 3_600_000, vector: self.vector },
    c,
    { minCoverage: 0, perDuplicateCap: 99, perSymbolCap: 99 },
  );
  assert.ok(!r.analogs.some((a) => a.id === self.id), "self excluded from analogs");
  assert.ok(r.exclusions.SELF >= 1, "self exclusion is counted");
});

test("3 — future / still-resolving episodes are never analogs for an earlier query", () => {
  const c = corpus();
  const q = query({ t0Ms: dayStart(3) }); // mid-corpus
  const r = retrieveAnalogs(q, c, { minCoverage: 0, perDuplicateCap: 99, perSymbolCap: 99 });
  for (const a of r.analogs) {
    const m = c.find((x) => x.id === a.id);
    assert.ok(m.labelEndMs <= q.t0Ms, `${a.id} finished resolving before T0`);
  }
  assert.ok(r.exclusions.FUTURE_OR_UNRESOLVED_AT_T0 > 0, "future exclusions counted");
});

test("3b — an episode that began before T0 but was STILL RESOLVING at T0 is excluded", () => {
  const t0 = dayStart(5);
  const straddler = {
    id: "straddler", symbol: "NVDA", t0Ms: t0 - 60_000, labelEndMs: t0 + 60_000,
    tradingDay: SESSIONS[5], evidenceClass: "HISTORICAL_UNDERLYING_ONLY", vector: vec(), outcome: 30,
  };
  const r = retrieveAnalogs(query({ t0Ms: t0 }), [straddler, ...corpus()], { minCoverage: 0 });
  assert.ok(!r.analogs.some((a) => a.id === "straddler"), "started earlier is not enough; it must have FINISHED");
});

test("20 — duplicate manifestations of one move cannot inflate the cohort", () => {
  const base = corpus();
  const t0 = dayStart(2);
  // Twenty near-identical observations of one afternoon, minutes apart.
  const dupes = Array.from({ length: 20 }, (_, i) => ({
    id: `dup_${i}`, symbol: "TSLA", t0Ms: t0 + i * 30_000, labelEndMs: t0 + 3_600_000,
    tradingDay: SESSIONS[2], evidenceClass: "HISTORICAL_UNDERLYING_ONLY", vector: vec({ symbol: "TSLA" }), outcome: 40,
  }));
  const r = retrieveAnalogs(query(), [...base, ...dupes], { minCoverage: 0, perSymbolCap: 99 });
  const kept = r.analogs.filter((a) => a.id.startsWith("dup_"));
  assert.equal(kept.length, 1, "one bucket contributes one analog");
  assert.ok(r.exclusions.DUPLICATE_MANIFESTATION >= 19);
  assert.equal(
    duplicateKeyFor(dupes[0], 15 * 60_000),
    duplicateKeyFor(dupes[1], 15 * 60_000),
    "same symbol + side + time bucket is one manifestation",
  );
});

test("20b — no single ticker may dominate a retrieved cohort", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: `nvda_${i}`, symbol: "NVDA", t0Ms: dayStart(i % 8) + i * 600_000,
    labelEndMs: dayStart(i % 8) + i * 600_000 + 3_600_000,
    tradingDay: SESSIONS[i % 8], evidenceClass: "HISTORICAL_UNDERLYING_ONLY",
    vector: vec({ symbol: "NVDA" }), outcome: 5,
  }));
  const r = retrieveAnalogs(query(), many, { minCoverage: 0, perSymbolCap: 5 });
  assert.ok(r.analogs.length <= 5, `per-symbol cap held (${r.analogs.length})`);
  assert.ok(r.exclusions.PER_SYMBOL_CAP > 0);
});

// ── 4. evidence classes remain distinct ─────────────────────────────────────

test("4 — pooling different evidence classes is refused, not flagged", () => {
  const mixed = [
    { evidenceClass: "HISTORICAL_UNDERLYING_ONLY" },
    { evidenceClass: "FORWARD_EXACT_OPTION" },
  ];
  assert.throws(() => assertSingleEvidenceClass(mixed), EvidencePoolingError);
  assert.equal(assertSingleEvidenceClass([{ evidenceClass: "MODELED_OPTION" }]), "MODELED_OPTION");
  assert.deepEqual(
    evidenceClassComposition(mixed),
    { FORWARD_EXACT_OPTION: 1, HISTORICAL_UNDERLYING_ONLY: 1 },
    "composition reports, it does not merge",
  );
});

test("4b — every class declares its own claim permissions; modeled is never exact", () => {
  for (const c of ALL_EVIDENCE_CLASSES) {
    const s = evidenceClassSpec(c);
    assert.equal(s.id, c);
    assert.equal(typeof s.optionReturnClaimAllowed, "boolean");
    // A class may only claim option returns if its option leg was actually observed.
    if (s.optionReturnClaimAllowed) assert.equal(s.exactOptionEvidence, true, `${c} claims options only with exact evidence`);
  }
  assert.equal(evidenceClassSpec("MODELED_OPTION").exactOptionEvidence, false);
  assert.equal(optionReturnProbabilityAllowed("MODELED_OPTION"), false);
  assert.equal(isAnalogEvidenceClass("NOT_A_CLASS"), false);
});

// ── 5. underlying-only evidence never produces an option-return probability ──

test("5 — an underlying-only cohort REFUSES to produce an option-return probability", () => {
  const c = corpus({ perSession: 5 });
  const r = retrieveAnalogs(query(), c, { minCoverage: 0, k: 50, perSymbolCap: 50 });
  const input = { retrieval: r, evidenceClass: "HISTORICAL_UNDERLYING_ONLY" };

  assert.throws(() => optionOutcomeDistribution(input), OptionClaimNotPermittedError);
  // ...while the underlying claim it CAN support still works.
  const u = underlyingOutcomeDistribution(input);
  assert.equal(u.kind, "UNDERLYING");

  // The safe surface names the refusal instead of throwing.
  const avail = availableOutcomeDistributions(input);
  assert.equal(avail.option, null);
  assert.ok(avail.underlying);
  assert.ok(avail.refused.some((x) => x.kind === "OPTION" && /no exact option evidence/i.test(x.reason)));
});

test("5b — SHADOW_OBSERVATION supports neither an option nor an underlying outcome claim", () => {
  const r = retrieveAnalogs(query(), corpus(), { minCoverage: 0 });
  const input = { retrieval: r, evidenceClass: "SHADOW_OBSERVATION" };
  assert.throws(() => optionOutcomeDistribution(input), OptionClaimNotPermittedError);
  assert.throws(() => underlyingOutcomeDistribution(input), /does not carry underlying outcome evidence/i);
});

// ── 6 & 7. executable convention; missing bid/ask is not a midpoint ──────────

test("6/7 — exact-option classes keep the executable convention and never synthesize a mid", async () => {
  // The executable convention lives with the population that owns it. These assertions pin
  // the CONTRACT rather than restating it, so a later edit to winner-events cannot quietly
  // move entry to the mid without failing here.
  const src = await import("node:fs").then((fs) =>
    fs.promises.readFile(new URL("../lib/research/historical/winner-events.ts", import.meta.url), "utf8"),
  );
  assert.match(src, /ENTRY\s*=\s*the ASK at T/, "entry crosses the spread");
  assert.ok(/LATER\s*=\s*the MID/.test(src), "later value uses the conservative reading");
  assert.match(src, /using the mid for entry claims a fill nobody was offering/i);

  const adapters = await import("node:fs").then((fs) =>
    fs.promises.readFile(new URL("../lib/research/historical/adapters.ts", import.meta.url), "utf8"),
  );
  assert.match(adapters, /no midpoint synthesis/i, "a missing bid/ask is never filled with a mid");
  assert.match(adapters, /no carry-forward\s*\n?\s*\*?\s*of a stale bid\/ask/i);

  // And the taxonomy agrees about which classes may speak for an option at all.
  assert.equal(optionReturnProbabilityAllowed("HISTORICAL_EXACT_OPTION"), true);
  assert.equal(optionReturnProbabilityAllowed("FORWARD_EXACT_OPTION"), true);
  assert.equal(optionReturnProbabilityAllowed("HISTORICAL_UNDERLYING_ONLY"), false);
});

// ── 8. censored outcomes remain unknown ─────────────────────────────────────

test("8 — a censored analog never becomes a zero and never enters a rate", () => {
  const c = corpus({ perSession: 5 });
  // Censor a third of them.
  c.forEach((m, i) => { if (i % 3 === 0) m.outcome = null; });
  const r = retrieveAnalogs(query(), c, { minCoverage: 0, k: 100, perSymbolCap: 100 });
  const censored = r.analogs.filter((a) => a.outcome === null);
  assert.ok(censored.length > 0, "censored analogs are retrieved, not dropped");
  assert.equal(r.labeledCount, r.analogs.length - censored.length);

  const d = underlyingOutcomeDistribution({ retrieval: r, evidenceClass: "HISTORICAL_UNDERLYING_ONLY" });
  assert.equal(d.quality.censoredCount, censored.length);
  assert.equal(d.quality.labeledSample + d.quality.censoredCount, d.quality.retrievedSample);
  if (d.quality.verdict === "SUPPORTED") {
    for (const m of d.milestones) assert.equal(m.of, d.quality.labeledSample, "rates use the RESOLVED denominator");
  }
});

// ── 9 & 10. evidence quality exposed; small samples abstain ─────────────────

test("9 — every result exposes sample sizes, composition, breadth and versions", () => {
  const r = retrieveAnalogs(query(), corpus({ perSession: 5 }), { minCoverage: 0, k: 100, perSymbolCap: 100 });
  const q = underlyingOutcomeDistribution({ retrieval: r, evidenceClass: "HISTORICAL_UNDERLYING_ONLY" }).quality;
  for (const k of ["eligibleSample", "retrievedSample", "labeledSample", "censoredCount", "independentSessions"]) {
    assert.equal(typeof q[k], "number", `${k} exposed`);
  }
  assert.equal(q.evidenceClass, "HISTORICAL_UNDERLYING_ONLY");
  assert.equal(q.exactOptionEvidence, false);
  assert.equal(q.temporality, "HISTORICAL");
  assert.ok(["SAME_SYMBOL", "CROSS_SYMBOL", "MIXED", "NONE"].includes(q.concentration.symbolScope));
  assert.equal(typeof q.concentration.topSymbolShare, "number");
  assert.equal(q.versions.featureVector, ANALOG_FEATURE_VECTOR_VERSION);
  assert.ok(q.versions.retrieval && q.versions.outcome && q.versions.evidenceClassTaxonomy);
  assert.equal(q.sessionCalendarVersion, "US_EQUITY_SESSION_CAL_V1");
});

test("10 — a tiny sample abstains instead of producing a probability", () => {
  const tiny = corpus({ perSession: 1 }).slice(0, 3);
  const r = retrieveAnalogs(query(), tiny, { minCoverage: 0 });
  const d = underlyingOutcomeDistribution({ retrieval: r, evidenceClass: "HISTORICAL_UNDERLYING_ONLY" });
  assert.equal(d.quality.verdict, "INSUFFICIENT_EVIDENCE");
  assert.equal(d.median, null);
  assert.equal(d.winRate, null);
  for (const m of d.milestones) {
    assert.equal(m.probability, null, "no probability from a tiny sample");
    assert.equal(m.verdict, "INSUFFICIENT_EVIDENCE");
    assert.equal(typeof m.reached, "number", "the counts are still shown");
  }
});

test("10b — 20 observations from ONE session still abstain (the session floor bites)", () => {
  const oneAfternoon = Array.from({ length: 30 }, (_, i) => ({
    id: `one_${i}`, symbol: `S${i % 6}`, t0Ms: dayStart(0) + i * 20 * 60_000,
    labelEndMs: dayStart(0) + i * 20 * 60_000 + 60_000,
    tradingDay: SESSIONS[0], evidenceClass: "HISTORICAL_UNDERLYING_ONLY",
    vector: vec({ symbol: `S${i % 6}` }), outcome: 10,
  }));
  const r = retrieveAnalogs(query(), oneAfternoon, { minCoverage: 0, k: 100, perSymbolCap: 100, perDuplicateCap: 99 });
  const d = underlyingOutcomeDistribution({ retrieval: r, evidenceClass: "HISTORICAL_UNDERLYING_ONLY" });
  assert.equal(d.quality.independentSessions, 1);
  assert.equal(d.quality.verdict, "INSUFFICIENT_EVIDENCE");
  assert.match(d.quality.reason, /independent sessions/);
  assert.equal(ANALOG_MIN_OBSERVATIONS, 20);
  assert.equal(ANALOG_MIN_INDEPENDENT_SESSIONS, 5);
});

// ── 11 & 12. determinism ────────────────────────────────────────────────────

test("11/12 — identical input yields an identical cohort, ordering included", () => {
  const c = corpus({ perSession: 5 });
  const a = retrieveAnalogs(query(), c, { minCoverage: 0, k: 40, perSymbolCap: 40 });
  const b = retrieveAnalogs(query(), [...c].reverse(), { minCoverage: 0, k: 40, perSymbolCap: 40 });
  assert.deepEqual(a.analogs.map((x) => x.id), b.analogs.map((x) => x.id), "corpus order does not change the result");
  assert.deepEqual(a.analogs.map((x) => x.distance), b.analogs.map((x) => x.distance));
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
});

test("12b — ties break on id, so equal distances still order deterministically", () => {
  const identical = SESSIONS.flatMap((day, di) =>
    Array.from({ length: 3 }, (_, i) => ({
      id: `z_${di}_${i}`, symbol: `SYM${i}`, t0Ms: dayStart(di) + i * 3_600_000,
      labelEndMs: dayStart(di) + i * 3_600_000 + 60_000, tradingDay: day,
      evidenceClass: "HISTORICAL_UNDERLYING_ONLY", vector: vec({ symbol: `SYM${i}` }), outcome: 1,
    })),
  );
  const ids = () => retrieveAnalogs(query(), identical, { minCoverage: 0, k: 10, perSymbolCap: 10 }).analogs.map((a) => a.id);
  assert.deepEqual(ids(), ids());
  assert.deepEqual(ids(), [...ids()].sort(), "equal distances fall back to ascending id");
});

// ── 13 & 14 & 15 & 16. no LLM, no provider, no live coupling ────────────────

test("13/14 — the convergence layer imports no AI provider and no network client", async () => {
  const fs = await import("node:fs");
  const files = [
    "evidence-class.ts", "feature-vector.ts", "retrieval.ts",
    "cohort-outcomes.ts", "corpus.ts", "analog-evaluation.ts",
  ];
  for (const f of files) {
    const src = await fs.promises.readFile(new URL(`../lib/research/analog/${f}`, import.meta.url), "utf8");
    assert.ok(!/\bfetch\s*\(/.test(src), `${f} issues no fetch`);
    assert.ok(!/anthropic|openai|\bllm\b/i.test(src.replace(/no LLM/gi, "")), `${f} references no model provider`);
    assert.ok(!/require\(["']https?["']\)|from ["']node:https?["']/.test(src), `${f} opens no network module`);
  }
});

test("15/16 — the live shadow bridge stays inert and unchanged in shape", () => {
  const s = buildDecisionSnapshot(
    { velPct: 1.2, accelPct: 0.3, rvol: 4, realizedVol: 0.02, atrPct: 1.5, posInRange: 0.8, gapPct: 0.5,
      liquidityTier: "high", direction: "bullish", symbol: "ASTS" },
    1000, "ASTS_1000",
  );
  // The keys and encodings the fitted V1 model expects are preserved exactly.
  assert.deepEqual(
    Object.keys(s.features).sort(),
    ["accelPct", "atrPct", "cmp_direction", "cmp_liquidity", "cmp_symbol", "gapPct", "posInRange", "realizedVol", "rvol", "velPct"],
  );
  assert.equal(s.features.cmp_liquidity, 2);
  assert.equal(s.features.cmp_direction, 1);
  assert.equal(s.features.cmp_symbol, symbolHash("ASTS"));
  assert.equal(typeof s.features.velPct, "number");
});

// ── 17. timestamp validator untouched ───────────────────────────────────────

test("17 — the Phase-2A timestamp validator is unchanged (validatorChanged stays false)", async () => {
  const fs = await import("node:fs");
  const src = await fs.promises.readFile(new URL("../lib/research/episode/v2.ts", import.meta.url), "utf8");
  assert.match(src, /validatorChanged:\s*false/, "the four-clock model remains diagnostic-only");
  assert.match(src, /authority:\s*"DIAGNOSTIC_ONLY"/);
});

// ── 18. legacy readability ──────────────────────────────────────────────────

test("18 — legacy episode rows still read through the canonical vector", () => {
  const row = {
    episode_key: "legacy_1", symbol: "AAPL", t0_ms: 1_000_000, trading_day: "2026-06-01",
    direction: "bearish", liquidity_tier: "medium",
    price_structure_json: JSON.stringify({ asOfMs: 1, values: { posInRange: 0.25, gapPct: -1.5 } }),
    momentum_json: JSON.stringify({ asOfMs: 1, values: { velPct: -2, accelPct: -0.4 } }),
    volume_json: JSON.stringify({ asOfMs: 1, values: { rvol: 3.1 } }),
    volatility_json: JSON.stringify({ asOfMs: 1, values: { realizedVol: 0.44, atrPct: 2.2 } }),
  };
  const v = vectorFromEpisodeRow(row);
  assert.equal(v.values.posInRange, 0.25);
  assert.equal(v.values.velPct, -2);
  assert.equal(v.values.cmp_direction, 0);
  assert.equal(v.values.cmp_liquidity, 1);
  assert.equal(v.unavailable.length, 0);
  assert.equal(v.comparable, true);

  // Malformed / absent JSON degrades to nulls, never to zeros.
  const broken = vectorFromEpisodeRow({ symbol: "AAPL", direction: "bullish", liquidity_tier: "high", momentum_json: "{not json" });
  assert.equal(broken.values.velPct, null);
  assert.equal(broken.values.posInRange, null);
  assert.ok(broken.unavailable.includes("velPct"));
  assert.equal(broken.comparable, true, "comparability keys survive missing feature blocks");
});

test("18b — missing is null, and an unknown tier or direction is NOT silently a real value", () => {
  assert.equal(encodeLiquidityTier(null), null);
  assert.equal(encodeLiquidityTier("unknown"), null);
  assert.equal(encodeLiquidityTier("low"), 0, "a genuine low tier is still 0");
  assert.equal(encodeDirection(null), null);
  assert.equal(encodeDirection("bearish"), 0);
  assert.equal(symbolHash(null), null);

  const v = buildAnalogFeatureVector({ direction: "bullish", liquidityTier: "high", symbol: "X" });
  assert.equal(v.values.posInRange, null, "absent posInRange is null, not 0 (0 = at the session low)");
  assert.equal(v.values.rvol, null);
  assert.deepEqual([...v.unavailable].sort(), ["accelPct", "atrPct", "gapPct", "posInRange", "realizedVol", "rvol", "velPct"]);
});

test("18c — a vector missing a comparability key is excluded from retrieval, not defaulted", () => {
  const bad = {
    id: "no_dir", symbol: "NVDA", t0Ms: dayStart(0), labelEndMs: dayStart(0) + 60_000,
    tradingDay: SESSIONS[0], evidenceClass: "HISTORICAL_UNDERLYING_ONLY",
    vector: buildAnalogFeatureVector({ symbol: "NVDA", liquidityTier: "high", velPct: 1 }), // no direction
    outcome: 99,
  };
  const r = retrieveAnalogs(query(), [bad, ...corpus()], { minCoverage: 0 });
  assert.ok(!r.analogs.some((a) => a.id === "no_dir"));
  assert.ok(r.exclusions.NOT_COMPARABLE_VECTOR >= 1);
});

// ── the missing-evidence metric repair ──────────────────────────────────────

test("MISSING EVIDENCE — an absent dimension is dropped from the distance, never scored as a match", () => {
  const dims = ["a", "b", "c"];
  const rows = [];
  const wins = [];
  for (let i = 0; i < 40; i++) { rows.push([i % 10, (i * 3) % 10, (i * 7) % 10]); wins.push(i % 2 === 0); }
  const model = fitMetric(rows, wins, dims, 0.1);

  // Legacy `mdist` treats a non-finite value as z=0 — i.e. exactly the training mean.
  const legacy = mdist(model, [NaN, 5, 5], [model.mean[0], 5, 5]);
  assert.ok(legacy < 1e-9, "legacy: a MISSING value scores as a perfect match on that dimension");

  // The partial metric refuses to invent it.
  const partial = mdistPartial(model, [null, 5, 5], [3, 5, 5]);
  assert.deepEqual(partial.droppedDims, ["a"]);
  assert.deepEqual(partial.sharedDims, ["b", "c"]);
  assert.ok(Math.abs(partial.coverage - 2 / 3) < 1e-9);

  // With no shared support at all there is no distance — not a distance of zero.
  const none = mdistPartial(model, [null, null, null], [1, 2, 3]);
  assert.equal(none.distance, null);
  assert.equal(none.coverage, 0);
});

test("MISSING EVIDENCE — a cohort below the coverage floor is excluded rather than scored", () => {
  const sparse = corpus({ perSession: 4 }).map((m) => ({
    ...m,
    vector: buildAnalogFeatureVector({ symbol: m.symbol, direction: "bullish", liquidityTier: "high", velPct: 1 }),
  }));
  const r = retrieveAnalogs(query(), sparse, { minCoverage: 0.6 });
  assert.equal(r.analogs.length, 0, "1 of 7 dimensions is not enough support to call something an analog");
  assert.ok(r.exclusions.INSUFFICIENT_FEATURE_COVERAGE > 0);
});

// ── 19 & 21 & 22 & 23. evaluation ───────────────────────────────────────────

test("19/21 — the evaluation is chronological, leak-audited and deterministic", () => {
  const c = corpus({ perSession: 6 });
  const a = evaluateAnalogRetrieval(c, { evalFraction: 0.4, retrieval: { minCoverage: 0, perSymbolCap: 20 } });
  const b = evaluateAnalogRetrieval([...c].reverse(), { evalFraction: 0.4, retrieval: { minCoverage: 0, perSymbolCap: 20 } });
  assert.deepEqual(a, b, "same corpus, same report — no clock, no randomness");

  assert.equal(a.leakageAudit.verdict, "CLEAN");
  assert.equal(a.leakageAudit.futureAnalogViolations, 0);
  assert.equal(a.leakageAudit.selfRetrievalViolations, 0);
  assert.equal(a.researchAuthority, "RESEARCH_ONLY");
  assert.equal(a.calibrationStatus, "NOT_CALIBRATED_FOR_LIVE_AUTHORITY");
  assert.ok(a.evalFromMs >= c[0].t0Ms, "queries come from the later part of the corpus");
});

test("21b — the evaluator reports INSUFFICIENT_EVIDENCE rather than inventing a metric", () => {
  const r = evaluateAnalogRetrieval(corpus({ perSession: 1 }).slice(0, 6), { evalFraction: 0.5 });
  assert.equal(r.overallVerdict, "INSUFFICIENT_EVIDENCE");
  assert.equal(r.brier, null);
  assert.equal(r.ece, null);
  assert.equal(r.discrimination.verdict, "INSUFFICIENT_EVIDENCE");
  assert.equal(r.discrimination.spread, null);
  for (const b of r.calibration) {
    if (b.verdict === "INSUFFICIENT_EVIDENCE") assert.equal(b.realizedFrequency, null);
  }
});

test("22 — retrieval is bounded: k, per-symbol and per-duplicate caps all hold", () => {
  const big = Array.from({ length: 1200 }, (_, i) => ({
    id: `b_${i}`, symbol: `SYM${i % 40}`,
    t0Ms: dayStart(i % 9) + i * 60_000, labelEndMs: dayStart(i % 9) + i * 60_000 + 60_000,
    tradingDay: SESSIONS[i % 9], evidenceClass: "HISTORICAL_UNDERLYING_ONLY",
    vector: vec({ symbol: `SYM${i % 40}`, velPct: i % 11, rvol: 1 + (i % 7) / 3 }),
    outcome: i % 4 === 0 ? 20 : -8,
  }));
  const started = process.hrtime.bigint();
  const r = retrieveAnalogs(query(), big, { k: 25, perSymbolCap: 3 });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(r.analogs.length <= 25, "k respected");
  const counts = {};
  for (const a of r.analogs) counts[a.symbol] = (counts[a.symbol] ?? 0) + 1;
  assert.ok(Math.max(...Object.values(counts)) <= 3, "per-symbol cap respected");
  assert.ok(ms < 2000, `bounded latency over a 1,200-row corpus (${ms.toFixed(1)}ms)`);
});

test("23 — the cohort's identity is reproducible: versions travel with every result", () => {
  const r = retrieveAnalogs(query(), corpus({ perSession: 5 }), { minCoverage: 0, k: 100, perSymbolCap: 100 });
  const d = underlyingOutcomeDistribution({ retrieval: r, evidenceClass: "HISTORICAL_UNDERLYING_ONLY" });
  assert.equal(r.retrievalVersion, "ANALOG_RETRIEVAL_V1");
  assert.equal(r.featureVectorVersion, "ANALOG_FEATURE_VECTOR_V1");
  assert.deepEqual(d.quality.versions, {
    outcome: "ANALOG_OUTCOME_V1",
    retrieval: "ANALOG_RETRIEVAL_V1",
    featureVector: "ANALOG_FEATURE_VECTOR_V1",
    evidenceClassTaxonomy: "ANALOG_EVIDENCE_CLASS_V1",
  });
});

// ── same-symbol vs cross-symbol is never hidden ─────────────────────────────

test("COMPOSITION — same-symbol vs cross-symbol is always stated", () => {
  const sameOnly = corpus({ perSession: 4, symbols: ["NVDA"] });
  const rs = retrieveAnalogs(query({ symbol: "NVDA" }), sameOnly, { minCoverage: 0, k: 50, perSymbolCap: 50 });
  assert.equal(rs.composition.symbolScope, "SAME_SYMBOL");
  assert.equal(rs.composition.crossSymbol, 0);
  assert.equal(rs.composition.topSymbolShare, 1);

  const crossOnly = corpus({ perSession: 4, symbols: ["AAPL", "MSFT", "AMD"] });
  const rc = retrieveAnalogs(query({ symbol: "NVDA" }), crossOnly, { minCoverage: 0, k: 50, perSymbolCap: 50 });
  assert.equal(rc.composition.symbolScope, "CROSS_SYMBOL");
  assert.equal(rc.composition.sameSymbol, 0);
  assert.ok(rc.composition.distinctSymbols >= 2);
});
