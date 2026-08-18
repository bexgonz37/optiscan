/**
 * tests/owner-mirror-identity.test.mjs
 *
 * THE OWNER CALLOUT HAS NO ALERT ID, AND FIVE LEARNING CONSUMERS ASSUMED IT DID.
 *
 * An owner callout never writes an `options_alerts` row: `sendOwnerPrivateOpening` claims
 * an Opportunity Case, sends the Discord opening, and mirrors the trade into
 * `options_paper_trades` as `OWNER_VALIDATION_PAPER`. Production at 801b7d0d: 0 of 106
 * owner cases and 0 of 74 owner mirrors carry an alert id.
 *
 * Every consumer that joined owner evidence through `alert_id` therefore returned the
 * EMPTY SET rather than an error, and an empty set reads exactly like "the owner made no
 * trades". Nightly research received openings 0, closed 0, wins 0, losses 0, PF null with
 * dozens of exact-OCC tracked trades sitting behind it.
 *
 * Every fixture here is built the way production builds one — no alert id anywhere — so a
 * regression cannot pass by handing the code the subscriber lane's shape.
 *
 * Fixture is the SAME migration production runs, not a hand-copy.
 */
import "./helpers/register-alias.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";

import {
  resolveOwnerMirrorOnDb,
  loadOwnerMirrorPopulationOnDb,
  ownerMirrorTradeIdsForCaseOnDb,
  preMoveCaseIdForFingerprint,
  OWNER_VALIDATION_PAPER_KIND,
} from "../lib/opportunity-case/owner-mirror-identity.ts";
import {
  buildOwnerLearningReportOnDb,
  censusOwnerIdentityOnDb,
  buildDeliveredLaneContrastOnDb,
} from "../lib/research/options/owner-learning.ts";
import { buildOwnerAlertSummaryOnDb } from "../lib/research/options/nightly-research.ts";
import { buildPreMoveNightlyReport } from "../lib/research/options/pre-move-nightly.ts";
import { recordPreMoveObservationOnDb, recordPreMoveAlertOnDb } from "../lib/research/options/pre-move-store.ts";
import { recomputeExcursionOnDb } from "../lib/opportunity-case/excursion.ts";
import {
  loadCohortMembersOnDb, selectCohort, computeCohortStatistics,
  MIN_SESSIONS_FOR_PROBABILITY,
} from "../lib/research/options/cohort-probability.ts";
import { buildAiResearchContextOnDb } from "../lib/research/options/ai-research-context.ts";
import { deterministicOpportunityId } from "../lib/opportunity-case/schema.ts";
import { tradingDay } from "../lib/trading-session.ts";

const { applyProductionSchemaOnDb } = await import("@/lib/db");

const MIN = 60_000;
/** 10:00 ET on a Monday. Every timestamp below is derived from it. */
const T0 = Date.parse("2026-08-17T14:00:00.000Z");
const SESSION = "2026-08-17";

function db() {
  const d = new Database(":memory:");
  applyProductionSchemaOnDb(d);
  return d;
}

let seq = 0;

/**
 * One owner callout, exactly as production writes it.
 *
 * Two Opportunity Case rows, because that is what really happens: the scanner writes a
 * PENDING audit case (which owns the PRE_MOVE observation) and the delivery mints a CLAIM
 * case (which owns the mirror). They share an opportunity fingerprint and nothing else.
 */
