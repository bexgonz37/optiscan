/**
 * tests/research-command-center.test.mjs
 *
 * PHASES 2, 3, 4 and 9 — the private research view, its tooltips, "Explain this",
 * and the readiness trajectory.
 *
 * The properties under test are the ones that decide whether this page can mislead:
 *
 *   1. OPENED TODAY and CLOSED TODAY are different populations. 42 of 74 owner
 *      callouts in production cross a session boundary, so a single "today" number
 *      would be wrong for more than half the lane.
 *   2. A NULL IS NEVER A ZERO. "No trades closed today" and "the trades that closed
 *      today averaged zero" are different statements.
 *   3. Owner-validation evidence is never presented as subscriber performance.
 *   4. A shadow experiment below its evidence floors reports INSUFFICIENT_EVIDENCE and
 *      carries "does not affect live callouts" as a field, not a footnote.
 *   5. Every metric the page renders a tooltip for exists in the ONE glossary. A
 *      component that defines its own wording is a component whose tooltip and whose
 *      explanation will eventually disagree about the same number.
 *   6. "Explain this" resolves by STABLE ID and never by ticker text.
 */
import "./helpers/register-alias.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";

import {
  buildResearchCommandCenterOnDb,
  buildTodayPanel,
} from "../lib/research/options/research-command-center.ts";
import { buildExplainTarget, explainQuestionFor } from "../lib/ai/explain-target.ts";
import { METRIC_GLOSSARY, metricInfo } from "../lib/metric-glossary.ts";
import { buildAdvisoryEvidencePacket } from "../lib/ai/advisory-chat-evidence.ts";

const { applyProductionSchemaOnDb } = await import("@/lib/db");

const DAY = 86_400_000;
const MIN = 60_000;
// 2026-08-19 is a Wednesday, mid-session.
const NOW = Date.parse("2026-08-19T18:00:00.000Z");

function db() {
  const d = new Database(":memory:");
  applyProductionSchemaOnDb(d);
  return d;
}

const row = (over = {}) => ({
  opportunityCaseId: "oc_x",
  preMoveCaseId: "oc_p",
  paperTradeId: 1,
  symbol: "IWM",
  optionSymbol: "O:IWM260819P00301000",
  frozenOptionSymbol: "O:IWM260819P00301000",
  occExact: true,
  side: "PUT",
  strategyKey: "lower_high_continuation",
  setupFamily: "lower_high_continuation",
  dte: 0,
  sessionDate: "2026-08-19",
  enteredAtMs: NOW - 2 * 3600_000,
  closedAtMs: NOW - 1 * 3600_000,
  exitSessionDate: "2026-08-19",
  status: "EXITED",
  exitReason: "TARGET_1",
  entryFill: 1, targetT1: 1.5, targetT2: 2, stop: 0.7,
  realizedReturnPct: 20,
  realizedEvidence: "VERIFIED",
  excursionState: "VERIFIED_EXCURSION",
  mfePct: 44, maePct: -12,
  marksOnContract: 100,
  exactContractMarksAvailable: true,
  msToMilestone: { 10: 5 * MIN, 25: null },
  pathLabel: "EVENTUAL_T1_WINNER",
  flags: [],
  stopEvidence: { stopSlippagePct: null, overnightGapPct: null, crossedSessionBoundary: false },
  selection: {
    deliveryQualityScore: 81, selectionStrength: 100, strategyVersion: "v1",
    signalVerdict: "SUPPORTIVE", signalsMatched: 5, contradictingEvidence: 0,
    readinessState: null, ownerReason: null, discoveryStage: "PRE_TRIGGER",
    rewardRemainingBand: "LARGE_REMAINING", rewardRemainingFraction: 1,
    moveConsumedFraction: 0, premiumExpansionConsumedPct: 0,
    spreadPct: null, delta: null, openInterest: null, contractVolume: null,
  },
  limitations: [],
  ...over,
});

// ── TODAY: two populations, never one ────────────────────────────────────────

