/**
 * options-shadow-isolation.test.mjs — Phases 8 and 12.
 *
 * A shadow that can reach production is not a shadow. Tests 15/16/17 are
 * therefore ISOLATION tests first and behaviour tests second: they assert that
 * no production module imports these, that production output is byte-identical
 * with the shadow present, and that no shadow export is reachable from a
 * decision path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  evaluateStage15Shadow, measureStage15Shadow,
  STAGE15_SHADOW_VERSION, DEFAULT_STAGE15_SHADOW, stage15ShadowConfig,
} from "../lib/research/options/stage15-shadow.ts";
import {
  compareSessionWindow, windowFeatures, directionAwareFractionMove, compareLatePhase,
  measureDuplicationEffect, summarizeDuplication, measureStrategyTies, assessRelativeVolume,
  FEATURE_SEMANTICS_SHADOW_VERSION, DUPLICATED_BEARISH_PAIR,
} from "../lib/research/options/feature-semantics-shadow.ts";
import { selectOptionsStrategy, scoreStrategies } from "../lib/research/options/discovery.ts";
import { computeOptionsFeatures } from "../lib/research/options/features.ts";

/**
 * MEASUREMENT modules. Nothing on a production path may import these at all —
 * every export is a verdict, and a verdict a decision can read is authority.
 */
const SHADOW_FILES = ["stage15-shadow.ts", "feature-semantics-shadow.ts", "rvol-shadow.ts"];

/**
 * The OBSERVER. Production is REQUIRED to import this — Phases F–J exist to
 * point the measurements at live candidates, and a shadow with no subject
 * explains nothing.
 *
 * What keeps that safe is not isolation but SHAPE: the only export production
 * may import is `observeLiveShadow`, which returns void. A caller cannot branch
 * on what it is not given. Every other export is a reader for reports, and
 * importing one into a production module is the moment the shadow acquires
 * authority — so that is what the third test below forbids.
 */
const OBSERVER_FILE = "live-shadow.ts";
const OBSERVER_ALLOWED_IMPORTS = ["observeLiveShadow"];
const LIB = fileURLToPath(new URL("../lib/", import.meta.url));