function seedOwnerCallout(d, {
  symbol = "IWM",
  occ = "O:IWM260819P00301000",
  side = "put",
  strategy = "lower_high_continuation",
  enteredAtMs = T0,
  exitAtMs = T0 + 90 * MIN,
  status = "EXITED",
  entryFill = 1.0,
  returnPct = 44.42,
  exitFill = null,
  targetT1 = 1.4,
  targetT2 = 1.8,
  stop = 0.7,
  quality = 1,
  marks = [],
  caseOcc = null,
  withPreMove = true,
  preMoveOnClaimCase = false,
  exitReason = "target",
} = {}) {
  seq += 1;
  const fingerprint = `of_test_${seq}`;
  const claimCaseId = `oc_claim_${seq}`;
  const pendingCaseId = deterministicOpportunityId([fingerprint, "pending"]);
  const frozenOcc = caseOcc ?? occ;

  const sessionDate = tradingDay(enteredAtMs);
  const caseJson = (id) => JSON.stringify({
    underlyingSymbol: symbol,
    opportunityFingerprint: fingerprint,
    thesisFingerprint: `ot_test_${seq}`,
    sessionDate,
    setupFamily: strategy,
    // ~27 evaluations per case in production, one per strategy considered. The first entry
    // is deliberately NOT the traded one, so a resolver that reads [0] fails here.
    strategyEvaluations: [
      { strategyId: "vwap_rejection", strategyVersion: "1", strength: 42, signal: "NEUTRAL", evidence: [], contradictingEvidence: [{}, {}] },
      { strategyId: strategy, strategyVersion: "1", strength: 100, signal: "SUPPORTIVE", evidence: [{}], contradictingEvidence: [] },
    ],
    selectedContract: { optionSymbol: frozenOcc, side, strike: 301, expiration: "2026-08-19", dte: 2 },
    frozenTrade: { entryMid: entryFill, targetT1, targetT2, stop },
    caseRole: id === claimCaseId ? "claim" : "pending_audit",
  });

  const insertCase = d.prepare(
    `INSERT INTO opportunity_cases (opportunity_id, underlying_symbol, direction, setup_family,
       detected_at_ms, market_session, source_path, acceptance_decision, delivery_decision,
       alert_id, case_json, session_date, created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,'regular','options_live','accepted','delivered',NULL,?,?,?,?)`,
  );
  insertCase.run(claimCaseId, symbol, side === "put" ? "bearish" : "bullish", strategy,
    enteredAtMs, caseJson(claimCaseId), sessionDate, enteredAtMs, enteredAtMs);
  insertCase.run(pendingCaseId, symbol, side === "put" ? "bearish" : "bullish", strategy,
    enteredAtMs - 10 * MIN, caseJson(pendingCaseId), sessionDate, enteredAtMs - 10 * MIN, enteredAtMs);

  const resolvedExitFill = exitFill ?? (
    status === "EXITED" && returnPct != null ? +(entryFill * (1 + returnPct / 100)).toFixed(4) : null
  );

  const info = d.prepare(
    `INSERT INTO options_paper_trades (option_symbol, result_class, side, strike, expiration, dte,
       entry_fill, exit_fill, strategy, status, return_pct, exit_reason, entered_at_ms, exit_at_ms,
       session, feature_snapshot_json, alert_id, paper_kind, created_at_ms, updated_at_ms)
     VALUES (?, 'REAL_OPTION_PAPER', ?, 301, '2026-08-19', 2, ?, ?, ?, ?, ?, ?, ?, ?, 'regular', ?, NULL, ?, ?, ?)`,
  ).run(
    occ, side, entryFill, resolvedExitFill, strategy, status, returnPct,
    status === "EXITED" ? exitReason : null, enteredAtMs, status === "EXITED" ? exitAtMs : null,
    JSON.stringify({ lane: "OWNER_ONLY", opportunityCaseId: claimCaseId, quality, thesisFingerprint: `ot_test_${seq}` }),
    OWNER_VALIDATION_PAPER_KIND, enteredAtMs, enteredAtMs,
  );
  const tradeId = Number(info.lastInsertRowid);

  const addMark = d.prepare(
    `INSERT INTO options_paper_marks (trade_id, option_symbol, mark_at_ms, return_pct, exit_fill, created_at_ms)
     VALUES (?,?,?,?,?,?)`,
  );
  for (const [ret, atMs, markOcc] of marks) {
    addMark.run(tradeId, markOcc ?? occ, atMs, ret, +(entryFill * (1 + ret / 100)).toFixed(4), atMs);
  }

  if (withPreMove) {
    const preMoveCase = preMoveOnClaimCase ? claimCaseId : pendingCaseId;
    recordPreMoveObservationOnDb(d, {
      opportunityCaseId: preMoveCase, sessionDate, symbol, direction: side === "put" ? "bearish" : "bullish",
      side: side === "put" ? "PUT" : "CALL", optionSymbol: occ, strategyKey: strategy,
      deploymentSha: "sha", lane: "SHADOW", nowMs: enteredAtMs - 10 * MIN, eligible: true,
      underlyingPrice: 302, optionAsk: entryFill, triggerLevel: 301.5, triggerTaken: true,
      sessionHigh: 304, sessionLow: 300, dte: 2, delta: -0.42, spreadPct: 3.1,
      openInterest: 8100, contractVolume: 2400,
    });
  }

  return { tradeId, claimCaseId, pendingCaseId, fingerprint, occ, frozenOcc };
}

/** A dense same-contract mark series that rises to `peak` and settles at `end`. */
function ramp(startMs, peak, end, n = 12) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const half = Math.floor(n / 2);
    const v = i <= half ? (peak * i) / half : peak + ((end - peak) * (i - half)) / (n - 1 - half);
    out.push([+v.toFixed(4), startMs + i * 5 * MIN]);
  }
  return out;
}

// ── identity ────────────────────────────────────────────────────────────────

test("an owner case with NO alert_id still resolves its mirror, through the opportunity case", () => {
  const d = db();
  const seeded = seedOwnerCallout(d, { marks: ramp(T0, 50, 44.42) });

  assert.equal(
    d.prepare("SELECT alert_id FROM opportunity_cases WHERE opportunity_id=?").get(seeded.claimCaseId).alert_id,
    null, "the fixture must reproduce production: an owner case has no alert id",
  );
  assert.equal(
    d.prepare("SELECT alert_id FROM options_paper_trades WHERE id=?").get(seeded.tradeId).alert_id,
    null, "and neither does its mirror",
  );

  const r = resolveOwnerMirrorOnDb(d, seeded.claimCaseId);
  assert.equal(r.state, "RESOLVED");
  assert.equal(r.mirror.paperTradeId, seeded.tradeId);
  assert.equal(r.mirror.optionSymbol, seeded.occ);
  assert.equal(r.mirror.occExact, true);
  assert.equal(r.mirror.realizedEvidence, "VERIFIED");
  assert.equal(r.mirror.realizedReturnPct, 44.42);
  assert.equal(r.mirror.targetT1, 1.4, "the frozen targets come from the case, not the mirror");
  assert.equal(r.mirror.stop, 0.7);
  d.close();
});

