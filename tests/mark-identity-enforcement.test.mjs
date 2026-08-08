/**
 * tests/mark-identity-enforcement.test.mjs
 *
 * The lowest safe boundary for the invariant
 *
 *     ONE PAPER/DELIVERED TRADE = ONE FROZEN OCC = ONE FROZEN ENTRY = ONE TRAJECTORY
 *
 * `applyOpportunityMarkOnDb` is where a price becomes this trade's trajectory: it
 * writes RETURN_MILESTONE rows, NEW_HIGH rows, `maxReturnPct`, `currentReturnPct`
 * and the Discord milestone claim. Before this guard it took no contract at all, so
 * any price handed to it was priced against the frozen entry — which is how a GOOGL
 * case accumulated a +185.4% "peak" out of marks on strikes it never bought.
 *
 * These tests pin FAIL-CLOSED behaviour. An absent OCC is refused exactly like a
 * mismatched one: a case observes many contracts on one underlying, so symbol-only
 * identity is not identity. And a refusal must write NOTHING — a guard that rejects
 * the return but still stamps a milestone has only moved the contamination.
 *
 * The fixture is built by the SAME migration production runs (`applyProductionSchemaOnDb`),
 * not a hand-copy, so it cannot drift into testing columns that do not exist.
 */
import "./helpers/register-alias.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  applyOpportunityMarkOnDb,
  claimOpportunityOpenOnDb,
  closeOpportunityOnDb,
  loadCaseJsonOnDb,
  markOpportunityOpenedDeliveredOnDb,
  markMatchesFrozenContract,
} from "../lib/opportunity-case/live.ts";
import { listMilestonesForCaseOnDb } from "../lib/opportunity-case/milestones.ts";

// Loaded through the alias hook because lib/db.ts imports its collaborators via `@/`.
const { applyProductionSchemaOnDb } = await import("@/lib/db");

const T = Date.UTC(2026, 7, 7, 15, 30, 0);
const FROZEN = "O:GOOGL260807P00357500";
/** A contract the loop legitimately re-selected later. Real, and not this trade. */
const RESELECTED = "O:GOOGL260819P00355000";

function openCase(d) {
  const claim = claimOpportunityOpenOnDb(d, {
    symbol: "GOOGL",
    side: "put",
    expiration: "2026-08-07",
    strike: 357.5,
    strategyKey: "lower_high_continuation",
    nowMs: T,
    frozenEntry: 2.33,
    optionSymbol: FROZEN,
    alertId: "oa_identity",
  });
  assert.equal(claim.claimed, true);
  markOpportunityOpenedDeliveredOnDb(d, {
    opportunityCaseId: claim.opportunityCaseId,
    alertId: "oa_identity",
    discordMessageId: "m1",
    frozenEntry: 2.33,
    nowMs: T,
  });
  return claim.opportunityCaseId;
}

function freshDb() {
  const d = new Database(":memory:");
  applyProductionSchemaOnDb(d);
  return d;
}

function trajectoryOf(d, caseId) {
  const s = loadCaseJsonOnDb(d, caseId)?.summary ?? {};
  return {
    currentMark: s.currentMark ?? null,
    currentReturnPct: s.currentReturnPct ?? null,
    maxReturnPct: s.maxReturnPct ?? null,
  };
}

test("a mark on the frozen contract is applied", () => {
  const d = freshDb();
  const caseId = openCase(d);
  const r = applyOpportunityMarkOnDb(d, {
    opportunityCaseId: caseId,
    frozenEntry: 2.33,
    currentMark: 3.43,
    returnPct: 47.2103,
    nowMs: T + 60_000,
    markOptionSymbol: FROZEN,
  });
  assert.equal(r.applied, true);
  assert.equal(r.rejectedReason, null);
  assert.equal(r.newHigh, true);
  assert.ok(Math.abs(trajectoryOf(d, caseId).maxReturnPct - 47.2103) < 1e-6);
});

test("case is insensitive but the symbol is not rewritten", () => {
  const d = freshDb();
  const caseId = openCase(d);
  const r = applyOpportunityMarkOnDb(d, {
    opportunityCaseId: caseId,
    frozenEntry: 2.33,
    currentMark: 3.43,
    returnPct: 47.2103,
    nowMs: T + 60_000,
    markOptionSymbol: `  ${FROZEN.toLowerCase()}  `,
  });
  assert.equal(r.applied, true, "whitespace/case normalisation is identity, not rewriting");
  assert.equal(markMatchesFrozenContract({ selectedContract: { optionSymbol: FROZEN } }, "O:GOOGL260807P00357501"), false);
});

test("a mark on a re-selected contract is refused and writes nothing", () => {
  const d = freshDb();
  const caseId = openCase(d);
  const before = trajectoryOf(d, caseId);
  const milestonesBefore = listMilestonesForCaseOnDb(d, caseId).length;

  const r = applyOpportunityMarkOnDb(d, {
    opportunityCaseId: caseId,
    frozenEntry: 2.33,
    // The exact shape of the bug: a longer-dated strike priced against this entry.
    currentMark: 6.65,
    returnPct: 185.4077,
    nowMs: T + 120_000,
    markOptionSymbol: RESELECTED,
  });

  assert.equal(r.applied, false);
  assert.equal(r.rejectedReason, "MARK_OCC_MISMATCH");
  assert.equal(r.summary, null);
  assert.equal(r.newHigh, false, "a refused mark is never a new high");
  assert.equal(r.claimed, false, "a refused mark never claims a Discord milestone");

  assert.deepEqual(trajectoryOf(d, caseId), before, "the trajectory is untouched");
  assert.equal(
    listMilestonesForCaseOnDb(d, caseId).length,
    milestonesBefore,
    "no RETURN_MILESTONE and no NEW_HIGH row was written",
  );
});