test("OPENED TODAY and CLOSED TODAY are counted separately and never summed", () => {
  const t = buildTodayPanel([
    // opened today, still open
    row({ enteredAtMs: NOW - 30 * MIN, closedAtMs: null, status: "ENTERED", realizedReturnPct: null, realizedEvidence: "STILL_OPEN" }),
    // opened today, closed today
    row({ enteredAtMs: NOW - 3 * 3600_000, closedAtMs: NOW - 2 * 3600_000, realizedReturnPct: 30 }),
    // opened THREE DAYS AGO, closed today — the case a single "today" number gets wrong
    row({ enteredAtMs: NOW - 3 * DAY, closedAtMs: NOW - 30 * MIN, realizedReturnPct: -40 }),
    // opened and closed two days ago — belongs to neither
    row({ enteredAtMs: NOW - 2 * DAY, closedAtMs: NOW - 2 * DAY + 3600_000, realizedReturnPct: 10 }),
  ], NOW);

  assert.equal(t.openedToday, 2);
  assert.equal(t.closedToday, 2);
  assert.equal(t.openNow, 1);
  assert.equal(t.closedTodayOpenedEarlier, 1,
    "a trade opened on a prior session and closed today must be visibly flagged");
  assert.notEqual(t.openedToday + t.closedToday, 3, "the two are never a total");
});

test("today's rates describe the trades that CLOSED today, and open trades are excluded", () => {
  const t = buildTodayPanel([
    row({ enteredAtMs: NOW - 30 * MIN, closedAtMs: null, status: "ENTERED", realizedReturnPct: null, realizedEvidence: "STILL_OPEN" }),
    row({ enteredAtMs: NOW - 3 * 3600_000, closedAtMs: NOW - 2 * 3600_000, realizedReturnPct: 30 }),
    row({ enteredAtMs: NOW - 3 * DAY, closedAtMs: NOW - 30 * MIN, realizedReturnPct: -10 }),
  ], NOW);

  assert.equal(t.wins, 1);
  assert.equal(t.losses, 1);
  assert.equal(t.winRate, 0.5, "2 closes, 1 win — the open trade is not a scratch");
  assert.equal(t.expectancyPct, 10, "(30 + -10) / 2");
  assert.equal(t.profitFactor, 3);
});

test("a day with no closes reports NULL rates, never zeroes", () => {
  const t = buildTodayPanel([
    row({ enteredAtMs: NOW - 30 * MIN, closedAtMs: null, status: "ENTERED", realizedReturnPct: null, realizedEvidence: "STILL_OPEN" }),
  ], NOW);
  assert.equal(t.closedToday, 0);
  assert.equal(t.winRate, null, "0% win rate is a claim; no closes is an absence");
  assert.equal(t.expectancyPct, null);
  assert.equal(t.profitFactor, null);
  assert.equal(t.medianReturnPct, null);
});

// ── the assembled panel ──────────────────────────────────────────────────────

test("an empty database produces an honest empty panel, not a zero-filled one", () => {
  const r = buildResearchCommandCenterOnDb(db(), { nowMs: NOW });
  assert.deepEqual(r.faults, [], "every section must build on an empty database");
  assert.equal(r.today.closedToday, 0);
  assert.equal(r.today.winRate, null);
  assert.equal(r.currentEdge.profitFactor, null);
  assert.equal(r.currentEdge.sampleSize, 0);
  for (const p of Object.values(r.currentEdge.probabilities)) {
    assert.equal(p.rate, null, "no evidence means an unknown probability, never 0");
  }
});

test("the current-edge panel states, as a field, that it is not subscriber performance", () => {
  const r = buildResearchCommandCenterOnDb(db(), { nowMs: NOW });
  assert.equal(r.currentEdge.notSubscriberPerformance, true);
  assert.ok(
    r.currentEdge.limitations.some((l) => /NO SUBSCRIBER RECEIVED/i.test(l)),
    "the label must travel with the figures, not sit in a footnote elsewhere",
  );
  assert.match(r.currentEdge.population, /OWNER_VALIDATION_PAPER/);
});

test("realized and excursion evidence are gated separately", () => {
  const r = buildResearchCommandCenterOnDb(db(), { nowMs: NOW });
  assert.ok("evidenceState" in r.currentEdge);
  assert.ok("excursionEvidenceState" in r.currentEdge,
    "the probabilities are gated more strictly than the realized figures and must say so");
});

// ── the frozen experiment, unchanged ─────────────────────────────────────────

