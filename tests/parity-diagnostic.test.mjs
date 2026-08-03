/**
 * Checkpoint 4 — row-keyed parity, delivery classification, eligible population.
 *
 * The failure guarded against: reading 85-vs-82 as parity when the two systems
 * evaluate different populations. Aggregate closeness is not agreement.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalKey, categorizeMismatch, compareKeyedParity,
  classifyDelivery, buildDeliveryCensus, buildEligiblePopulation,
  KEY_PRECEDENCE, PARITY_DIAGNOSTIC_VERSION,
} from "../lib/research/options/parity-diagnostic.ts";

const row = (over = {}) => ({
  key: "k", keyKind: "OPTIONS_ALERT_ID", optionsAlertId: "al_1",
  opportunityCaseId: "oc_1", paperPositionId: "1", occ: "O:SPY260807C00500000",
  sessionDate: "2026-08-03", quantLabStatus: "VERIFIED_GRADED",
  paperChainStatus: "VERIFIED_GRADED", quantLabReasons: [], paperChainReasons: [],
  matches: true, mismatchCategory: null, ...over,
});

// ── keying ─────────────────────────────────────────────────────────────────

test("key precedence is case > alert > paper > documented fallback", () => {
  assert.deepEqual([...KEY_PRECEDENCE],
    ["OPPORTUNITY_CASE_ID", "OPTIONS_ALERT_ID", "PAPER_POSITION_ID", "OCC_SESSION_FALLBACK"]);
  assert.equal(canonicalKey({ opportunityCaseId: "oc", optionsAlertId: "al", paperPositionId: 5 }).kind, "OPPORTUNITY_CASE_ID");
  assert.equal(canonicalKey({ optionsAlertId: "al", paperPositionId: 5 }).kind, "OPTIONS_ALERT_ID");
  assert.equal(canonicalKey({ paperPositionId: 5 }).kind, "PAPER_POSITION_ID");
});

test("the OCC+session fallback is flagged as a fallback, never silent", () => {
  const k = canonicalKey({ occ: "O:SPY260807C00500000", sessionDate: "2026-08-03" });
  assert.equal(k.kind, "OCC_SESSION_FALLBACK");
  assert.equal(k.usedFallback, true, "collidable keys must announce themselves");
});

test("an unkeyable row yields no key rather than a fabricated one", () => {
  const k = canonicalKey({});
  assert.equal(k.key, "");
  assert.equal(k.kind, null);
});

// ── parity ─────────────────────────────────────────────────────────────────

test("AGGREGATE CLOSENESS IS NOT PARITY — disjoint populations compare nothing", () => {
  // 85 rows verified on one side, 82 on the other, ZERO shared. The headline
  // gap of 3 would look like near-parity; it is not comparable at all.
  const rows = [
    ...Array.from({ length: 85 }, (_, i) => row({ key: `q${i}`, paperChainStatus: null })),
    ...Array.from({ length: 82 }, (_, i) => row({ key: `p${i}`, quantLabStatus: null })),
  ];
  const r = compareKeyedParity(rows);
  assert.equal(r.parityStatus, "NOT_COMPARABLE");
  assert.equal(r.sharedPopulationCount, 0);
  assert.equal(r.quantOnlyCount, 85);
  assert.equal(r.paperChainOnlyCount, 82);
  assert.equal(r.quantLabVerifiedCount, 85);
  assert.equal(r.paperChainVerifiedCount, 82, "counts are close and still prove nothing");
  assert.match(r.note, /must NOT be read as parity/);
});

test("full agreement over a shared population is ACHIEVED", () => {
  const r = compareKeyedParity([row({ key: "a" }), row({ key: "b", quantLabStatus: "DUPLICATE", paperChainStatus: "DUPLICATE" })]);
  assert.equal(r.parityStatus, "ACHIEVED");
  assert.equal(r.matchingCount, 2);
  assert.equal(r.matchPct, 100);
  assert.equal(r.disagreeOnVerified, 0);
});

test("verified in one system and excluded in the other is NOT_ACHIEVED", () => {
  const r = compareKeyedParity([row({ paperChainStatus: "UNVERIFIED_DELIVERY", matches: false })]);
  assert.equal(r.parityStatus, "NOT_ACHIEVED");
  assert.equal(r.disagreeOnVerified, 1);
  assert.equal(r.mismatchReasons[0].category, "DELIVERY_PROOF_MISMATCH");
  assert.match(r.note, /NOT achieved/);
});

test("differing exclusion reasons with neither verified is EXPLAINED_DIFFERENCE", () => {
  const r = compareKeyedParity([
    row({ quantLabStatus: "DUPLICATE", paperChainStatus: "MISSING_MIRROR", matches: false }),
  ]);
  assert.equal(r.parityStatus, "EXPLAINED_DIFFERENCE");
  assert.equal(r.disagreeOnVerified, 0);
});

test("mismatch categories name the AXIS of disagreement, not just 'status'", () => {
  assert.equal(categorizeMismatch("VERIFIED_GRADED", "UNVERIFIED_DELIVERY"), "DELIVERY_PROOF_MISMATCH");
  assert.equal(categorizeMismatch("VERIFIED_GRADED", "UNVERIFIED_ENTRY"), "ENTRY_PROOF_MISMATCH");
  assert.equal(categorizeMismatch("VERIFIED_GRADED", "UNVERIFIED_EXIT"), "EXIT_PROOF_MISMATCH");
  assert.equal(categorizeMismatch("VERIFIED_GRADED", "WRONG_OCC"), "OCC_MISMATCH");
  assert.equal(categorizeMismatch("VERIFIED_GRADED", "DUPLICATE"), "DUPLICATE_MISMATCH");
  assert.equal(categorizeMismatch("VERIFIED_GRADED", "MISSING_MIRROR"), "MIRROR_MISMATCH");
  assert.equal(categorizeMismatch("VERIFIED_GRADED", "AUDIT_ONLY"), "AUDIT_ONLY_MISMATCH");
  assert.equal(categorizeMismatch("VERIFIED_GRADED", "SESSION_INVALID"), "SESSION_MISMATCH");
  assert.equal(categorizeMismatch("UNGRADEABLE", "EXCLUDED_OTHER"), "STATUS_MISMATCH");
  assert.equal(categorizeMismatch("VERIFIED_GRADED", "VERIFIED_GRADED"), null);
});

test("population-only rows are visible and never counted as agreement", () => {
  const r = compareKeyedParity([
    row({ key: "shared" }),
    row({ key: "qonly", paperChainStatus: null }),
    row({ key: "ponly", quantLabStatus: null }),
  ]);
  assert.equal(r.sharedPopulationCount, 1, "only the shared row is compared");
  assert.equal(r.matchingCount, 1);
  assert.equal(r.quantOnlyCount, 1);
  assert.equal(r.paperChainOnlyCount, 1);
});

test("fallback keys are counted so a collidable comparison is visible", () => {
  const r = compareKeyedParity([row({ keyKind: "OCC_SESSION_FALLBACK" }), row({ key: "b" })]);
  assert.equal(r.fallbackKeyCount, 1);
  assert.equal(r.keyKinds.OCC_SESSION_FALLBACK, 1);
  assert.equal(r.version, PARITY_DIAGNOSTIC_VERSION);
});

test("mismatch samples carry keys so a row can actually be investigated", () => {
  const r = compareKeyedParity([row({ key: "abc", paperChainStatus: "UNVERIFIED_EXIT", matches: false })]);
  assert.deepEqual(r.mismatchReasons[0].sampleKeys, ["abc"]);
});

// ── §3 delivery classification ─────────────────────────────────────────────

test("research-only rows are NOT delivery failures", () => {
  const c = classifyDelivery({ alertRowPresent: true, alertState: "SENT", researchOnly: true, discordMessageIdPresent: false, opportunityCasePresent: true, paperLinkedFlag: true });
  assert.equal(c.deliveryClass, "RESEARCH_ONLY_EXPECTED");
  assert.equal(c.isProductionDefect, false);
  assert.equal(c.affectsOfficialEligibility, false);
});

test("a paper row with no alert is NOT a delivery failure — paper is not delivery", () => {
  const c = classifyDelivery({ alertRowPresent: false, alertState: null, researchOnly: false, discordMessageIdPresent: null, opportunityCasePresent: null, paperLinkedFlag: null });
  assert.equal(c.deliveryClass, "MISSING_ALERT_LINK");
  assert.equal(c.affectsOfficialEligibility, false);
});

test("legacy rows stay permanently unverifiable rather than being backfilled", () => {
  const c = classifyDelivery({ alertRowPresent: null, alertState: null, researchOnly: null, discordMessageIdPresent: null, opportunityCasePresent: null, paperLinkedFlag: null });
  assert.equal(c.deliveryClass, "LEGACY_DELIVERY_UNLINKABLE");
  assert.equal(c.permanentlyUnverifiable, true);
  assert.equal(c.safelyBackfillable, false);
});

test("an unsent alert is DELIVERY_NOT_ATTEMPTED, not a failure", () => {
  const c = classifyDelivery({ alertRowPresent: true, alertState: "PENDING", researchOnly: false, discordMessageIdPresent: false, opportunityCasePresent: true, paperLinkedFlag: true });
  assert.equal(c.deliveryClass, "DELIVERY_NOT_ATTEMPTED");
  assert.equal(c.isProductionDefect, false);
});

test("SENT without a message id is an instrumentation gap, not a failed send", () => {
  const c = classifyDelivery({ alertRowPresent: true, alertState: "SENT", researchOnly: false, discordMessageIdPresent: false, opportunityCasePresent: true, paperLinkedFlag: true });
  assert.equal(c.deliveryClass, "MISSING_MESSAGE_ID");
  assert.equal(c.isProductionDefect, true);
  assert.equal(c.safelyBackfillable, false, "a missing id cannot be invented");
});

test("an independent ledger proof outranks a missing message id", () => {
  const c = classifyDelivery({ alertRowPresent: true, alertState: "SENT", researchOnly: false, discordMessageIdPresent: false, opportunityCasePresent: true, paperLinkedFlag: true, deliveryLedgerProof: true });
  assert.equal(c.deliveryClass, "DELIVERY_PROVEN_ELSEWHERE");
  assert.equal(c.safelyBackfillable, true);
});

test("a duplicate-suppressed row was correctly never delivered", () => {
  const c = classifyDelivery({ alertRowPresent: true, alertState: "SENT", researchOnly: false, discordMessageIdPresent: true, opportunityCasePresent: true, paperLinkedFlag: true, duplicateSuppressed: true });
  assert.equal(c.deliveryClass, "DUPLICATE_SUPPRESSED");
  assert.equal(c.affectsOfficialEligibility, false);
});

test("the census does NOT report unproven rows as failed sends", () => {
  const census = buildDeliveryCensus([
    classifyDelivery({ alertRowPresent: true, alertState: "SENT", researchOnly: true, discordMessageIdPresent: false, opportunityCasePresent: true, paperLinkedFlag: true }),
    classifyDelivery({ alertRowPresent: false, alertState: null, researchOnly: false, discordMessageIdPresent: null, opportunityCasePresent: null, paperLinkedFlag: null }),
    classifyDelivery({ alertRowPresent: null, alertState: null, researchOnly: null, discordMessageIdPresent: null, opportunityCasePresent: null, paperLinkedFlag: null }),
  ]);
  assert.equal(census.total, 3);
  assert.equal(census.byClass.ACTUAL_DELIVERY_FAILURE ?? 0, 0, "none of these were failed sends");
  assert.match(census.note, /NOT failed sends/);
  assert.equal(census.permanentlyUnverifiable, 1);
});

// ── §10 eligible population ────────────────────────────────────────────────

test("verified fraction is measured against ELIGIBLE rows, not all history", () => {
  // 100 rows: 60 legacy, 20 research-only, 20 eligible of which 16 verified.
  const rows = [
    ...Array.from({ length: 60 }, () => ({ verified: false, permanentlyUnverifiable: true, researchOnly: false })),
    ...Array.from({ length: 20 }, () => ({ verified: false, permanentlyUnverifiable: false, researchOnly: true })),
    ...Array.from({ length: 16 }, () => ({ verified: true, permanentlyUnverifiable: false, researchOnly: false })),
    ...Array.from({ length: 4 }, () => ({ verified: false, permanentlyUnverifiable: false, researchOnly: false })),
  ];
  const e = buildEligiblePopulation(rows);
  assert.equal(e.totalRows, 100);
  assert.equal(e.permanentlyIneligibleLegacy, 60);
  assert.equal(e.researchOnly, 20);
  assert.equal(e.eligible, 20);
  assert.equal(e.verifiedEligible, 16);
  assert.equal(e.verifiedFractionOfEligible, 0.8, "80% of eligible, not 16% of all history");
});

test("an all-legacy population reports null rather than 0%", () => {
  const e = buildEligiblePopulation([{ verified: false, permanentlyUnverifiable: true, researchOnly: false }]);
  assert.equal(e.eligible, 0);
  assert.equal(e.verifiedFractionOfEligible, null);
});

// ── boundaries ─────────────────────────────────────────────────────────────

test("the parity module is pure — no DB, network, env, AI, or broker", async () => {
  const { readFileSync } = await import("node:fs");
  const raw = readFileSync("lib/research/options/parity-diagnostic.ts", "utf8");
  const code = raw.split("\n")
    .filter((l) => { const t = l.trimStart(); return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"); })
    .join("\n").toLowerCase();
  for (const banned of ["require(", "fetch(", "prepare(", "process.env", "openai", "anthropic", "broker", "webhook"]) {
    assert.equal(code.includes(banned), false, `${banned} must not appear`);
  }
});

test("the parity ROUTE makes zero provider calls and never writes", async () => {
  const { readFileSync } = await import("node:fs");
  const raw = readFileSync("app/api/research/options/parity/route.ts", "utf8");
  const code = raw.split("\n")
    .filter((l) => { const t = l.trimStart(); return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"); })
    .join("\n").toLowerCase();
  for (const banned of ["fetchoptionchain", "fetchoptioncontractsnapshot", "polyrequest", "polygon-provider"]) {
    assert.equal(code.includes(banned), false, `${banned} must not appear in a diagnostic`);
  }
  for (const write of ["insert into", "update options_", "delete from"]) {
    assert.equal(code.includes(write), false, `diagnostics must never write (${write})`);
  }
});