test("the pending audit case id is derived from the fingerprint, and resolves the same trade", () => {
  const d = db();
  const seeded = seedOwnerCallout(d, { marks: ramp(T0, 30, 12) });

  assert.equal(
    preMoveCaseIdForFingerprint(seeded.fingerprint), seeded.pendingCaseId,
    "the pending id is a pure function of the fingerprint — never a lookup, never a guess",
  );
  const population = loadOwnerMirrorPopulationOnDb(d, {});
  assert.equal(population.byCaseId.get(seeded.claimCaseId).paperTradeId, seeded.tradeId);
  assert.equal(
    population.byCaseId.get(seeded.pendingCaseId).paperTradeId, seeded.tradeId,
    "both identities of one callout resolve to one trade",
  );
  assert.equal(preMoveCaseIdForFingerprint(null), null);
  assert.equal(preMoveCaseIdForFingerprint(""), null);
  d.close();
});

test("a mirror on a contract the callout did not freeze fails closed", () => {
  const d = db();
  const seeded = seedOwnerCallout(d, {
    occ: "O:IWM260819P00300000",
    caseOcc: "O:IWM260819P00301000",
    marks: ramp(T0, 80, 60),
  });

  const r = resolveOwnerMirrorOnDb(d, seeded.claimCaseId);
  assert.equal(r.state, "OCC_MISMATCH");
  assert.equal(r.mirror, null, "a wrong-contract mirror is never handed back as the callout's evidence");
  assert.equal(r.candidates.length, 1, "it is still reported, so the gap is visible rather than silent");
  assert.equal(r.candidates[0].occExact, false);
  assert.equal(r.candidates[0].realizedEvidence, "UNAVAILABLE", "a different strike's return is not this callout's return");
  d.close();
});

test("two mirrors claiming one case is AMBIGUOUS, and no mirror is chosen", () => {
  const d = db();
  const seeded = seedOwnerCallout(d, { marks: ramp(T0, 30, 20) });
  // A second mirror naming the same case — the shape a retry or a double-open would leave.
  d.prepare(
    `INSERT INTO options_paper_trades (option_symbol, result_class, side, strike, expiration, dte,
       entry_fill, exit_fill, strategy, status, return_pct, entered_at_ms, exit_at_ms,
       feature_snapshot_json, alert_id, paper_kind, created_at_ms, updated_at_ms)
     VALUES (?, 'REAL_OPTION_PAPER','put',301,'2026-08-19',2,1.0,1.9,'lower_high_continuation','EXITED',90,?,?,?,NULL,?,?,?)`,
  ).run(
    seeded.occ, T0, T0 + 30 * MIN,
    JSON.stringify({ lane: "OWNER_ONLY", opportunityCaseId: seeded.claimCaseId, quality: 1 }),
    OWNER_VALIDATION_PAPER_KIND, T0, T0,
  );

  const r = resolveOwnerMirrorOnDb(d, seeded.claimCaseId);
  assert.equal(r.state, "AMBIGUOUS");
  assert.equal(r.mirror, null, "a coin flip between two returns is not identity");
  assert.equal(r.candidates.length, 2);

  const population = loadOwnerMirrorPopulationOnDb(d, {});
  assert.equal(population.ambiguousCaseIds.includes(seeded.claimCaseId), true);
  assert.equal(
    population.byCaseId.has(seeded.claimCaseId), false,
    "an ambiguous case resolves to nothing rather than to whichever row sorted first",
  );
  assert.equal(population.mirrors.length, 2, "both are still real trades and stay in the lane population");
  d.close();
});

test("a case id is matched exactly, never as a substring or a LIKE wildcard", () => {
  const d = db();
  const seeded = seedOwnerCallout(d, { marks: ramp(T0, 20, 10) });
  const longer = `${seeded.claimCaseId}9`;
  d.prepare(
    `INSERT INTO opportunity_cases (opportunity_id, underlying_symbol, detected_at_ms, source_path,
       acceptance_decision, delivery_decision, alert_id, case_json, created_at_ms, updated_at_ms)
     VALUES (?,?,?,'options_live','accepted','delivered',NULL,?,?,?)`,
  ).run(longer, "IWM", T0, JSON.stringify({
    opportunityFingerprint: "of_other",
    selectedContract: { optionSymbol: seeded.occ, side: "put" },
  }), T0, T0);

  assert.deepEqual(
    ownerMirrorTradeIdsForCaseOnDb(d, longer), [],
    "a longer id must not inherit the shorter id's mirror",
  );
  assert.deepEqual(ownerMirrorTradeIdsForCaseOnDb(d, seeded.claimCaseId), [seeded.tradeId]);
  // `_` is a LIKE wildcard and every case id has one at position three.
  const wildcarded = seeded.claimCaseId.replace("oc_", "ocX");
  assert.deepEqual(ownerMirrorTradeIdsForCaseOnDb(d, wildcarded), []);
  d.close();
});

test("the identity census reports both links side by side", () => {
  const d = db();
  seedOwnerCallout(d, { marks: ramp(T0, 40, 30) });
  const census = censusOwnerIdentityOnDb(d, {});
  assert.equal(census.mirrors, 1);
  assert.equal(census.mirrorsWithAlertId, 0);
  assert.equal(census.casesWithAlertId, 0);
  assert.equal(census.mirrorsWithCaseIdentity, 1);
  assert.equal(census.casesWithPendingAuditCase, 1, "the derived pending audit case really exists");
  assert.equal(census.verdict, "ALERT_ID_IDENTITY_UNAVAILABLE");
  d.close();
});

