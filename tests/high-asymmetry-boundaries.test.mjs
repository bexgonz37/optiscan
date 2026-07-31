/**
 * tests/high-asymmetry-boundaries.test.mjs — the boundaries the High-Asymmetry
 * Radar must never cross, asserted explicitly rather than inferred from the
 * advisory flag alone:
 *
 *  1. No research state can produce a SEND.
 *  2. The module imports nothing from delivery, notification, paper-execution,
 *     scanner, broker, or AI-application paths.
 *  3. AI is explanatory only — there is no AI in this module at all.
 *  4. A negative or empty cohort is never described as profitable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ASYMMETRY_RESEARCH_STATES,
  RESEARCH_STATE_CAN_SEND,
  canResearchStateSend,
  deriveResearchState,
} from "../lib/research/asymmetry/states.ts";
import { normalizeAsymmetryEvidence } from "../lib/research/asymmetry/evidence.ts";
import { analyzePremiumChase } from "../lib/research/asymmetry/premium-chase.ts";
import { buildAsymmetryResearchReport } from "../lib/research/asymmetry/report.ts";
import { compareCohorts } from "../lib/research/asymmetry/cohorts.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = join(HERE, "..", "lib", "research", "asymmetry");
const ROUTE = join(HERE, "..", "app", "api", "research", "asymmetry", "route.ts");

const T = Date.parse("2026-07-30T14:00:00Z");
const OCC = "AAPL260731C00150000";

const rawEvidence = (over = {}) => ({
  candidateId: "c1", symbol: "AAPL", direction: "bullish", detectionAtMs: T,
  setupFamily: "DAILY_BREAKOUT", underlyingPrice: 150,
  occSymbol: OCC, expiration: "2026-07-31", strike: 150, optionType: "call", dte: 1,
  bid: 1.00, ask: 1.10, quoteTimestampMs: T - 5_000,
  optionVolume: 500, openInterest: 250,
  ...over,
});

test("no research state can authorize a SEND", () => {
  assert.equal(ASYMMETRY_RESEARCH_STATES.length, 8);
  for (const state of ASYMMETRY_RESEARCH_STATES) {
    assert.equal(RESEARCH_STATE_CAN_SEND[state], false, `${state} must never be sendable`);
    assert.equal(canResearchStateSend(state), false);
  }
  assert.ok(Object.isFrozen(RESEARCH_STATE_CAN_SEND), "the authority table must not be mutable at runtime");
  assert.equal(Object.values(RESEARCH_STATE_CAN_SEND).some(Boolean), false);
});

test("even the strongest state carries no authority and no subscriber readiness", () => {
  const evidence = normalizeAsymmetryEvidence(rawEvidence({
    relativeStockVolume: 5, relativeVolumeBaselineSource: "provider:baseline",
    volumeAcceleration: 2, volumeAccelerationWindowMs: 300_000,
    distanceToLevelPct: 0.5, roomToNextLevelPct: 4, levelSource: "daily_bars",
    underlyingMovePctBeforeDetection: 1.2, underlyingMoveWindowMs: 900_000,
  }));
  const chase = analyzePremiumChase({
    occSymbol: OCC, candidateAtMs: T, candidateAsk: evidence.ask,
    priorQuotes: [{ occSymbol: OCC, atMs: T - 60_000, bid: 1.02, ask: 1.08, quoteTimestampMs: T - 61_000, source: "test" }],
  });
  const state = deriveResearchState(evidence, chase, {
    confirmationAtMs: T - 30_000, confirmationSource: "session_candles_1m",
  });

  assert.equal(state.state, "HIGH_ASYMMETRY");
  assert.equal(state.canSend, false);
  assert.equal(state.notSubscriberReady, true);
  assert.equal(state.evidenceCoverage, 1);
  assert.deepEqual(state.missingFields, []);
});

test("state precedence is deterministic and evidence-driven", () => {
  const evidence = normalizeAsymmetryEvidence(rawEvidence());
  const cleanChase = analyzePremiumChase({
    occSymbol: OCC, candidateAtMs: T, candidateAsk: 1.10,
    priorQuotes: [{ occSymbol: OCC, atMs: T - 60_000, bid: 1.02, ask: 1.08, quoteTimestampMs: T - 61_000, source: "test" }],
  });
  const chasedChase = analyzePremiumChase({
    occSymbol: OCC, candidateAtMs: T, candidateAsk: 1.10,
    priorQuotes: [{ occSymbol: OCC, atMs: T - 60_000, bid: 0.75, ask: 0.80, quoteTimestampMs: T - 61_000, source: "test" }],
  });

  assert.equal(deriveResearchState(evidence, cleanChase).state, "EARLY_ASYMMETRY");
  assert.equal(deriveResearchState(evidence, cleanChase, {
    confirmationAtMs: T - 10_000, confirmationSource: "session_candles_1m",
  }).state, "CONFIRMING", "confirmed but incomplete coverage cannot reach HIGH_ASYMMETRY");
  assert.equal(deriveResearchState(evidence, cleanChase, {
    triggerConfirmedAtMs: T - 10_000, triggerSource: "session_candles_1m",
  }).state, "TRIGGERED");
  assert.equal(deriveResearchState(evidence, chasedChase).state, "PREMIUM_CHASE");
  assert.equal(deriveResearchState(evidence, cleanChase, {
    invalidatedAtMs: T - 10_000, invalidationSource: "session_candles_1m",
  }).state, "INVALIDATED", "a sourced invalidation outranks the premium-chase bucket");

  const illiquid = normalizeAsymmetryEvidence(rawEvidence({ openInterest: 0 }));
  assert.equal(deriveResearchState(illiquid, cleanChase).state, "LIQUIDITY_FAILURE");

  const noQuote = normalizeAsymmetryEvidence(rawEvidence({ quoteTimestampMs: null }));
  assert.equal(deriveResearchState(noQuote, cleanChase).state, "INSUFFICIENT_EVIDENCE");
});

test("an unsourced confirmation, trigger, or invalidation is ignored", () => {
  const evidence = normalizeAsymmetryEvidence(rawEvidence());
  const chase = analyzePremiumChase({
    occSymbol: OCC, candidateAtMs: T, candidateAsk: 1.10,
    priorQuotes: [{ occSymbol: OCC, atMs: T - 60_000, bid: 1.02, ask: 1.08, quoteTimestampMs: T - 61_000, source: "test" }],
  });
  assert.equal(deriveResearchState(evidence, chase, { confirmationAtMs: T - 10_000 }).state, "EARLY_ASYMMETRY");
  assert.equal(deriveResearchState(evidence, chase, { triggerConfirmedAtMs: T - 10_000 }).state, "EARLY_ASYMMETRY");
  assert.equal(deriveResearchState(evidence, chase, { invalidatedAtMs: T - 10_000 }).state, "EARLY_ASYMMETRY");
  // A confirmation stamped in the FUTURE cannot confirm a past candidate.
  assert.equal(deriveResearchState(evidence, chase, {
    confirmationAtMs: T + 60_000, confirmationSource: "session_candles_1m",
  }).state, "EARLY_ASYMMETRY");
});

test("the module imports no delivery, notification, paper, scanner, broker, or AI path", () => {
  const forbidden = [
    /from\s+["'][^"']*\/(delivery|delivery-decision|callout|callouts)["']/,
    /from\s+["'][^"']*notifications?\//,
    /from\s+["'][^"']*\/(paper|paper-chain|paper-engine|paper-lifecycle)[."']/,
    /from\s+["'][^"']*\/(discord|webhook)/i,
    /from\s+["'][^"']*\/broker\//,
    /from\s+["'][^"']*\/(ai|ml)\//,
    /from\s+["'][^"']*scanner/i,
    /from\s+["'][^"']*\/twitter/i,
    /from\s+["'][^"']*social/i,
  ];
  // The paper lane lives in a subdirectory and is subject to the SAME rules —
  // it was outside this sweep when it was added, which is exactly how an
  // unguarded module gets in.
  const files = [
    ...readdirSync(MODULE_DIR).filter((f) => f.endsWith(".ts")).map((f) => ({ label: f, path: join(MODULE_DIR, f) })),
    ...readdirSync(join(MODULE_DIR, "paper")).filter((f) => f.endsWith(".ts"))
      .map((f) => ({ label: `paper/${f}`, path: join(MODULE_DIR, "paper", f) })),
  ];
  assert.ok(files.length >= 12, "the radar modules must exist to be checked");

  for (const { label, path } of files) {
    const source = readFileSync(path, "utf8");
    for (const pattern of forbidden) {
      assert.equal(pattern.test(source), false, `${label} must not import ${pattern}`);
    }
    // No module may IMPLEMENT a send. The transport lives in private-send.ts,
    // which the scheduler injects — the same dependency-injection boundary the
    // AI advisory already uses. What is forbidden here is a research module
    // reaching the network or a subscriber delivery function by itself.
    assert.equal(/\bfetch\s*\(/.test(source), false, `${label} must contain no network call`);
    assert.equal(/\b(sendDiscord|postToDiscord|sendTrackedDiscord|deliverOptionsCallout|deliverCalloutDiscord|notifyNewAlert|sendOwner\w*)\b/.test(source), false,
      `${label} must not call a delivery or notification function`);
    // Any `deliver*` identifier that survives must be an INJECTED dependency or
    // a declaration — never an imported implementation.
    for (const [, name] of source.matchAll(/\b(deliver[A-Z]\w*)\b/g)) {
      const imported = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(source)
        || new RegExp(`require\\([^)]*\\)[^;]*\\b${name}\\b`).test(source);
      assert.equal(imported, false, `${label} must not import ${name}; delivery is injected, not imported`);
    }
  }
});

test("the diagnostics route is read-only and exposes no secrets", () => {
  const source = readFileSync(ROUTE, "utf8");
  assert.equal(/export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)/.test(source), false,
    "the research endpoint must expose GET only");
  assert.ok(/checkApiToken/.test(source), "the endpoint must be token-gated");

  // Comments are stripped first: prose that NAMES a boundary ("exposes no
  // Discord configuration") must not be mistaken for crossing it.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const secret of [/WEBHOOK/i, /DISCORD/i, /TOKEN\s*[:=]/i, /process\.env\./]) {
    assert.equal(secret.test(code), false, `the route must not reference ${secret}`);
  }
});

test("an empty cohort reports zero and is never described as profitable", () => {
  const report = buildAsymmetryResearchReport([], { evaluationAtMs: T });
  assert.equal(report.candidates.length, 0);
  assert.equal(report.outsizedCount, 0);
  assert.equal(report.cohortComparison.cohortSizes.OUTSIZED, 0);
  assert.equal(report.cohortComparison.outcomeRates.OUTSIZED.sharePct, null,
    "a share of nothing is unknown, not 0% and not a result");
  assert.equal(report.cohortComparison.topFeature, null);
  for (const feature of report.cohortComparison.numericFeatures) {
    assert.equal(feature.sufficientEvidence, false);
    for (const cohort of ["OUTSIZED", "ORDINARY", "FAILED"]) {
      assert.equal(feature.byCohort[cohort].median, null);
      assert.equal(feature.byCohort[cohort].average, null);
    }
  }
  const serialized = JSON.stringify(report);
  assert.equal(/profit|PROFITABLE|guaranteed|will produce/i.test(serialized), false,
    "no profitability or guarantee language may appear in the report");
});

test("a failing cohort is never dressed up as a win", () => {
  const failing = Array.from({ length: 5 }, (_, i) => ({
    evidence: rawEvidence({ candidateId: `f${i}` }),
    marks: [{ occSymbol: OCC, atMs: T + 5 * 60_000, bid: 0.40, ask: 0.45, quoteTimestampMs: T + 5 * 60_000 - 1_000, source: "test" }],
  }));
  const report = buildAsymmetryResearchReport(failing, { evaluationAtMs: T + 60 * 60_000, minimumSupportedSample: 1 });

  assert.equal(report.outcomeCounts.FAILED, 5);
  assert.equal(report.outsizedCount, 0);
  assert.equal(report.cohortComparison.cohortSizes.FAILED, 5);
  assert.equal(report.cohortComparison.cohortSizes.OUTSIZED, 0);
  assert.equal(report.cohortComparison.topFeature, null,
    "no feature may be named discriminating from a cohort with no outsized members");
});

test("sufficientEvidence requires every compared cohort to reach the minimum", () => {
  const rows = [];
  const push = (label, bid, n) => {
    for (let i = 0; i < n; i += 1) {
      rows.push({
        evidence: rawEvidence({ candidateId: `${label}${i}` }),
        marks: [{ occSymbol: OCC, atMs: T + 5 * 60_000, bid, ask: bid + 0.05, quoteTimestampMs: T + 5 * 60_000 - 1_000, source: "test" }],
      });
    }
  };
  push("out", 3.00, 2);   // OUTSIZED
  push("ord", 1.30, 2);   // ORDINARY
  push("bad", 0.40, 1);   // FAILED — one short of the minimum

  const report = buildAsymmetryResearchReport(rows, { evaluationAtMs: T + 60 * 60_000, minimumSupportedSample: 2 });
  assert.equal(report.cohortComparison.cohortSizes.OUTSIZED, 2);
  assert.equal(report.cohortComparison.cohortSizes.FAILED, 1);
  const spread = report.cohortComparison.numericFeatures.find((f) => f.feature === "spreadPct");
  assert.equal(spread.sufficientEvidence, false, "FAILED is under the minimum, so no feature is sufficiently evidenced");
});

test("missing feature values are excluded from statistics, not counted as zero", () => {
  const withValue = {
    evidence: rawEvidence({ candidateId: "a", relativeStockVolume: 6, relativeVolumeBaselineSource: "provider:baseline" }),
    marks: [{ occSymbol: OCC, atMs: T + 60_000, bid: 3.00, ask: 3.05, quoteTimestampMs: T + 59_000, source: "test" }],
  };
  const withoutValue = {
    evidence: rawEvidence({ candidateId: "b" }),
    marks: [{ occSymbol: OCC, atMs: T + 60_000, bid: 3.00, ask: 3.05, quoteTimestampMs: T + 59_000, source: "test" }],
  };
  const report = buildAsymmetryResearchReport([withValue, withoutValue], { evaluationAtMs: T + 60 * 60_000, minimumSupportedSample: 1 });
  const relVol = report.cohortComparison.numericFeatures.find((f) => f.feature === "relativeStockVolume");

  assert.equal(relVol.byCohort.OUTSIZED.sampleSize, 1);
  assert.equal(relVol.byCohort.OUTSIZED.missingCount, 1);
  assert.equal(relVol.byCohort.OUTSIZED.average, 6, "the average must be 6, not 3 — the absent value is not a zero");
  assert.equal(relVol.byCohort.OUTSIZED.median, 6);
});

test("an empty comparison names no best feature and asserts no causation", () => {
  const comparison = compareCohorts([], { minimumSupportedSample: 1 });
  assert.equal(comparison.topFeature, null);
  assert.equal(comparison.advisoryOnly, true);
  assert.equal(comparison.productionBehaviorChanged, false);
  assert.ok(comparison.notes.some((n) => /No causal relationship/i.test(n)));
});

test("the report states plainly that it is not subscriber performance or a prediction", () => {
  const report = buildAsymmetryResearchReport([], { evaluationAtMs: T });
  assert.equal(report.advisoryOnly, true);
  assert.equal(report.productionBehaviorChanged, false);
  assert.equal(report.shadowOnly, true);
  assert.ok(report.limitations.some((l) => /not predictions/i.test(l)));
  assert.ok(report.limitations.some((l) => /cannot send, rank, gate, or alter/i.test(l)));
  assert.ok(report.limitations.some((l) => /never substituted with zero/i.test(l)));
});