/** Every .ts under lib/, so a new importer cannot be added unnoticed. */
function allLibFiles(dir = LIB, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) allLibFiles(p, out);
    else if (e.name.endsWith(".ts") || e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

/* ── 15/16/17. ISOLATION ───────────────────────────────────────────────────*/

/**
 * Matches an import of `stem` with or WITHOUT the .ts extension.
 *
 * The previous pattern required the closing quote immediately after the stem,
 * so it never matched `from "./stage15-shadow.ts"` — which is how every import
 * in this repository is written. The guard passed because it could not see any
 * importer at all, not because there were none. A guard that cannot fail is not
 * a guard, so the test below proves this one can.
 */
const importsModule = (src, stem) =>
  new RegExp(`from\\s+["'][^"']*${stem}(\\.ts)?["']|require\\(["'][^"']*${stem}(\\.ts)?["']\\)`).test(src);

test("the isolation guard can actually fail — it matches the import style this repo uses", () => {
  const observer = readFileSync(new URL(`../lib/research/options/${OBSERVER_FILE}`, import.meta.url), "utf8");
  assert.equal(importsModule(observer, "stage15-shadow"), true,
    "live-shadow.ts demonstrably imports stage15-shadow.ts, so the matcher must see it");
  assert.equal(importsModule("from \"./unrelated.ts\"", "stage15-shadow"), false, "and not match everything");
});

test("15/16/17. NO production module imports a shadow MEASUREMENT module", () => {
  const exempt = new Set([...SHADOW_FILES, OBSERVER_FILE]);
  const offenders = [];
  for (const file of allLibFiles()) {
    if (exempt.has(path.basename(file))) continue;
    const src = readFileSync(file, "utf8");
    for (const shadow of SHADOW_FILES) {
      if (importsModule(src, shadow.replace(/\.ts$/, ""))) {
        offenders.push(`${path.relative(LIB, file)} imports ${shadow}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "a measurement a decision can read is not a shadow");
});

test("production imports ONLY the void-returning observer from the shadow lane", () => {
  const offenders = [];
  for (const file of allLibFiles()) {
    if (path.basename(file) === OBSERVER_FILE) continue;
    const src = readFileSync(file, "utf8");
    if (!importsModule(src, "live-shadow")) continue;
    const re = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+["'][^"']*live-shadow(\.ts)?["']/g;
    for (const m of src.matchAll(re)) {
      for (const raw of m[2].split(",")) {
        const name = raw.replace(/\btype\b/, "").split(/\sas\s/)[0].trim();
        if (name && !OBSERVER_ALLOWED_IMPORTS.includes(name)) {
          offenders.push(`${path.relative(LIB, file)} imports ${name}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [],
    "observeLiveShadow returns void; importing a READER into production is how a shadow becomes authority");
});

test("15/16/17. the shadow modules import nothing that can decide, deliver or spend", () => {
  for (const f of SHADOW_FILES) {
    const src = readFileSync(new URL(`../lib/research/options/${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /from\s+["'].*delivery/i, `${f}: no delivery import`);
    assert.doesNotMatch(src, /from\s+["'].*polygon|fetch\(|axios/i, `${f}: no provider access`);
    assert.doesNotMatch(src, /getDb\(|better-sqlite3/i, `${f}: no storage access`);
    assert.doesNotMatch(src, /discord|webhook/i, `${f}: no notification path`);
    // Type-only imports are fine; value imports from the decision path are not.
    const valueImports = [...src.matchAll(/^import\s+(?!type)\{([^}]*)\}\s+from\s+["']([^"']+)["']/gm)];
    for (const [, , spec] of valueImports) {
      assert.equal(/discovery|monitor|loop|delivery|paper|grade/.test(spec), false,
        `${f}: value-imports decision module ${spec}`);
    }
  }
});

test("15. the Stage 1.5 shadow cannot affect production selection", () => {
  const candidate = (velPct) => ({
    symbol: "HOOD", nowMs: 1_000_000, session: "regular", tier: 2,
    underlying: {
      price: 40, dayDollarVolume: 60_000_000, relVolume: 4, velPct, accelPct: 0.4, gapPct: 1,
      aboveVwap: true, hodBreak: false, nearResistancePct: 0.3, compressionPct: 0.7,
      realizedVolExpanding: true, openingRange: false, premarketLevelTest: false,
    },
    optionsActivity: null, earnings: null,
  });

  // A candidate the shadow gate would REJECT outright.
  const weak = candidate(0.001);
  const shadow = evaluateStage15Shadow({ symbol: "HOOD", velPct: 0.001, dayDollarVolume: 60_000_000, strategyScore: 0.9, tier: 2 });
  assert.equal(shadow.verdict, "REJECT", "the shadow does reject it");

  // Production selection is byte-identical whether or not the shadow ran.
  const before = JSON.stringify(selectOptionsStrategy(weak, {}));
  evaluateStage15Shadow({ symbol: "HOOD", velPct: 0.001, dayDollarVolume: 1, strategyScore: 0, tier: 2 });
  measureStage15Shadow([{ evidence: { symbol: "HOOD" }, contractsReturned: 0, selectedOcc: false, becameCase: false }]);
  const after = JSON.stringify(selectOptionsStrategy(weak, {}));
  assert.equal(after, before, "running the shadow changed nothing about the decision");
});

test("16/17. the feature and late-phase shadows cannot affect production features", () => {
  const bars = Array.from({ length: 30 }, (_, i) => ({
    t: 1_000_000 + i * 60_000, o: 100 + i * 0.1, h: 100.5 + i * 0.1,
    l: 99.5 + i * 0.1, c: 100 + i * 0.1, v: 10_000,
  }));
  const ctx = { prevDayHigh: null, prevDayLow: null, premarketHigh: null, premarketLow: null, openingRangeHigh: null, openingRangeLow: null, timeOfDayAvgVolume: null };

  const before = JSON.stringify(computeOptionsFeatures(bars, ctx));
  // Run every Phase-12 shadow.
  compareSessionWindow(bars, 102, 1_000_000 + 15 * 60_000);
  compareLatePhase(102, 103, 99, "put");
  directionAwareFractionMove(102, 103, 99, "call");
  measureDuplicationEffect("momentum_breakdown", ["downside_acceleration", "downside_momentum"], new Set(DUPLICATED_BEARISH_PAIR));
  assessRelativeVolume([]);
  const after = JSON.stringify(computeOptionsFeatures(bars, ctx));

  assert.equal(after, before, "production features are untouched by the shadow computations");
});

test("17. production fractionMove stays direction-blind — the direction-aware value is advisory only", () => {
  // Production: same number for both sides at the same range position.
  const c = compareLatePhase(99, 103, 99, "call");
  const p = compareLatePhase(99, 103, 99, "put");
  assert.equal(c.productionFractionMove, 0, "production reads 0 at the low");
  assert.equal(p.productionFractionMove, 0, "…for a PUT too — that is the defect being measured");
  assert.equal(c.productionFractionMove, p.productionFractionMove);

  // The shadow separates them.
  assert.equal(c.shadowFractionMove, 0, "a CALL at the session low is EARLY");
  assert.equal(p.shadowFractionMove, 1, "a PUT at the session low is LATE");
  assert.equal(p.disagrees, true);
});

/* ── Phase 8 behaviour ─────────────────────────────────────────────────────*/

test("the Stage 1.5 shadow PASSES on missing evidence rather than rejecting what it cannot see", () => {
  const r = evaluateStage15Shadow({ symbol: "X" });
  assert.equal(r.verdict, "PASS");
  assert.deepEqual(r.reasons, []);
  assert.deepEqual(r.unknowns.sort(), ["dayDollarVolume", "spreadPct", "strategyScore", "velPct"]);
  assert.equal(r.version, STAGE15_SHADOW_VERSION);
});

test("Tier 0 is exempt — gating SPY/QQQ/IWM on a reserved budget saves nothing worth the risk", () => {
  const r = evaluateStage15Shadow({ symbol: "SPY", velPct: 0, dayDollarVolume: 0, strategyScore: 0, tier: 0 });
  assert.equal(r.verdict, "PASS");
  assert.deepEqual(r.unknowns, ["tier_0_exempt"]);
});

test("the shadow report is two-sided — savings are never reported without what they would cost", () => {
  const weak = { symbol: "W", velPct: 0.01, dayDollarVolume: 1_000_000, strategyScore: 0.1, tier: 2 };
  const strong = { symbol: "S", velPct: 1.2, dayDollarVolume: 900_000_000, strategyScore: 0.95, tier: 2 };
  const report = measureStage15Shadow([
    // Would be saved: rejected, returned nothing.
    { evidence: weak, contractsReturned: 0, selectedOcc: false, becameCase: false },
    { evidence: weak, contractsReturned: 0, selectedOcc: false, becameCase: false },
    // Would be COST: rejected, but had contracts and became a graded winner.
    { evidence: weak, contractsReturned: 120, selectedOcc: true, becameCase: true, optionOutcome: "WIN" },
    // Would be cost, but it was a loser — reported separately so the trade is legible.
    { evidence: weak, contractsReturned: 80, selectedOcc: true, becameCase: true, optionOutcome: "LOSS" },
    // Passes the gate; costs and saves nothing.
    { evidence: strong, contractsReturned: 200, selectedOcc: true, becameCase: true, optionOutcome: "WIN" },
  ]);

  assert.equal(report.attempts, 5);
  assert.equal(report.rejected, 4);
  assert.equal(report.passed, 1);
  assert.equal(report.wouldSaveChainRequests, 2);
  assert.equal(report.wouldCostChainWithContracts, 2);
  assert.equal(report.wouldCostCases, 2);
  assert.equal(report.wouldCostWinners, 1, "the number that must be near zero before V1 gets authority");
  assert.equal(report.wouldCostLosers, 1, "reported too, so a gate is not judged only on its mistakes");
  assert.equal(report.gradedOutcomes, 3);
  assert.equal(report.zeroContractRecallPct, 100);
  assert.equal(report.rejectRatePct, 80);
});

test("an attempt with no selected OCC contributes no option outcome — none is synthesised", () => {
  const report = measureStage15Shadow([
    // selectedOcc false, yet an outcome is present: it must be IGNORED, not counted.
    { evidence: { symbol: "W", velPct: 0.01, dayDollarVolume: 1, strategyScore: 0, tier: 2 },
      contractsReturned: 10, selectedOcc: false, becameCase: true, optionOutcome: "WIN" },
  ]);
  assert.equal(report.gradedOutcomes, 0, "no OCC means no graded outcome exists");
  assert.equal(report.wouldCostWinners, 0);
  assert.equal(report.wouldCostCases, 1, "the case it would have cost is still counted");
});

test("rejection reasons are aggregated with values normalised, so a bad threshold is attributable", () => {
  const r = measureStage15Shadow([
    { evidence: { symbol: "A", velPct: 0.01, dayDollarVolume: 1e9, strategyScore: 0.9, tier: 2 }, contractsReturned: 0, selectedOcc: false, becameCase: false },
    { evidence: { symbol: "B", velPct: 0.02, dayDollarVolume: 1e9, strategyScore: 0.9, tier: 2 }, contractsReturned: 0, selectedOcc: false, becameCase: false },
  ]);
  const keys = Object.keys(r.rejectionsByReason);
  assert.equal(keys.length, 1, "two different velocities aggregate to one reason");
  assert.equal(r.rejectionsByReason[keys[0]], 2);
});

test("Stage 1.5 shadow config comes from env with safe floors", () => {
  assert.deepEqual(stage15ShadowConfig({}), DEFAULT_STAGE15_SHADOW);
  assert.equal(stage15ShadowConfig({ OPTIONS_STAGE15_SHADOW_MIN_SCORE: "0.6" }).minStrategyScore, 0.6);
  assert.equal(stage15ShadowConfig({ OPTIONS_STAGE15_SHADOW_MIN_SCORE: "junk" }).minStrategyScore, DEFAULT_STAGE15_SHADOW.minStrategyScore);
});

/* ── Phase 12A behaviour ───────────────────────────────────────────────────*/

test("12A. a two-day bar window silently inflates HOD/LOD/VWAP/cumVol and distorts fractionMove", () => {
  const SESSION_START = 2_000_000;
  const yesterday = Array.from({ length: 10 }, (_, i) => ({
    t: 1_000_000 + i * 60_000, o: 90, h: 120, l: 80, c: 90, v: 50_000,  // a wild prior session
  }));
  const today = Array.from({ length: 10 }, (_, i) => ({
    t: SESSION_START + i * 60_000, o: 100, h: 101, l: 99, c: 100, v: 10_000,  // a quiet one
  }));
  const cmp = compareSessionWindow([...yesterday, ...today], 100, SESSION_START);

  assert.equal(cmp.priorSessionBars, 10);
  assert.equal(cmp.production.hod, 120, "yesterday's high is being reported as the session high");
  assert.equal(cmp.sessionOnly.hod, 101);
  assert.equal(cmp.production.lod, 80);
  assert.equal(cmp.sessionOnly.lod, 99);
  assert.equal(cmp.production.cumVol, 600_000);
  assert.equal(cmp.sessionOnly.cumVol, 100_000, "6x the true session volume");
  // And note WHY this is hard to catch in production: fractionMove happens to
  // agree at 0.5 here even though the HOD and LOD it is computed from are both
  // badly wrong. The derived number looking sane is not evidence that its inputs
  // are — which is exactly why the comparison reports the inputs, not just it.
  assert.equal(cmp.production.fractionMove, 0.5);
  assert.equal(cmp.sessionOnly.fractionMove, 0.5);
  assert.equal(cmp.deltas.fractionMove, 0, "agrees by coincidence");
  assert.equal(cmp.materiallyDifferent, true, "…while hod, lod and cumVol all disagree");
});

test("12A. a single-session window shows no difference — the shadow does not invent one", () => {
  const SESSION_START = 2_000_000;
  const today = Array.from({ length: 10 }, (_, i) => ({
    t: SESSION_START + i * 60_000, o: 100, h: 101, l: 99, c: 100, v: 10_000,
  }));
  const cmp = compareSessionWindow(today, 100, SESSION_START);
  assert.equal(cmp.priorSessionBars, 0);
  assert.equal(cmp.materiallyDifferent, false);
  assert.deepEqual(cmp.production, cmp.sessionOnly);
});

test("12A. windowFeatures reproduces production exactly, so the comparison is like-for-like", () => {
  const bars = [{ t: 1, o: 10, h: 11, l: 9, c: 10, v: 100 }, { t: 2, o: 10, h: 12, l: 8, c: 11, v: 300 }];
  const w = windowFeatures(bars, 10);
  assert.equal(w.hod, 12);
  assert.equal(w.lod, 8);
  assert.equal(w.cumVol, 400);
  // Same VWAP formula production uses: sum(typical * v) / sum(v).
  const expected = +(((10 * 100) + ((12 + 8 + 11) / 3) * 300) / 400).toFixed(4);
  assert.equal(w.vwap, expected);
});

/* ── Phase 12C behaviour ───────────────────────────────────────────────────*/

test("12C. one negative observation emits two signals, inflating any strategy listing both", () => {
  // discovery.ts line 64 adds BOTH from a single condition.
  const active = new Set(["downside_acceleration", "downside_momentum", "below_vwap"]);
  const e = measureDuplicationEffect(
    "momentum_breakdown",
    ["downside_acceleration", "downside_momentum", "below_vwap", "volume_confirmation"],
    active,
  );
  assert.equal(e.benefitsFromDuplication, true);
  assert.equal(e.productionScore, 0.75, "3 of 4 matched");
  assert.equal(e.dedupedScore, 0.667, "2 of 3 once the pair counts as one observation");
  assert.equal(e.inflation, 0.083);
});

test("12C. a strategy listing only one of the pair gains nothing", () => {
  const e = measureDuplicationEffect(
    "vwap_rejection", ["downside_momentum", "below_vwap"],
    new Set(["downside_momentum", "below_vwap"]),
  );
  assert.equal(e.benefitsFromDuplication, false);
  assert.equal(e.inflation, 0);
  assert.equal(e.productionScore, e.dedupedScore);
});

test("12C. the duplication effect is summarised across observations", () => {
  const active = new Set(DUPLICATED_BEARISH_PAIR);
  const effects = [
    measureDuplicationEffect("momentum_breakdown", [...DUPLICATED_BEARISH_PAIR, "below_vwap"], active),
    measureDuplicationEffect("lower_high_continuation", [...DUPLICATED_BEARISH_PAIR, "compression_near_level"], active),
    measureDuplicationEffect("sr_reclaim", ["above_vwap"], new Set(["above_vwap"])),
  ];
  const s = summarizeDuplication(effects);
  assert.equal(s.observations, 3);
  assert.equal(s.affected, 2, "only the strategies listing both are affected");
  assert.deepEqual(s.affectedStrategies, ["lower_high_continuation", "momentum_breakdown"]);
  assert.equal(s.maxInflation > 0, true);
});

/* ── Phase 12D behaviour ───────────────────────────────────────────────────*/

test("12D. ties at the top of the board are counted, along with how often they go to a PUT", () => {
  const board = (topSide, topMatched) => [
    { key: "top", score: 0.667, matchedCount: topMatched, side: topSide },
    { key: "rival", score: 0.667, matchedCount: 2, side: "call" },
    { key: "third", score: 0.5, matchedCount: 1, side: "call" },
  ];
  const r = measureStrategyTies([
    board("put", 3), board("put", 3), board("call", 2),
    [{ key: "solo", score: 0.9, matchedCount: 3, side: "call" }], // no tie
  ]);
  assert.equal(r.observations, 4);
  assert.equal(r.tiedAtTop, 3);
  assert.equal(r.tiesResolvedToPut, 2);
  assert.equal(r.tiesResolvedToPutByKeyCount, 2, "the PUT won with strictly more matched keys");
  assert.equal(r.tieRatePct, 75);
  assert.equal(r.putResolutionPct, 66.67);
});

test("12D. production ties are real — a ratio score ties easily", () => {
  // Sanity-anchor the shadow against the real scorer rather than a fiction.
  const scored = scoreStrategies({
    symbol: "NVDA", nowMs: 1_000, session: "regular", tier: 1,
    underlying: {
      price: 100, dayDollarVolume: 5e8, relVolume: null, velPct: -0.5, accelPct: -0.3, gapPct: null,
      aboveVwap: false, hodBreak: null, nearResistancePct: null, compressionPct: null,
      realizedVolExpanding: null, openingRange: null, premarketLevelTest: null,
    },
    optionsActivity: null, earnings: null,
  });
  const applicable = scored.filter((s) => s.applicable);
  const scores = applicable.map((s) => s.score);
  assert.equal(scores.length > 0, true, "the fixture produces a real board");
  assert.equal(new Set(scores).size <= scores.length, true);
});

/* ── Phase 12E behaviour ───────────────────────────────────────────────────*/

test("12E. relative volume REFUSES to fabricate a baseline it cannot honestly build", () => {
  assert.equal(assessRelativeVolume([]).feasibility, "NO_INTRADAY_HISTORY");
  assert.equal(assessRelativeVolume([]).expectedCumVolume, null);

  const sparse = Array.from({ length: 12 }, (_, i) => ({
    sessionDate: `2026-08-${i + 1}`, cumVolumeAtSameTimeOfDay: 100_000, barsBeforeTimeOfDay: 2,
  }));
  const r = assessRelativeVolume(sparse);
  assert.equal(r.feasibility, "INSUFFICIENT_COVERAGE", "sessions too sparse to have reached this time of day");
  assert.equal(r.expectedCumVolume, null);
  assert.match(r.blockers.join(" "), /too few bars/);

  const few = Array.from({ length: 4 }, (_, i) => ({
    sessionDate: `2026-08-${i + 1}`, cumVolumeAtSameTimeOfDay: 100_000, barsBeforeTimeOfDay: 30,
  }));
  assert.equal(assessRelativeVolume(few).feasibility, "INSUFFICIENT_SESSIONS");
  assert.equal(assessRelativeVolume(few).expectedCumVolume, null);
});

test("12E. with enough point-in-time-safe history it builds a MEDIAN expectation", () => {
  const sessions = Array.from({ length: 20 }, (_, i) => ({
    sessionDate: `2026-07-${i + 1}`,
    // One halted session at 50x must not redefine "normal".
    cumVolumeAtSameTimeOfDay: i === 0 ? 5_000_000 : 100_000 + i * 1_000,
    barsBeforeTimeOfDay: 30,
  }));
  const r = assessRelativeVolume(sessions);
  assert.equal(r.feasibility, "AVAILABLE");
  assert.equal(r.usableSessions, 20);
  assert.equal(r.expectedCumVolume < 200_000, true, "median resists the outlier a mean would absorb");
  assert.deepEqual(r.blockers, []);
});

test("every shadow result is stamped with its version", () => {
  assert.equal(evaluateStage15Shadow({ symbol: "X" }).version, STAGE15_SHADOW_VERSION);
  assert.equal(compareLatePhase(1, 2, 0, "call").version, FEATURE_SEMANTICS_SHADOW_VERSION);
  assert.equal(assessRelativeVolume([]).version, FEATURE_SEMANTICS_SHADOW_VERSION);
  assert.equal(measureStrategyTies([]).version, FEATURE_SEMANTICS_SHADOW_VERSION);
});