// ── lane separation ─────────────────────────────────────────────────────────

test("the owner and subscriber populations stay disjoint", () => {
  const d = db();
  seedOwnerCallout(d, { marks: ramp(T0, 50, 44.42) });
  // A subscriber mirror on the SAME contract and session. Different lane, different
  // audience, and it must never enter an owner figure.
  d.prepare(
    `INSERT INTO options_paper_trades (option_symbol, result_class, side, strike, expiration, dte,
       entry_fill, exit_fill, strategy, status, return_pct, entered_at_ms, exit_at_ms,
       feature_snapshot_json, alert_id, paper_kind, created_at_ms, updated_at_ms)
     VALUES ('O:IWM260819P00301000','REAL_OPTION_PAPER','put',301,'2026-08-19',2,1.0,0.2,
             'lower_high_continuation','EXITED',-80,?,?,'{}','oa_sub_1','DELIVERED_ALERT_PAPER',?,?)`,
  ).run(T0, T0 + 60 * MIN, T0, T0);

  const owner = buildOwnerLearningReportOnDb(d, { sessionDate: SESSION });
  assert.equal(owner.statistics.lane, OWNER_VALIDATION_PAPER_KIND);
  assert.equal(owner.statistics.openings, 1, "the subscriber mirror is not an owner opening");
  assert.equal(owner.statistics.wins, 1);
  assert.equal(owner.statistics.losses, 0, "the subscriber loss never reaches the owner lane");

  const contrast = buildDeliveredLaneContrastOnDb(d, SESSION);
  assert.equal(contrast.lane, "DELIVERED_ALERT_PAPER");
  assert.equal(contrast.openings, 1);
  assert.equal(contrast.mirrorsByAlertId, 1, "the subscriber lane's alert-id link is untouched and still works");
  assert.equal(contrast.losses, 1);
  d.close();
});

// ── the owner summary ───────────────────────────────────────────────────────

test("the owner summary reports OWNER_VALIDATION_PAPER, with CALL/PUT and strategy attribution", () => {
  const d = db();
  seedOwnerCallout(d, { side: "put", returnPct: 44.42, marks: ramp(T0, 50, 44.42) });
  seedOwnerCallout(d, {
    symbol: "NVDA", occ: "O:NVDA260821C00180000", side: "call", strategy: "breakout_forming",
    returnPct: -30, exitReason: "stop", marks: ramp(T0, 8, -30),
  });

  const o = buildOwnerAlertSummaryOnDb(d, SESSION);
  assert.equal(o.lane, OWNER_VALIDATION_PAPER_KIND);
  assert.equal(o.openings, 2);
  assert.equal(o.paperMirrors, 2);
  assert.equal(o.mirrorRate, 1, "a mirror is an exact-contract match, not `alert_id IS NOT NULL`");
  assert.equal(o.closed, 2);
  assert.equal(o.realizedWins, 1);
  assert.equal(o.realizedLosses, 1);
  assert.equal(o.callCount, 1);
  assert.equal(o.putCount, 1);
  assert.equal(o.bestWinnerPct, 44.42);
  assert.equal(o.worstLossPct, -30);
  assert.equal(o.profitFactor, +(44.42 / 30).toFixed(4));
  assert.equal(o.byStrategy.length, 2);
  assert.equal(o.byStrategy.find((b) => b.strategy === "lower_high_continuation").wins, 1);
  assert.equal(o.byStrategy.find((b) => b.strategy === "breakout_forming").losses, 1);
  d.close();
});

test("an owner opening's session date comes from its own entry, in Eastern time", () => {
  const d = db();
  // 20:30 ET on the 17th is 00:30 UTC on the 18th. A UTC split misfiles it by a day.
  seedOwnerCallout(d, {
    enteredAtMs: Date.parse("2026-08-18T00:30:00.000Z"),
    exitAtMs: Date.parse("2026-08-18T00:45:00.000Z"),
    marks: ramp(Date.parse("2026-08-18T00:30:00.000Z"), 20, 11),
  });
  assert.equal(buildOwnerAlertSummaryOnDb(d, "2026-08-17").openings, 1);
  assert.equal(buildOwnerAlertSummaryOnDb(d, "2026-08-18").openings, 0);
  d.close();
});

test("independent sessions are counted against the trading calendar, not the date strings", () => {
  const d = db();
  const day = (iso) => Date.parse(`${iso}T14:00:00.000Z`);
  // Two trades on ONE Monday, one on Tuesday, and one on a SATURDAY that must not count.
  for (const at of [day("2026-08-17"), day("2026-08-17"), day("2026-08-18"), day("2026-08-22")]) {
    seedOwnerCallout(d, { enteredAtMs: at, exitAtMs: at + 30 * MIN, marks: ramp(at, 20, 11) });
  }
  const s = buildOwnerLearningReportOnDb(d, {}).statistics;
  assert.equal(s.closed, 4);
  assert.equal(s.sessionAudit.distinctDatesSeen, 3);
  assert.equal(s.sessionAudit.independentSessions, 2, "two trades on one date are one session; a Saturday is none");
  assert.deepEqual(s.sessions, ["2026-08-17", "2026-08-18"]);
  assert.equal(s.sessionAudit.rejected[0].reason, "WEEKEND");
  assert.ok(s.limitations.some((l) => l.includes("NOT trading sessions")), "the rejection is reported, not dropped");
  d.close();
});