test("OWNER_SELECTION_STRENGTH_GATE_V1 is reported frozen, shadow-only and insufficient", () => {
  const r = buildResearchCommandCenterOnDb(db(), { nowMs: NOW });
  const x = r.shadowExperiments.find((e) => e.experimentId === "OWNER_SELECTION_STRENGTH_GATE_V1");
  assert.ok(x, "the experiment must appear on the page");
  assert.equal(x.mode, "SHADOW_ONLY");
  assert.equal(x.definitionHash, "9b4f77b3c6268bf9e94781dc849ad2ef",
    "the recorded hash must not have moved");
  assert.equal(x.definitionFrozen, true);
  assert.equal(x.prospectiveStartDate, "2026-08-19", "the prospective start must not have moved");
  assert.equal(x.requiredClosedOutcomes, 20);
  assert.equal(x.requiredIndependentSessions, 5);
  assert.equal(x.status, "INSUFFICIENT_EVIDENCE");
  assert.equal(x.affectsLiveCallouts, false,
    "this is a field so the UI cannot render the arms without it");
});

test("both experiment arms are reported, and neither is presented as a live result", () => {
  const r = buildResearchCommandCenterOnDb(db(), { nowMs: NOW });
  const x = r.shadowExperiments[0];
  assert.ok("baseline" in x && "shadow" in x);
  assert.ok(x.limitations.length > 0, "a shadow arm without its limitations is a claim");
  assert.match(x.authority, /SHADOW|ADVISORY|not|never/i);
});

// ── risk research ────────────────────────────────────────────────────────────

test("no profit-protection policy is implied anywhere", () => {
  const r = buildResearchCommandCenterOnDb(db(), { nowMs: NOW });
  assert.equal(r.riskResearch.activeProfitProtectionPolicy, null);
  const pp = r.riskResearch.cards.find((c) => c.id === "PROFIT_PROTECTION");
  assert.ok(pp);
  assert.match(pp.detail, /No trailing stop/i);
  assert.equal(pp.supported, false);
  for (const c of r.riskResearch.cards) {
    assert.doesNotMatch(c.detail, /you should|we should|recommend/i,
      `risk card ${c.id} must observe, never advise`);
  }
});

test("the overnight card carries the outcome-selection caveat with its numbers", () => {
  const r = buildResearchCommandCenterOnDb(db(), { nowMs: NOW });
  const o = r.riskResearch.cards.find((c) => c.id === "OVERNIGHT_HOLDS");
  assert.match(o.detail, /OUTCOME-SELECTED/i,
    "the arms are not randomly assigned and the card cannot be read without knowing that");
  assert.equal(o.supported, false);
});

// ── V1's number never travels alone ──────────────────────────────────────────

test("the V1 headline is only ever shown with the reason it is not earliness", () => {
  const r = buildResearchCommandCenterOnDb(db(), { nowMs: NOW });
  assert.equal(r.earlyDiscoveryV1Caveat.stage, "PRE_TRIGGER");
  assert.match(r.earlyDiscoveryV1Caveat.whyUnusable, /1,?619 ms|1\.6/);
  assert.match(r.earlyDiscoveryV1Caveat.whyUnusable, /V2/);
});

// ── PHASE 3: one glossary, no duplicated wording ─────────────────────────────

