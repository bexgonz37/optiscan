/**
 * tests/high-asymmetry-identity.test.mjs — duplicate detection and identity.
 *
 * Proves that repeated observations of one contract are not silently
 * double-counted, that the audit measures cluster structure without picking a
 * threshold, that the Phase 1 identity's vacuous premium chase is surfaced, and
 * that the active identity does not change on its own.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  auditDetectionClusters,
  groupCandidates,
  recommendIdentity,
  splitIntoClusters,
  CLUSTER_GAP_PROBES_MS,
  CANDIDATE_IDENTITY_STRATEGIES,
} from "../lib/research/asymmetry/identity.ts";

const DAY = "2026-07-30";
const T = Date.parse("2026-07-30T14:00:00Z");
const OCC = "AAPL260731C00150000";

const row = (over = {}) => ({
  id: over.id ?? 1,
  observedAtMs: T,
  sessionDate: DAY,
  symbol: "AAPL",
  direction: "bullish",
  strategyFamily: "DAILY_BREAKOUT",
  candidateState: "READY",
  thesisFingerprint: null,
  alertId: null,
  occSymbolRaw: OCC,
  optionType: "call",
  strike: 150,
  expiration: "2026-07-31",
  bid: 1.00,
  ask: 1.10,
  spreadPct: 9,
  quoteTimestampMs: T - 5_000,
  quoteAgeMs: 5_000,
  volume: 500,
  openInterest: 250,
  delta: 0.5,
  dte: 1,
  underlyingPrice: 150,
  supportLevel: null,
  resistanceLevel: null,
  triggerLevel: 151,
  blockers: [],
  source: "provider:chain",
  freshnessState: "FRESH",
  ...over,
});

const at = (minutes, over = {}) => row({ id: minutes + 1000, observedAtMs: T + minutes * 60_000, ...over });

test("repeated observations of one contract collapse to one candidate, not many", () => {
  // One detection re-observed on four scanner ticks a minute apart.
  const rows = [at(0), at(1), at(2), at(3)];
  const groups = groupCandidates(rows);
  assert.equal(groups.length, 1, "four observations of one contract are one candidate");
  assert.equal(groups[0].rows.length, 4, "but every observation is retained inside the group");
  assert.equal(groups[0].occSymbol, OCC);

  const audit = auditDetectionClusters(rows);
  assert.equal(audit.contractsExamined, 1);
  assert.equal(audit.contractsWithMultipleObservations, 1);
  assert.equal(audit.totalRows, 4);
  assert.equal(audit.candidateCountByStrategy.OCC_SESSION_FIRST_OBSERVATION, 1,
    "the audit must not inflate the candidate count by counting observations");
});

test("cluster counts are reported at several gap widths, not one chosen threshold", () => {
  // Two bursts 40 minutes apart.
  const rows = [at(0), at(1), at(2), at(42), at(43)];
  const audit = auditDetectionClusters(rows);
  const contract = audit.contracts[0];

  assert.equal(contract.clusterCountByGapMs[String(5 * 60_000)], 2, "a 40m quiet gap splits at a 5m probe");
  assert.equal(contract.clusterCountByGapMs[String(15 * 60_000)], 2);
  assert.equal(contract.clusterCountByGapMs[String(30 * 60_000)], 2);
  assert.equal(contract.clusterCountByGapMs[String(60 * 60_000)], 1, "but not at a 60m probe");
  assert.equal(Object.keys(contract.clusterCountByGapMs).length, CLUSTER_GAP_PROBES_MS.length);
  assert.equal(contract.collapsesMultipleClusters, true);
  assert.equal(contract.largestGapsMs[0], 40 * 60_000);
  assert.ok(audit.notes.some((n) => /sensitivity curve, not a tuned threshold/i.test(n)));
});

test("splitting is deterministic and boundary-exact", () => {
  const rows = [at(0), at(15)];
  assert.equal(splitIntoClusters(rows, 15 * 60_000).length, 1, "a gap EQUAL to the width does not split");
  assert.equal(splitIntoClusters(rows, 15 * 60_000 - 1).length, 2, "a gap greater than the width splits");
  assert.deepEqual(splitIntoClusters(rows, 60_000), splitIntoClusters(rows, 60_000));
});

test("the cluster identity recovers separate detections the OCC identity merges", () => {
  const rows = [at(0), at(1), at(42), at(43)];
  assert.equal(groupCandidates(rows, { strategy: "OCC_SESSION_FIRST_OBSERVATION" }).length, 1);
  const clustered = groupCandidates(rows, { strategy: "OCC_SESSION_CLUSTER", clusterGapMs: 15 * 60_000 });
  assert.equal(clustered.length, 2);
  assert.equal(clustered[0].rows.length, 2);
  assert.equal(clustered[1].rows.length, 2);
  assert.notEqual(clustered[0].key, clustered[1].key, "each cluster needs its own stable key");
});

test("the fingerprint identity separates genuinely distinct setups on one contract", () => {
  const rows = [
    at(0, { thesisFingerprint: "fp-a" }),
    at(1, { thesisFingerprint: "fp-a" }),
    at(2, { thesisFingerprint: "fp-b" }),
  ];
  const groups = groupCandidates(rows, { strategy: "OCC_SESSION_FINGERPRINT" });
  assert.equal(groups.length, 2);

  const audit = auditDetectionClusters(rows);
  assert.equal(audit.contractsWithMultipleFingerprints, 1);
  assert.equal(audit.rowsCarryingFingerprint, 3);
  assert.equal(audit.recommendation, "ADOPT_OCC_SESSION_FINGERPRINT",
    "direct fingerprint evidence outranks a gap heuristic");
});

test("rows with no persisted fingerprint are not invented one", () => {
  const groups = groupCandidates([at(0), at(1)], { strategy: "OCC_SESSION_FINGERPRINT" });
  assert.equal(groups.length, 1);
  assert.match(groups[0].key, /NO_FINGERPRINT$/, "an absent fingerprint is named, not fabricated");
});

test("the vacuous premium chase of the Phase 1 identity is surfaced", () => {
  // Under OCC_SESSION_FIRST_OBSERVATION the candidate is the earliest row, so
  // no strictly-earlier quote exists to anchor the chase against.
  const audit = auditDetectionClusters([at(0), at(1), at(2)]);
  assert.equal(audit.candidatesWithVacuousPremiumChase, 1);
  assert.ok(audit.notes.some((n) => /premium chase is structurally 0% or UNKNOWN/i.test(n)));
});

test("the audit never changes the active identity by itself", () => {
  const rows = [at(0), at(1), at(42)];
  const audit = auditDetectionClusters(rows);
  assert.equal(audit.advisoryOnly, true);
  assert.equal(audit.productionBehaviorChanged, false);
  assert.ok(audit.notes.some((n) => /active identity is unchanged/i.test(n)));

  // The default grouping is still the Phase 1 identity despite the finding.
  assert.equal(groupCandidates(rows)[0].strategy, "OCC_SESSION_FIRST_OBSERVATION");
  assert.equal(groupCandidates(rows).length, 1);
});

test("no identity is recommended without evidence", () => {
  const empty = auditDetectionClusters([]);
  assert.equal(empty.recommendation, "INSUFFICIENT_EVIDENCE");
  assert.match(empty.recommendationReason, /No persisted observations/);
  assert.equal(empty.contractsExamined, 0);

  assert.equal(recommendIdentity({
    contractsExamined: 0, contractsWithMultipleClustersByGapMs: {}, contractsWithMultipleFingerprints: 0,
    rowsCarryingFingerprint: 0, totalRows: 0,
  }).recommendation, "INSUFFICIENT_EVIDENCE");
});

test("a single-cluster single-fingerprint cohort keeps the current identity", () => {
  const audit = auditDetectionClusters([at(0), at(1), at(2)]);
  assert.equal(audit.recommendation, "KEEP_OCC_SESSION_FIRST_OBSERVATION");
  assert.equal(audit.contractsWithMultipleFingerprints, 0);
});

test("every strategy is enumerated and produces a deterministic count", () => {
  const rows = [at(0), at(42, { thesisFingerprint: "fp-b" })];
  const audit = auditDetectionClusters(rows);
  for (const strategy of CANDIDATE_IDENTITY_STRATEGIES) {
    assert.equal(typeof audit.candidateCountByStrategy[strategy], "number");
    assert.deepEqual(groupCandidates(rows, { strategy }), groupCandidates(rows, { strategy }));
  }
});

test("different contracts are never merged", () => {
  const rows = [at(0), at(1, { occSymbolRaw: "AAPL260731P00150000", optionType: "put" })];
  const groups = groupCandidates(rows);
  assert.equal(groups.length, 2);
  assert.equal(auditDetectionClusters(rows).contractsExamined, 2);
});

// ── Source priority ────────────────────────────────────────────────────────

test("missing sources are ranked by cost to obtain, never by assumed importance", async () => {
  const { rankMissingSources, MISSING_SOURCE_PROFILES } = await import("../lib/research/asymmetry/source-priority.ts");
  const ranked = rankMissingSources();

  assert.equal(ranked.measured, false);
  assert.equal(ranked.advisoryOnly, true);
  assert.equal(ranked.productionBehaviorChanged, false);
  for (const source of ranked.sources) {
    assert.equal(source.discriminationEvidence, "UNMEASURED_HYPOTHESIS",
      `${source.field} must not claim measured predictive power`);
    assert.equal(source.candidatesAffected, null, "unmeasured reach is null, never zero");
    assert.ok(source.providerEvidence.length > 0, `${source.field} must cite its provider evidence`);
  }
  assert.ok(ranked.notes.some((n) => /NOT ordered by predictive power/i.test(n)));

  // Ordering must be non-decreasing in acquisition cost.
  for (let i = 1; i < ranked.sources.length; i += 1) {
    assert.ok(ranked.sources[i].acquisitionRank >= ranked.sources[i - 1].acquisitionRank);
  }
  // The one thing already in hand must outrank the one the provider cannot supply.
  const iv = ranked.sources.findIndex((s) => s.field === "impliedVolatility");
  const historical = ranked.sources.findIndex((s) => s.field === "historicalOptionQuotes");
  assert.ok(iv < historical, "an already-fetched field must rank above an unavailable one");
  assert.equal(MISSING_SOURCE_PROFILES.every((p) => p.discriminationEvidence === "UNMEASURED_HYPOTHESIS"), true);
});

test("measured reach is attached only when a real replay supplied it", async () => {
  const { rankMissingSources } = await import("../lib/research/asymmetry/source-priority.ts");
  const coverage = { distinctCandidateDetections: 4 };
  const ranked = rankMissingSources(coverage, { impliedVolatility: { count: 4 } });

  assert.equal(ranked.measured, true);
  assert.equal(ranked.sources.find((s) => s.field === "impliedVolatility").candidatesAffected, 4);
  assert.equal(ranked.sources.find((s) => s.field === "gamma").candidatesAffected, null,
    "a field the replay did not report stays null, not zero");
});