// ── excursion ───────────────────────────────────────────────────────────────

test("an owner case resolves exact-OCC marks with no alert id, and no contaminated fallback", () => {
  const d = db();
  const seeded = seedOwnerCallout(d, {
    marks: [
      ...ramp(T0, 50, 44.42),
      // A mark on a re-selected strike. It is the highest number in the table and must
      // never enter this contract's excursion.
      [900, T0 + 61 * MIN, "O:IWM260901P00300000"],
    ],
  });
  // The case claims a peak nothing on the frozen contract ever printed.
  const caseJson = JSON.parse(d.prepare("SELECT case_json FROM opportunity_cases WHERE opportunity_id=?").get(seeded.claimCaseId).case_json);
  caseJson.summary = { maxReturnPct: 900 };
  d.prepare("UPDATE opportunity_cases SET case_json=? WHERE opportunity_id=?").run(JSON.stringify(caseJson), seeded.claimCaseId);

  const e = recomputeExcursionOnDb(d, seeded.claimCaseId);
  assert.notEqual(e.state, "NO_MIRROR", "the owner mirror is found without an alert id");
  assert.equal(e.state, "UNSUPPORTED_MAX_RETURN");
  assert.equal(e.storedValueIsWrong, true);
  assert.equal(e.canonicalMfePct, 50, "the peak is the best SAME-CONTRACT mark, never the stored claim");
  assert.equal(e.marksOffFrozen, 1);
  assert.notEqual(e.canonicalMfePct, 900);
  d.close();
});

// ── PRE_MOVE ────────────────────────────────────────────────────────────────

test("PRE_MOVE owner evidence attaches to its real owner outcome", () => {
  const d = db();
  const seeded = seedOwnerCallout(d, { marks: ramp(T0, 50, 44.42) });

  // Production shape: the observation is filed under the PENDING audit case, and no send
  // instant was ever recorded because the promotion was keyed on the claim case.
  assert.equal(
    d.prepare("SELECT COUNT(*) n FROM opportunity_pre_move_discovery WHERE opportunity_case_id=?")
      .get(seeded.pendingCaseId).n, 1,
  );
  assert.equal(
    d.prepare("SELECT COUNT(*) n FROM opportunity_pre_move_discovery WHERE owner_notified_at_ms IS NOT NULL").get().n,
    0, "no historical row has a recorded notification instant, and none is invented",
  );

  const owner = buildPreMoveNightlyReport(d, {}).lanes.find((l) => l.lane === "OWNER");
  assert.equal(owner.gradedAlerts, 1, "the owner lane is resolved from the mirror, not the `lane` column");
  const row = owner.rows[0];
  assert.equal(row.opportunityCaseId, seeded.pendingCaseId);
  assert.equal(row.ownerCaseId, seeded.claimCaseId, "the row names both identities of the callout");
  assert.equal(row.paperTradeId, seeded.tradeId);
  assert.equal(row.realizedEvidence, "VERIFIED");
  assert.equal(row.realizedReturnPct, 44.42);
  assert.equal(row.ownerAlertInstantProvenance, "DERIVED_FROM_MIRROR_ENTRY");
  assert.equal(row.ownerNotifiedAtMs, T0, "derived from the mirror's own entry, and labelled as derived");
  assert.equal(owner.alertInstantsDerived, 1);
  d.close();
});

test("a recorded notification instant is preferred over the derived one, and is not double counted", () => {
  const d = db();
  const seeded = seedOwnerCallout(d, { marks: ramp(T0, 50, 44.42) });
  // The repaired write path: the promotion tries the PENDING case first.
  const promoted = recordPreMoveAlertOnDb(d, {
    opportunityCaseId: seeded.claimCaseId,
    preMoveCaseId: preMoveCaseIdForFingerprint(seeded.fingerprint),
    ownerNotifiedAtMs: T0 - 2 * MIN,
    underlyingAtAlert: 302, optionAtAlert: 1.02, lane: "OWNER",
  });
  assert.equal(promoted, true, "keyed on the claim case alone this update matched zero rows");
  assert.equal(
    d.prepare("SELECT lane FROM opportunity_pre_move_discovery WHERE opportunity_case_id=?")
      .get(seeded.pendingCaseId).lane, "OWNER",
  );

  const r = buildPreMoveNightlyReport(d, {});
  const owner = r.lanes.find((l) => l.lane === "OWNER");
  assert.equal(owner.gradedAlerts, 1);
  assert.equal(owner.rows[0].ownerAlertInstantProvenance, "RECORDED");
  assert.equal(owner.rows[0].ownerNotifiedAtMs, T0 - 2 * MIN);
  assert.equal(
    r.lanes.find((l) => l.lane === "SHADOW").gradedAlerts, 0,
    "a promoted row belongs to one lane, never two",
  );
  d.close();
});

// ── cohort / probability floors ─────────────────────────────────────────────