test("an unattributed mark is refused — symbol-only identity is not identity", () => {
  const d = freshDb();
  const caseId = openCase(d);
  const before = trajectoryOf(d, caseId);

  for (const occ of [undefined, null, "", "   "]) {
    const r = applyOpportunityMarkOnDb(d, {
      opportunityCaseId: caseId,
      frozenEntry: 2.33,
      currentMark: 6.65,
      returnPct: 185.4077,
      nowMs: T + 120_000,
      markOptionSymbol: occ,
    });
    assert.equal(r.applied, false, `an OCC of ${JSON.stringify(occ)} must fail closed`);
    assert.equal(r.rejectedReason, "MARK_OCC_MISSING");
  }
  assert.deepEqual(trajectoryOf(d, caseId), before);
});

test("a case with no frozen OCC cannot accept any mark", () => {
  const d = freshDb();
  const caseId = openCase(d);
  const oc = loadCaseJsonOnDb(d, caseId);
  delete oc.selectedContract.optionSymbol;
  d.prepare("UPDATE opportunity_cases SET case_json=? WHERE opportunity_id=?")
    .run(JSON.stringify(oc), caseId);

  const r = applyOpportunityMarkOnDb(d, {
    opportunityCaseId: caseId,
    frozenEntry: 2.33,
    currentMark: 3.43,
    returnPct: 47.2103,
    nowMs: T + 60_000,
    markOptionSymbol: FROZEN,
  });
  assert.equal(r.applied, false);
  assert.equal(r.rejectedReason, "FROZEN_OCC_MISSING");
});

test("a missing case is refused rather than treated as a fresh trade", () => {
  const d = freshDb();
  const r = applyOpportunityMarkOnDb(d, {
    opportunityCaseId: "oc_does_not_exist",
    frozenEntry: 2.33,
    currentMark: 3.43,
    returnPct: 47.2103,
    nowMs: T,
    markOptionSymbol: FROZEN,
  });
  assert.equal(r.applied, false);
  assert.equal(r.rejectedReason, "CASE_NOT_FOUND");
});

test("alternate-contract marks cannot ratchet the peak, however many arrive", () => {
  const d = freshDb();
  const caseId = openCase(d);

  applyOpportunityMarkOnDb(d, {
    opportunityCaseId: caseId,
    frozenEntry: 2.33, currentMark: 3.43, returnPct: 47.2103,
    nowMs: T + 60_000, markOptionSymbol: FROZEN,
  });
  // The re-selection storm that produced the false +185.4%.
  for (let i = 0; i < 25; i += 1) {
    applyOpportunityMarkOnDb(d, {
      opportunityCaseId: caseId,
      frozenEntry: 2.33,
      currentMark: 4 + i * 0.2,
      returnPct: 80 + i * 5,
      nowMs: T + 120_000 + i * 1000,
      markOptionSymbol: i % 2 === 0 ? RESELECTED : "O:GOOGL260812P00357500",
    });
  }

  const t = trajectoryOf(d, caseId);
  assert.ok(
    Math.abs(t.maxReturnPct - 47.2103) < 1e-6,
    `peak must stay at what the frozen contract printed, got ${t.maxReturnPct}`,
  );
});

test("a close on a foreign contract still closes the case but drops the numbers", () => {
  const d = freshDb();
  const caseId = openCase(d);
  applyOpportunityMarkOnDb(d, {
    opportunityCaseId: caseId,
    frozenEntry: 2.33, currentMark: 3.43, returnPct: 47.2103,
    nowMs: T + 60_000, markOptionSymbol: FROZEN,
  });

  closeOpportunityOnDb(d, {
    opportunityCaseId: caseId,
    nowMs: T + 300_000,
    exitReason: "target",
    returnPct: 185.4077,
    currentMark: 6.65,
    exitOptionSymbol: RESELECTED,
  });

  const oc = loadCaseJsonOnDb(d, caseId);
  assert.equal(oc.summary.currentStatus, "CLOSED", "the position really did exit");
  assert.notEqual(
    oc.summary.currentReturnPct,
    185.4077,
    "a foreign exit price is not this trade's realized return",
  );
  const exitMilestone = listMilestonesForCaseOnDb(d, caseId).find((m) => m.eventType === "EXIT_HIT");
  assert.ok(exitMilestone);
  assert.equal(exitMilestone.returnPercent, null, "the exit row carries no unattributable number");
});

test("a close on the frozen contract keeps its numbers", () => {
  const d = freshDb();
  const caseId = openCase(d);
  closeOpportunityOnDb(d, {
    opportunityCaseId: caseId,
    nowMs: T + 300_000,
    exitReason: "target",
    returnPct: 47.2103,
    currentMark: 3.43,
    exitOptionSymbol: FROZEN,
  });
  const oc = loadCaseJsonOnDb(d, caseId);
  assert.equal(oc.summary.currentStatus, "CLOSED");
  assert.ok(Math.abs(oc.summary.currentReturnPct - 47.2103) < 1e-6);
});