test("every metric the page tooltips exists in the ONE glossary", () => {
  const src = readFileSync(new URL("../components/ResearchCommandCenter.tsx", import.meta.url), "utf8");
  const used = new Set();
  for (const m of src.matchAll(/metric=["']([A-Za-z0-9_]+)["']/g)) used.add(m[1]);
  for (const m of src.matchAll(/metric:\s*["']([A-Za-z0-9_]+)["']/g)) used.add(m[1]);
  // Only quoted literals. `metric={RISK_CARD_METRIC[c.id]}` is a dynamic lookup and its
  // VALUES are checked below instead — matching the identifier would assert that a
  // variable name is a glossary key.
  for (const m of src.matchAll(/RISK_CARD_METRIC: Record<string, string> = \{([^}]*)\}/g)) {
    for (const v of m[1].matchAll(/["']([A-Za-z0-9_]+)["']/g)) used.add(v[1]);
  }
  assert.ok(used.size >= 15, `expected the page to tooltip many metrics, saw ${used.size}`);
  for (const key of used) {
    assert.ok(METRIC_GLOSSARY[key], `metric "${key}" is tooltipped but is not in lib/metric-glossary.ts`);
  }
});

test("the component defines no metric wording of its own", () => {
  const src = readFileSync(new URL("../components/ResearchCommandCenter.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /METRIC_GLOSSARY\s*=/, "the glossary is imported, never redefined");
  assert.doesNotMatch(src, /what:\s*["']/, "a second copy of a definition is a definition that will drift");
});

test("every metric the brief requires a tooltip for exists", () => {
  const required = [
    "winRate", "expectancy", "profitFactor", "baselineProfitFactor", "shadowProfitFactor",
    "meanReturn", "medianReturn", "averageWinner", "averageLoser", "mfe", "mae",
    "probabilityTouch", "winnerRetention", "lossRejection", "profitFactorExBest",
    "tailDependence", "independentSessions", "sampleSize", "selectionStrength",
    "deliveryQuality", "rewardRemaining", "moveConsumed", "discoveryStage",
    "stopLeakage", "giveback", "exactOcc", "evidenceQuality",
  ];
  for (const k of required) {
    assert.ok(metricInfo(k), `required glossary entry "${k}" is missing`);
  }
});

// ── PHASE 4: Explain this ────────────────────────────────────────────────────

const CTX = {
  currentEdge: {
    population: "OWNER_VALIDATION_PAPER", sampleSize: 67, independentSessions: 7,
    dateRange: { from: "2026-08-06", to: "2026-08-19" },
    evidenceState: "SUPPORTED", excursionEvidenceState: "SUPPORTED",
    profitFactor: 0.6654, expectancyPct: -9.19, medianReturnPct: -40.29,
    winRate: 0.403, profitFactorExBest: 0.6226,
    probabilities: { "P(+10)": { rate: 0.6622, reached: 49, of: 74 } },
    limitations: ["in-sample"],
  },
  shadowExperiments: [{
    experimentId: "OWNER_SELECTION_STRENGTH_GATE_V1", experimentVersion: 1, mode: "SHADOW_ONLY",
    definitionHash: "9b4f77b3c6268bf9e94781dc849ad2ef", definitionFrozen: true,
    prospectiveStartDate: "2026-08-19",
    status: "INSUFFICIENT_EVIDENCE", statusReason: "0/20 outcomes",
    prospectiveClosedOutcomes: 0, requiredClosedOutcomes: 20,
    independentSessions: 0, requiredIndependentSessions: 5,
    baseline: { profitFactor: 0.7726, expectancyPct: -5.87, medianReturnPct: -30, winRate: 0.42, sampleSize: 54 },
    shadow: { profitFactor: 1.2183, expectancyPct: 4.64, medianReturnPct: -10, winRate: 0.5366, sampleSize: 41 },
    winnerRetention: 0.9565, lossRejection: 0.387, winnersRejected: 1,
    profitFactorExBest: 1.1279, tailRobustness: "survives removal of its best winner",
    limitations: ["in-sample", "may be acting as a direction filter"],
  }],
  ownerRows: [row({ opportunityCaseId: "oc_alfb24", preMoveCaseId: "oc_us70d7" })],
};

test("a metric is explained in the population it was clicked in", () => {
  const t = buildExplainTarget({ kind: "METRIC", id: "shadowProfitFactor" }, CTX);
  assert.equal(t.resolved, true);
  assert.ok(t.definition, "the glossary definition travels with the explanation");
  const labels = t.facts.map((f) => f.label);
  assert.ok(labels.includes("Baseline profit factor"), "shadow PF is meaningless without its baseline");
  assert.ok(labels.includes("Shadow profit factor"));
  assert.ok(labels.includes("Prospective closed outcomes"));
  assert.ok(labels.includes("Independent sessions"));
  assert.ok(labels.includes("Profit factor without the best winner"));
  assert.ok(labels.includes("Definition hash"));
  assert.ok(t.mustNotBeReadAs.some((m) => /SHADOW DOES NOT AFFECT LIVE CALLOUTS/.test(m)));
  assert.equal(t.hasLiveAuthority, false);
});

test("a metric explained while its experiment is short of evidence says so", () => {
  const t = buildExplainTarget({ kind: "METRIC", id: "shadowProfitFactor" }, CTX);
  assert.ok(
    t.mustNotBeReadAs.some((m) => /0\/20/.test(m) && /reading, not a finding/.test(m)),
    "an unsupported figure must carry its own shortfall",
  );
});

test("a trade is explained by CASE ID, and both identities resolve to one callout", () => {
  const byClaim = buildExplainTarget({ kind: "CASE", id: "oc_alfb24" }, CTX);
  const byPreMove = buildExplainTarget({ kind: "CASE", id: "oc_us70d7" }, CTX);
  assert.equal(byClaim.resolved, true);
  assert.equal(byPreMove.resolved, true);
  assert.equal(byClaim.title, byPreMove.title, "two identities, one callout");

  const labels = byClaim.facts.map((f) => f.label);
  for (const need of ["Exact OCC", "Entry", "Target 1", "Target 2", "Stop", "Realized return", "MFE (peak)", "Selection strength"]) {
    assert.ok(labels.includes(need), `a trade explanation must carry ${need}`);
  }
  assert.ok(
    byClaim.facts.find((f) => f.label === "MFE (peak)")?.note?.includes("NOT the result"),
    "the peak must be labelled as not the result wherever it is printed",
  );
});

test("a trade is NEVER resolved from ticker text", () => {
  for (const attempt of ["IWM", "IWM put", "O:IWM260819P00301000"]) {
    const t = buildExplainTarget({ kind: "CASE", id: attempt }, CTX);
    assert.equal(t.resolved, false, `"${attempt}" must not resolve to a callout`);
    assert.match(t.unresolvedReason, /case id/i);
  }
});

test("one trade is stated to be an anecdote", () => {
  const t = buildExplainTarget({ kind: "CASE", id: "oc_alfb24" }, CTX);
  assert.ok(t.mustNotBeReadAs.some((m) => /anecdote/i.test(m)));
  assert.ok(t.mustNotBeReadAs.some((m) => /not subscriber performance/i.test(m)));
});

test("an experiment explanation carries its floors, its costs and its lack of authority", () => {
  const t = buildExplainTarget({ kind: "EXPERIMENT", id: "OWNER_SELECTION_STRENGTH_GATE_V1" }, CTX);
  assert.equal(t.resolved, true);
  const labels = t.facts.map((f) => f.label);
  for (const need of [
    "Mode", "Status", "Definition hash", "Prospective start", "Prospective closed outcomes",
    "Independent sessions", "Baseline profit factor", "Shadow profit factor",
    "Winner retention", "Loss rejection", "Winners rejected",
    "Profit factor without the best winner", "Has live authority",
  ]) {
    assert.ok(labels.includes(need), `an experiment explanation must carry ${need}`);
  }
  assert.equal(t.facts.find((f) => f.label === "Has live authority")?.value, "NO");
  assert.ok(t.mustNotBeReadAs.some((m) => /READY_FOR_HUMAN_REVIEW/.test(m) && /not an approval/i.test(m)));
});

test("an unknown id is refused with a reason, never fuzzy-matched", () => {
  for (const [kind, id] of [["METRIC", "notAMetric"], ["EXPERIMENT", "NOPE_V9"], ["COHORT", "made_up"]]) {
    const t = buildExplainTarget({ kind, id }, CTX);
    assert.equal(t.resolved, false);
    assert.ok(t.unresolvedReason && t.unresolvedReason.length > 20, "a refusal must be diagnosable");
    assert.deepEqual(t.facts, [], "an unresolved target carries no facts to misread");
  }
});

test("the question put to the model never asks what to do", () => {
  for (const kind of ["METRIC", "EXPERIMENT", "COHORT"]) {
    const id = kind === "METRIC" ? "profitFactor" : kind === "EXPERIMENT" ? "OWNER_SELECTION_STRENGTH_GATE_V1" : "CURRENT_EDGE";
    const q = explainQuestionFor(buildExplainTarget({ kind, id }, CTX));
    assert.match(q, /Do not recommend/i, `${kind} question must forbid a recommendation`);
  }
});

test("explain facts enter the SAME evidence registry the validator checks against", () => {
  const target = buildExplainTarget({ kind: "EXPERIMENT", id: "OWNER_SELECTION_STRENGTH_GATE_V1" }, CTX);
  const packet = buildAdvisoryEvidencePacket(
    {
      reportId: "t", generatedAtMs: NOW, tradingDay: "2026-08-19", overallState: "OK",
      activeProductionPipeline: "INDEPENDENT_OPTIONS", metrics: [], dataGaps: [],
    },
    {
      exitPolicy: null, watchlist: null, ownerLane: null, preMove: null,
      explainTarget: {
        kind: target.kind, id: target.id, resolved: target.resolved, title: target.title,
        population: target.population, sampleSize: target.sampleSize,
        independentSessions: target.independentSessions, evidenceState: target.evidenceState,
        facts: target.facts, limitations: target.limitations,
        mustNotBeReadAs: target.mustNotBeReadAs,
      },
    },
  );
  const ids = packet.items.map((i) => i.id);
  assert.ok(ids.some((i) => i.startsWith("explain.experiment.")), "the facts must be citable");
  assert.ok(
    packet.mandatoryCaveats.some((c) => /SHADOW DOES NOT AFFECT LIVE CALLOUTS/.test(c)),
    "the target's own must-not-be-read-as list is restated to the model as an instruction",
  );
});

test("a single trade's figures are never marked safe for a top-line claim", () => {
  const target = buildExplainTarget({ kind: "CASE", id: "oc_alfb24" }, CTX);
  const packet = buildAdvisoryEvidencePacket(
    {
      reportId: "t", generatedAtMs: NOW, tradingDay: "2026-08-19", overallState: "OK",
      activeProductionPipeline: "INDEPENDENT_OPTIONS", metrics: [], dataGaps: [],
    },
    {
      exitPolicy: null, watchlist: null, ownerLane: null, preMove: null,
      explainTarget: {
        kind: target.kind, id: target.id, resolved: target.resolved, title: target.title,
        population: target.population, sampleSize: target.sampleSize,
        independentSessions: target.independentSessions, evidenceState: target.evidenceState,
        facts: target.facts, limitations: target.limitations,
        mustNotBeReadAs: target.mustNotBeReadAs,
      },
    },
  );
  const caseItems = packet.items.filter((i) => i.id.startsWith("explain.case."));
  assert.ok(caseItems.length > 0);
  for (const i of caseItems) {
    assert.equal(i.safeForTopLine, false,
      "one callout is an anecdote; a headline built from it is a statistic's clothes on an anecdote");
  }
});

// ── PHASE 9: readiness trajectory ────────────────────────────────────────────

test("readiness separates the five things, and none of them is subscriber approval", () => {
  const r = buildResearchCommandCenterOnDb(db(), { nowMs: NOW });
  const ids = r.readiness.buckets.map((b) => b.id);
  assert.deepEqual(ids, [
    "TRADING_EDGE", "DATA_INTEGRITY", "FORWARD_EVIDENCE",
    "OPERATIONAL_READINESS", "SUBSCRIBER_SETUP",
  ]);
  assert.equal(r.readiness.subscriberReady, false);
  assert.equal(r.readiness.humanApprovalRequired, true);
});

test("readiness cannot say ready because one shadow test looks promising", () => {
  const r = buildResearchCommandCenterOnDb(db(), { nowMs: NOW });
  const sub = r.readiness.buckets.find((b) => b.id === "SUBSCRIBER_SETUP");
  assert.ok(sub.blocking.length > 0, "subscriber setup always carries its blocker");
  assert.match(sub.blocking.join(" "), /human act taken elsewhere/i);
  assert.equal(r.readiness.subscriberReady, false);
  assert.match(r.readiness.note, /CHANGES NO READINESS RULE/);
});

test("every readiness bucket that is not clear says what blocks it", () => {
  const r = buildResearchCommandCenterOnDb(db(), { nowMs: NOW });
  for (const b of r.readiness.buckets) {
    for (const x of b.blocking) {
      assert.ok(x.length > 15, `"not ready" without a reason is a status nobody can act on: ${b.id}`);
    }
  }
});