test("owner trades reach the cohort engine with a real session date, and the floors still hold", () => {
  const d = db();
  const day = (iso) => Date.parse(`${iso}T14:00:00.000Z`);
  const days = ["2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21"];
  for (let i = 0; i < 25; i += 1) {
    const at = day(days[i % days.length]) + i * MIN;
    seedOwnerCallout(d, {
      enteredAtMs: at, exitAtMs: at + 40 * MIN,
      returnPct: i % 3 === 0 ? 60 : -20,
      marks: ramp(at, i % 3 === 0 ? 70 : 6, i % 3 === 0 ? 60 : -20),
    });
  }

  const members = loadCohortMembersOnDb(d, {});
  const owner = selectCohort(members, { paperKind: OWNER_VALIDATION_PAPER_KIND });
  assert.equal(owner.length, 25);
  assert.equal(owner.every((m) => m.sessionDate != null), true, "no owner member is session-less any more");
  assert.equal(
    owner.every((m) => m.sessionDateSource === "CASE"), true,
    "resolved through the case the mirror names — the join the alert id could never make",
  );
  assert.equal(owner.every((m) => m.opportunityCaseId.length > 0), true, "identity survives into the cohort");

  const stats = computeCohortStatistics(owner, { paperKind: OWNER_VALIDATION_PAPER_KIND });
  assert.equal(stats.pooledAcrossLanes, false);
  assert.equal(stats.realizedSample.independentSessions, 5);
  assert.ok(stats.realizedSample.independentSessions >= MIN_SESSIONS_FOR_PROBABILITY);
  assert.equal(stats.realizedSample.verdict, "SUPPORTED");
  assert.equal(stats.excursionSample.verdict, "SUPPORTED");
  assert.ok(stats.winRate != null, "a cleared floor opens the empirical figures");
  assert.ok(stats.milestoneProbabilities.every((m) => m.probability != null));
  assert.equal(stats.dateRange.from, "2026-08-17");
  assert.equal(stats.dateRange.to, "2026-08-21");
  d.close();
});

test("a mirror whose case cannot be resolved still gets its session from its own entry", () => {
  const d = db();
  // A mirror with no case identity at all — the shape of the research shadow lane, and of
  // any row written before the snapshot carried a case id.
  d.prepare(
    `INSERT INTO options_paper_trades (option_symbol, result_class, side, strike, expiration, dte,
       entry_fill, exit_fill, strategy, status, return_pct, entered_at_ms, exit_at_ms,
       feature_snapshot_json, alert_id, paper_kind, created_at_ms, updated_at_ms)
     VALUES ('O:IWM260819P00301000','REAL_OPTION_PAPER','put',301,'2026-08-19',2,1.0,1.2,
             'lower_high_continuation','EXITED',20,?,?,'{"source":"enriched"}',NULL,'RESEARCH_ONLY_PAPER',?,?)`,
  ).run(T0, T0 + 30 * MIN, T0, T0);

  const m = loadCohortMembersOnDb(d, {})[0];
  assert.equal(m.sessionDate, SESSION);
  assert.equal(m.sessionDateSource, "MIRROR_ENTRY", "a trade's session is the session it was entered in");
  assert.equal(m.opportunityCaseId, "", "and nothing is invented to fill the identity it does not have");
  assert.equal(m.symbol, "IWM", "the underlying is read off the exact OCC, not guessed");
  d.close();
});

test("the probability floors are NOT lowered — four sessions still refuses", () => {
  const d = db();
  const day = (iso) => Date.parse(`${iso}T14:00:00.000Z`);
  const days = ["2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20"];
  for (let i = 0; i < 25; i += 1) {
    const at = day(days[i % days.length]) + i * MIN;
    seedOwnerCallout(d, { enteredAtMs: at, exitAtMs: at + 40 * MIN, returnPct: 12, marks: ramp(at, 20, 12) });
  }
  const stats = computeCohortStatistics(
    selectCohort(loadCohortMembersOnDb(d, {}), { paperKind: OWNER_VALIDATION_PAPER_KIND }),
    { paperKind: OWNER_VALIDATION_PAPER_KIND },
  );
  assert.equal(stats.realizedSample.trades, 25, "the sample is real and reported");
  assert.equal(stats.realizedSample.independentSessions, 4);
  assert.equal(stats.realizedSample.verdict, "INSUFFICIENT_EVIDENCE");
  assert.equal(stats.winRate, null, "counts are shown; the rate is withheld");
  assert.equal(stats.profitFactor, null);
  assert.ok(stats.milestoneProbabilities.every((m) => m.probability === null));
  assert.ok(stats.milestoneProbabilities.some((m) => m.of > 0), "the raw counts are still visible");
  d.close();
});

// ── learning labels: a winner and a loser must be visibly different ──────────

test("a winner trace carries strategy, strength, contract, targets, path and milestone timing", () => {
  const d = db();
  const seeded = seedOwnerCallout(d, {
    returnPct: 44.42, entryFill: 1.0, targetT1: 1.4,
    marks: [[5, T0 + 5 * MIN], [12, T0 + 10 * MIN], [26, T0 + 20 * MIN], [44.42, T0 + 60 * MIN]],
  });
  const row = buildOwnerLearningReportOnDb(d, {}).rows.find((r) => r.paperTradeId === seeded.tradeId);

  assert.equal(row.symbol, "IWM");
  assert.equal(row.optionSymbol, "O:IWM260819P00301000");
  assert.equal(row.side, "PUT");
  assert.equal(row.strategyKey, "lower_high_continuation");
  assert.equal(row.selection.deliveryQualityScore, 100, "the delivery-time quality score, 0–100. Research only.");
  assert.equal(
    row.selection.selectionStrength, 100,
    "the SELECTED strategy's strength, read from the evaluation that was actually traded",
  );
  assert.equal(row.selection.signalVerdict, "SUPPORTIVE");
  assert.equal(row.selection.signalsMatched, 1);
  assert.equal(row.selection.contradictingEvidence, 0);
  assert.equal(row.selection.strategyVersion, "1");
  assert.equal(row.entryFill, 1.0);
  assert.equal(row.targetT1, 1.4);
  assert.equal(row.realizedReturnPct, 44.42);
  assert.equal(row.realizedEvidence, "VERIFIED");
  assert.equal(row.excursionState, "VERIFIED_EXCURSION");
  assert.equal(row.mfePct, 44.42);
  assert.equal(row.flags.includes("TARGET_1_HIT"), true, "1.4442 cleared the frozen 1.40");
  assert.equal(row.pathLabel, "EVENTUAL_T1_WINNER");
  assert.equal(row.flags.includes("SAME_DAY_EXIT"), true);
  assert.equal(row.msToMilestone["10"], 10 * MIN);
  assert.equal(row.msToMilestone["25"], 20 * MIN);
  assert.equal(row.msToMilestone["100"], null, "never reached is null, not zero");
  assert.equal(row.selection.delta, -0.42, "pre-callout features come from the PRE_MOVE row via the pending case");
  assert.equal(row.selection.openInterest, 8100);
  d.close();
});

test("a loser that worked, reversed, held overnight and gapped through its stop says all four", () => {
  const d = db();
  const nextDay = Date.parse("2026-08-18T13:35:00.000Z");
  const seeded = seedOwnerCallout(d, {
    symbol: "NFLX", occ: "O:NFLX260814P00074000", side: "put", strategy: "lower_high_continuation",
    entryFill: 3.0, targetT1: 4.5, stop: 2.1, returnPct: -85.67, exitReason: "stop",
    exitAtMs: nextDay + 5 * MIN, quality: 0.6,
    marks: [
      [4, T0 + 5 * MIN], [22, T0 + 25 * MIN], [26, T0 + 45 * MIN], [8, T0 + 120 * MIN],
      // last mark of session one, then the opening print the next morning — the gap.
      [-4, T0 + 350 * MIN],
      [-80, nextDay], [-85.67, nextDay + 5 * MIN],
    ],
  });
  const row = buildOwnerLearningReportOnDb(d, {}).rows.find((r) => r.paperTradeId === seeded.tradeId);

  assert.equal(row.realizedReturnPct, -85.67);
  assert.equal(row.mfePct, 26, "it genuinely worked before it did not");
  assert.equal(row.flags.includes("TARGET_1_HIT"), false, "+26% never reached the frozen 4.50");
  assert.equal(row.pathLabel, "GOOD_MOVE_THEN_REVERSED");
  assert.equal(row.flags.includes("HELD_OVERNIGHT"), true);
  assert.equal(row.stopEvidence.crossedSessionBoundary, true);
  assert.equal(row.flags.includes("OVERNIGHT_GAP"), true);
  assert.equal(row.stopEvidence.overnightGapPct, -76, "measured across the session boundary, not within a session");
  assert.equal(row.flags.includes("STOP_LEAKAGE"), true);
  assert.ok(row.stopEvidence.stopSlippagePct < -50, "it filled far below the 2.10 stop");
  assert.equal(row.stopEvidence.stopLevel, 2.1);
  assert.equal(row.selection.deliveryQualityScore, 60);
  assert.equal(
    row.selection.selectionStrength, 100,
    "selection strength and delivery quality are different numbers and never stand in for each other",
  );

  // The two traces must be distinguishable from the payload alone.
  const winner = seedOwnerCallout(d, { returnPct: 44.42, marks: ramp(T0, 50, 44.42) });
  const rows = buildOwnerLearningReportOnDb(d, {}).rows;
  const w = rows.find((r) => r.paperTradeId === winner.tradeId);
  assert.notEqual(w.pathLabel, row.pathLabel);
  assert.equal(w.flags.includes("OVERNIGHT_GAP"), false);
  assert.equal(w.flags.includes("STOP_LEAKAGE"), false);
  d.close();
});

test("a path verdict is withheld — never defaulted — when the marks cannot support one", () => {
  const d = db();
  const seeded = seedOwnerCallout(d, { returnPct: -40, marks: [[3, T0 + MIN], [9, T0 + 2 * MIN]] });
  const row = buildOwnerLearningReportOnDb(d, {}).rows.find((r) => r.paperTradeId === seeded.tradeId);
  assert.equal(row.excursionState, "INSUFFICIENT_MARKS");
  assert.equal(row.mfePct, null, "two marks cannot assert the gaps held nothing larger");
  assert.equal(row.pathLabel, "PATH_UNKNOWN");
  assert.notEqual(row.pathLabel, "NEVER_WORKED", "unmeasured is not the same as measured and bad");
  assert.equal(row.realizedReturnPct, -40, "and the realized loss is unaffected by an unknown path");
  assert.ok(row.limitations.some((l) => l.includes("too few to claim a peak")));

  const s = buildOwnerLearningReportOnDb(d, {}).statistics;
  assert.equal(s.withoutTrajectoryEvidence, 1);
  d.close();
});

// ── the deterministic research context ──────────────────────────────────────

test("the nightly deterministic context sees the owner trades", () => {
  const d = db();
  seedOwnerCallout(d, { returnPct: 44.42, marks: ramp(T0, 50, 44.42) });
  seedOwnerCallout(d, {
    symbol: "NVDA", occ: "O:NVDA260821C00180000", side: "call",
    returnPct: -30, exitReason: "stop", marks: ramp(T0, 6, -30),
  });

  const ctx = buildAiResearchContextOnDb(d, { sessionDate: SESSION, nowMs: T0 });
  assert.equal(ctx.ownerDiscord.openings, 2);
  assert.equal(ctx.ownerDiscord.closed, 2);
  assert.equal(ctx.ownerDiscord.wins, 1);
  assert.equal(ctx.ownerDiscord.losses, 1);
  assert.ok(ctx.ownerDiscord.profitFactor > 0);

  assert.ok(ctx.ownerValidation, "the owner lane is its own section, over the whole forward record");
  assert.equal(ctx.ownerValidation.lane, OWNER_VALIDATION_PAPER_KIND);
  assert.equal(ctx.ownerValidation.statistics.closed, 2);
  assert.equal(ctx.ownerValidation.statistics.callCount, 1);
  assert.equal(ctx.ownerValidation.statistics.putCount, 1);
  assert.ok(ctx.ownerValidation.notableTrades.length >= 2, "a winner and a loser both get a row");
  const labels = new Set(ctx.ownerValidation.notableTrades.map((t) => t.pathLabel));
  assert.ok(labels.size >= 2, "the traces are not all the same shape");
  assert.ok(ctx.readingRules.some((r) => r.includes("DISJOINT")), "the lane rule travels in the payload");
  d.close();
});

// ── authority ───────────────────────────────────────────────────────────────

test("the owner learning path has zero production authority", () => {
  const src = [
    "lib/opportunity-case/owner-mirror-identity.ts",
    "lib/research/options/owner-learning.ts",
  ].map((f) => readFileSync(f, "utf8"));

  for (const s of src) {
    assert.ok(!/\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b/i.test(s),
      "the owner learning path reads; it never writes");
    assert.ok(!/fetch\(|axios|polygon/i.test(s), "and it contacts no provider");
  }

  const d = db();
  seedOwnerCallout(d, { returnPct: 44.42, marks: ramp(T0, 50, 44.42) });
  const ctx = buildAiResearchContextOnDb(d, { sessionDate: SESSION, nowMs: T0 });
  const instructions = ctx.instructions.join(" ");
  assert.match(instructions, /may not change a live threshold/i);
  assert.match(instructions, /deploy code/i);
  assert.match(instructions, /alter subscriber readiness/i);
  assert.ok(
    ctx.ownerValidation.note.includes("NEVER pool"),
    "the lane's own note forbids the one summarisation that would destroy it",
  );
  d.close();
});

test("OWNER_VALIDATION_PAPER is a quant lane of its own, with a resolved excursion", async () => {
  const { buildQuantLaneReport } = await import("../lib/research/options/quant-lanes.ts");
  const d = db();
  const seeded = seedOwnerCallout(d, { returnPct: 44.42, marks: ramp(T0, 50, 44.42) });
  // A stored peak nothing on the frozen contract printed. The lane must not read it.
  d.prepare("UPDATE options_paper_trades SET mfe_pct=900, mae_pct=-900 WHERE id=?").run(seeded.tradeId);
  // A subscriber mirror in the same window, to prove the lanes do not merge.
  d.prepare(
    `INSERT INTO options_paper_trades (option_symbol, result_class, side, strike, expiration, dte,
       entry_fill, exit_fill, strategy, status, return_pct, entered_at_ms, exit_at_ms,
       feature_snapshot_json, alert_id, paper_kind, created_at_ms, updated_at_ms)
     VALUES ('O:IWM260819P00301000','REAL_OPTION_PAPER','put',301,'2026-08-19',2,1.0,0.2,
             'lower_high_continuation','EXITED',-80,?,?,'{}','oa_sub_9','DELIVERED_ALERT_PAPER',?,?)`,
  ).run(T0, T0 + 60 * MIN, T0, T0);

  const lanes = buildQuantLaneReport(d, {}).lanes;
  const owner = lanes.find((l) => l.lane === "owner_validation_paper");
  const delivered = lanes.find((l) => l.lane === "delivered_alert_paper");
  assert.ok(owner, "the owner lane has a row of its own — it had none at all before");
  assert.equal(owner.sampleSize, 1);
  assert.equal(owner.winners, 1);
  assert.equal(delivered.sampleSize, 1);
  assert.equal(delivered.losers, 1, "and the two never merge");
  assert.equal(owner.mfeAvg, 50, "recomputed from same-contract marks, not the stored 900");
  assert.notEqual(owner.mfeAvg, 900);
  assert.equal(owner.maeAvg, 0);
  d.close();
});
