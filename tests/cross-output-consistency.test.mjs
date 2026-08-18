/**
 * tests/cross-output-consistency.test.mjs
 *
 * PHASE 7 — the regression proof the previous session called for and did not build.
 *
 * ONE canonical owner callout is seeded, and every surface that can speak about it is
 * asked what it thinks. They must agree on case identity, source lane, symbol, side,
 * the EXACT OCC, entry, T1/T2/stop, realized status, realized return, the realized/MFE
 * distinction, session, and evidence state.
 *
 * ── Why this test and not a wider one ─────────────────────────────────────────
 *
 * Every defect this repository has recorded in the last month had the same shape: a
 * consumer resolved a trade through an identity the trade does not carry, got the
 * EMPTY SET back, and reported it as a quiet day. An empty result is indistinguishable
 * from an honest zero, so no individual surface could catch it. What catches it is
 * asking several surfaces about a trade that definitely exists and requiring them to
 * say the same thing — a disagreement is loud where an absence was silent.
 *
 * ── The two assertions that matter commercially ───────────────────────────────
 *
 * SUBSCRIBER: this callout was never delivered to a subscriber. The subscriber claim
 * path must REFUSE it. Owner-validation performance becoming subscriber performance is
 * the single most expensive mistake this system could make, and it would be made by
 * accident — an owner mirror and a delivered mirror are the same table, the same
 * columns and nearly the same row.
 *
 * CONTENT: content may not print this as a subscriber result. If it references the
 * case at all it must carry OWNER VALIDATION / PAPER-TRACKED, and it must distinguish
 * the REALIZED return from the MFE — a peak the contract touched and gave back is not
 * a result anyone got.
 *
 * Fixture is the SAME migration production runs, not a hand-copy. Nothing here sets an
 * `alert_id` on the owner rows, because production never does: 0 of 74 owner mirrors
 * and 0 of 74 owner cases carry one. A fixture that sets them tests the subscriber
 * lane's shape while claiming to test the owner's.
 */
import "./helpers/register-alias.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { buildOwnerLearningReportOnDb } from "../lib/research/options/owner-learning.ts";
import { buildOwnerValidationLaneContext } from "../lib/research/options/ai-research-context.ts";
import { loadOwnerMirrorPopulationOnDb, preMoveCaseIdForFingerprint } from "../lib/opportunity-case/owner-mirror-identity.ts";
import { buildSubscriberClaimPacket } from "../lib/research/options/subscriber-claims.ts";
import { verifyContentClaimForCase, mfeDisclaimer } from "../lib/content/claim-integrity.ts";
import { recordPreMoveObservationOnDb, recordPreMoveAlertOnDb } from "../lib/research/options/pre-move-store.ts";
import { recordPreMoveV2AlertOnDb } from "../lib/research/options/pre-move-v2-store.ts";
import { buildPreMoveV2Report } from "../lib/research/options/pre-move-v2-report.ts";
import { buildPreMoveNightlyReport } from "../lib/research/options/pre-move-nightly.ts";
import { buildAdvisoryEvidencePacket } from "../lib/ai/advisory-chat-evidence.ts";
import { auditOwnerMirrorsOnDb } from "../lib/research/options/owner-mirror-audit.ts";

const { applyProductionSchemaOnDb } = await import("@/lib/db");

// ── THE CANONICAL CASE ───────────────────────────────────────────────────────
//
// Modelled on the real IWM callout the packet traces end to end, including the detail
// that makes it worth using: it PEAKED at +44.42% and CLOSED at +18.10%. A surface
// that quotes the peak as the result is wrong in the most flattering possible way, so
// realized and MFE cannot be conflated without this test noticing.
const CASE = Object.freeze({
  claimCaseId: "oc_alfb24",
  fingerprint: "of_1d78kh2",
  symbol: "IWM",
  occ: "O:IWM260819P00301000",
  otherOcc: "O:IWM260819P00300000",
  side: "PUT",
  strategy: "lower_high_continuation",
  sessionDate: "2026-08-19",
  entry: 0.986,
  t1: 1.42,
  t2: 1.86,
  stop: 0.59,
  realizedReturnPct: 18.1,
  peakReturnPct: 44.42,
});

const T0 = Date.parse("2026-08-19T14:05:00.000Z");
const MIN = 60_000;

function seedCanonicalOwnerCallout(d) {
  const preMoveCaseId = preMoveCaseIdForFingerprint(CASE.fingerprint);

  // The PENDING audit case the scanner wrote, 1.8 s before the send. It owns the
  // pre-move observation and is a DIFFERENT row from the claim case.
  d.prepare(
    `INSERT INTO opportunity_cases
       (opportunity_id, underlying_symbol, detected_at_ms, source_path, acceptance_decision,
        delivery_decision, case_json, created_at_ms, updated_at_ms, alert_id)
     VALUES (?,?,?,'scanner','pending','pending',?,?,?,NULL)`,
  ).run(
    preMoveCaseId, CASE.symbol, T0 - 1800,
    JSON.stringify({ underlyingSymbol: CASE.symbol, opportunityFingerprint: CASE.fingerprint }),
    T0 - 1800, T0 - 1800,
  );

  // The CLAIM case minted at delivery. It owns the frozen trade and the mirror.
  d.prepare(
    `INSERT INTO opportunity_cases
       (opportunity_id, underlying_symbol, detected_at_ms, source_path, acceptance_decision,
        delivery_decision, case_json, created_at_ms, updated_at_ms, alert_id)
     VALUES (?,?,?,'owner','accepted','delivered',?,?,?,NULL)`,
  ).run(
    CASE.claimCaseId, CASE.symbol, T0,
    JSON.stringify({
      underlyingSymbol: CASE.symbol,
      opportunityFingerprint: CASE.fingerprint,
      sessionDate: CASE.sessionDate,
      selectedContract: {
        optionSymbol: CASE.occ, side: "put", strike: 301, expiration: "2026-08-19", dte: 0,
      },
      frozenTrade: {
        entryMid: CASE.entry, targetT1: CASE.t1, targetT2: CASE.t2, stop: CASE.stop,
      },
      setupFamily: CASE.strategy,
      strategyEvaluations: [
        // The FIRST entry is deliberately a strategy that was NOT traded. A consumer
        // reading [0], or the strongest, reports a strategy this callout never used.
        {
          strategyId: "vwap_rejection", strength: 62, signal: "NEUTRAL",
          evidence: ["a", "b"], contradictingEvidence: ["x"],
        },
        {
          strategyId: CASE.strategy, strength: 100, signal: "SUPPORTIVE",
          evidence: ["a", "b", "c", "d", "e"], contradictingEvidence: [],
        },
      ],
    }),
    T0, T0,
  );

  const info = d.prepare(
    `INSERT INTO options_paper_trades
       (option_symbol, side, strike, expiration, dte, result_class, entry_fill, exit_fill, status,
        return_pct, entered_at_ms, exit_at_ms, exit_reason, strategy, feature_snapshot_json, paper_kind,
        alert_id, created_at_ms, updated_at_ms)
     VALUES (?,'put',301,'2026-08-19',0,'REAL_OPTION_PAPER',?,?,'EXITED',?,?,?,'TARGET_1',?,?,'OWNER_VALIDATION_PAPER',NULL,?,?)`,
  ).run(
    CASE.occ, CASE.entry, +(CASE.entry * (1 + CASE.realizedReturnPct / 100)).toFixed(4),
    CASE.realizedReturnPct, T0, T0 + 40 * MIN, CASE.strategy,
    JSON.stringify({
      lane: "OWNER_ONLY",
      opportunityCaseId: CASE.claimCaseId,
      quality: 0.81,
      strategy: CASE.strategy,
      sessionDate: CASE.sessionDate,
    }),
    T0, T0 + 40 * MIN,
  );
  const tradeId = Number(info.lastInsertRowid);

  // Marks on the FROZEN contract: it ran to +44.42% and closed at +18.10%.
  const marks = [
    [0, 0, CASE.entry],
    [12, 6 * MIN, 1.104],
    [27, 14 * MIN, 1.252],
    [CASE.peakReturnPct, 22 * MIN, 1.424],
    [30, 33 * MIN, 1.282],
    [CASE.realizedReturnPct, 40 * MIN, 1.164],
  ];
  for (const [ret, off, fill] of marks) {
    d.prepare(
      `INSERT INTO options_paper_marks (trade_id, option_symbol, mark_at_ms, return_pct, exit_fill, created_at_ms)
       VALUES (?,?,?,?,?,?)`,
    ).run(tradeId, CASE.occ, T0 + off, ret, fill, T0);
  }
  // One mark on a DIFFERENT strike. It must never enter this callout's trajectory: a
  // neighbouring contract's +300% is not this decision's return.
  d.prepare(
    `INSERT INTO options_paper_marks (trade_id, option_symbol, mark_at_ms, return_pct, exit_fill, created_at_ms)
     VALUES (?,?,?,?,?,?)`,
  ).run(tradeId, CASE.otherOcc, T0 + 25 * MIN, 300, 4.0, T0);

  // OWNER DISCORD — the delivery log row that PROVES the opening was actually sent.
  // The owner mirror audit takes its population from here rather than from the mirror,
  // deliberately: a mirror is evidence a trade was tracked, and only this row is evidence
  // an owner was told. Note there is no alert_id — owner deliveries never write one.
  d.prepare(
    `INSERT INTO discord_deliveries
       (delivery_id, alert_id, channel_type, webhook_name, payload_type, payload_json,
        idempotency_key, created_at, sent_at, status, opportunity_case_id,
        thesis_fingerprint, lifecycle_state)
     VALUES (?,NULL,'owner','DISCORD_WEBHOOK_OWNER','owner_intraday_actionable',?,?,?,?, 'SENT',?,?,'OPENING')`,
  ).run(
    "dd_canonical",
    JSON.stringify({ symbol: CASE.symbol, optionSymbol: CASE.occ, audience: "owner" }),
    "idem_canonical",
    new Date(T0).toISOString(),
    new Date(T0).toISOString(),
    CASE.claimCaseId,
    CASE.fingerprint,
  );

  recordPreMoveObservationOnDb(d, {
    opportunityCaseId: preMoveCaseId, sessionDate: CASE.sessionDate, symbol: CASE.symbol,
    direction: "bearish", side: "PUT", optionSymbol: CASE.occ, strategyKey: CASE.strategy,
    deploymentSha: "testsha", lane: "SHADOW", nowMs: T0 - 1800, eligible: true,
    underlyingPrice: 302.4, optionAsk: CASE.entry,
    triggerLevel: 301.0, triggerTaken: false, sessionHigh: 303.1, sessionLow: 301.4,
  });
  recordPreMoveAlertOnDb(d, {
    opportunityCaseId: CASE.claimCaseId, preMoveCaseId,
    ownerNotifiedAtMs: T0, underlyingAtAlert: 302.4, optionAtAlert: CASE.entry, lane: "OWNER",
  });
  recordPreMoveV2AlertOnDb(d, {
    opportunityCaseId: CASE.claimCaseId, preMoveCaseId, side: "PUT", ownerNotifiedAtMs: T0,
    underlyingAtAlert: 302.4, sessionHighAtAlert: 303.1, sessionLowAtAlert: 301.4,
    triggerLevelAtAlert: 301.0, triggerTakenAtAlert: false,
    optionAtAlert: CASE.entry, optionAtFirstDetection: CASE.entry,
    underlyingAtFirstDetection: 302.4,
    firstSetupObservedAtMs: T0 - 1800, firstFullConfirmationAtMs: T0 - 1800,
    entryPremium: CASE.entry, target1Premium: CASE.t1, target2Premium: CASE.t2, stopPremium: CASE.stop,
  });

  return { tradeId, preMoveCaseId };
}

function db() {
  const d = new Database(":memory:");
  applyProductionSchemaOnDb(d);
  return d;
}

/** Every surface's answer about the canonical case, gathered once. */
function resolveEverySurface(d) {
  const learning = buildOwnerLearningReportOnDb(d, {});
  const ownerRow = learning.rows.find((r) => r.opportunityCaseId === CASE.claimCaseId) ?? null;

  const population = loadOwnerMirrorPopulationOnDb(d, {});
  const mirror = population.byCaseId.get(CASE.claimCaseId) ?? null;

  const laneContext = buildOwnerValidationLaneContext(d);
  const trace = laneContext?.notableTrades.find((t) => t.opportunityCaseId === CASE.claimCaseId) ?? null;

  const v1 = buildPreMoveNightlyReport(d, {});
  const v1Owner = v1.lanes.find((l) => l.lane === "OWNER");
  const v1Row = v1Owner?.rows.find((r) => r.ownerCaseId === CASE.claimCaseId || r.opportunityCaseId === CASE.claimCaseId) ?? null;

  const v2 = buildPreMoveV2Report(d, {});

  return { learning, ownerRow, population, mirror, laneContext, trace, v1Owner, v1Row, v2 };
}

// ── the surfaces must agree ──────────────────────────────────────────────────

test("every surface resolves the SAME canonical callout at all", () => {
  const d = db();
  seedCanonicalOwnerCallout(d);
  const s = resolveEverySurface(d);

  assert.ok(s.ownerRow, "OWNER LEARNING must resolve the callout");
  assert.ok(s.mirror, "the owner mirror population must resolve it");
  assert.ok(s.trace, "the NIGHTLY RESEARCH owner trace must resolve it");
  assert.ok(s.v1Row, "PRE_MOVE V1 must resolve it");
  assert.equal(s.v2.population.rows, 1, "PRE_MOVE V2 must resolve it");

  // The specific silent failure this whole test exists to catch: a consumer that joins
  // on alert_id gets the empty set and reports a quiet day.
  assert.equal(s.learning.rows.length, 1);
  assert.notEqual(s.learning.rows.length, 0, "an empty result reads exactly like an honest zero");
});

test("case identity and source lane agree across every surface", () => {
  const d = db();
  const { preMoveCaseId } = seedCanonicalOwnerCallout(d);
  const s = resolveEverySurface(d);

  assert.equal(s.ownerRow.opportunityCaseId, CASE.claimCaseId);
  assert.equal(s.trace.opportunityCaseId, CASE.claimCaseId);
  assert.equal(s.mirror.opportunityCaseId, CASE.claimCaseId);
  assert.equal(s.ownerRow.preMoveCaseId, preMoveCaseId, "both identities of one callout");
  assert.equal(s.mirror.paperKind, "OWNER_VALIDATION_PAPER");
  assert.match(s.laneContext.lane, /OWNER_VALIDATION_PAPER/);
});

test("symbol, side and the EXACT OCC agree, and a neighbouring strike is refused", () => {
  const d = db();
  seedCanonicalOwnerCallout(d);
  const s = resolveEverySurface(d);

  for (const [label, v] of [["learning", s.ownerRow], ["trace", s.trace], ["mirror", s.mirror]]) {
    assert.equal(v.symbol, CASE.symbol, `${label} symbol`);
    assert.equal(v.side, CASE.side, `${label} side`);
    assert.equal(v.optionSymbol, CASE.occ, `${label} OCC`);
  }
  assert.equal(s.ownerRow.frozenOptionSymbol, CASE.occ);
  assert.equal(s.ownerRow.occExact, true);
  assert.equal(s.v1Row.optionSymbol, CASE.occ);
});

test("entry, T1, T2 and stop agree — the frozen levels, never a recomputed one", () => {
  const d = db();
  seedCanonicalOwnerCallout(d);
  const s = resolveEverySurface(d);

  assert.equal(s.ownerRow.entryFill, CASE.entry);
  assert.equal(s.ownerRow.targetT1, CASE.t1);
  assert.equal(s.ownerRow.targetT2, CASE.t2);
  assert.equal(s.ownerRow.stop, CASE.stop);

  assert.equal(s.trace.entryFill, CASE.entry);
  assert.equal(s.trace.targetT1, CASE.t1);
  assert.equal(s.trace.targetT2, CASE.t2);
  assert.equal(s.trace.stop, CASE.stop);

});

test("realized status and realized return agree", () => {
  const d = db();
  seedCanonicalOwnerCallout(d);
  const s = resolveEverySurface(d);

  assert.equal(s.ownerRow.status, "EXITED");
  assert.equal(s.ownerRow.realizedReturnPct, CASE.realizedReturnPct);
  assert.equal(s.trace.realizedReturnPct, CASE.realizedReturnPct);
  assert.equal(s.mirror.realizedReturnPct, CASE.realizedReturnPct);
  assert.equal(s.v1Row.realizedReturnPct, CASE.realizedReturnPct);
});

test("THE DISTINCTION — the peak the contract touched is not the result anyone got", () => {
  const d = db();
  seedCanonicalOwnerCallout(d);
  const s = resolveEverySurface(d);

  assert.equal(s.ownerRow.mfePct, CASE.peakReturnPct, "MFE is the peak, recomputed from same-contract marks");
  assert.equal(s.ownerRow.realizedReturnPct, CASE.realizedReturnPct, "realized is what closed");
  assert.notEqual(s.ownerRow.mfePct, s.ownerRow.realizedReturnPct,
    "the fixture is chosen so conflating them cannot pass");
  assert.equal(s.trace.mfePct, CASE.peakReturnPct);
  assert.equal(s.trace.realizedReturnPct, CASE.realizedReturnPct);

  // The +300% on the neighbouring strike may never enter this callout's excursion.
  assert.ok(s.ownerRow.mfePct < 300, "a different strike's mark is not this decision's excursion");
});

test("session and evidence state agree", () => {
  const d = db();
  seedCanonicalOwnerCallout(d);
  const s = resolveEverySurface(d);

  assert.equal(s.ownerRow.sessionDate, CASE.sessionDate);
  assert.equal(s.trace.sessionDate, CASE.sessionDate);
  assert.equal(s.ownerRow.realizedEvidence, s.trace.realizedEvidence);
  assert.equal(s.ownerRow.excursionState, "VERIFIED_EXCURSION");
  assert.equal(s.ownerRow.exactContractMarksAvailable, true);
});

test("the SELECTED strategy is reported, not whichever evaluation sorted first", () => {
  const d = db();
  seedCanonicalOwnerCallout(d);
  const s = resolveEverySurface(d);

  assert.equal(s.trace.strategy, CASE.strategy);
  assert.equal(s.ownerRow.selection.selectionStrength, 100,
    "the traded strategy scored 100; slot 0 holds a different strategy scoring 62");
  assert.equal(s.trace.selectionStrength, 100);
  assert.equal(s.trace.signalVerdict, "SUPPORTIVE");
  // Two different quantities that were being confused with each other. 0.81 quality
  // vs 100 strength on the SAME callout is the argument for keeping them apart.
  assert.notEqual(s.ownerRow.selection.deliveryQualityScore, s.ownerRow.selection.selectionStrength);
});

test("ASK OPTISCAN reads the same owner lane the learning report does", () => {
  const d = db();
  seedCanonicalOwnerCallout(d);
  const s = resolveEverySurface(d);

  // The chat does not query raw tables. `loadSupplementalEvidence` reshapes exactly this
  // audit into the owner-lane evidence items, so agreement here IS agreement in the chat.
  // The audit is called directly because `loadSupplementalEvidence` reaches its sources
  // through `require`, which is not available to an ESM test module.
  const audit = auditOwnerMirrorsOnDb(d, {});
  const stats = s.laneContext.statistics;

  assert.equal(audit.prospective.openings, stats.openings,
    "the chat and the learning report must count the same callouts");
  assert.equal(audit.prospective.mirroredExact, stats.exactMirrors);
  assert.equal(audit.prospective.mirrorRate, stats.mirrorRate);
  assert.equal(audit.prospective.realizedVerified, 1,
    "one closed callout with a verified realized return");
  assert.equal(audit.occMismatches, 0);
});

test("ASK OPTISCAN can cite the owner lane, and every citable number carries its lane", () => {
  const d = db();
  seedCanonicalOwnerCallout(d);
  const audit = auditOwnerMirrorsOnDb(d, {});

  // The supplemental block production builds from that audit, verbatim.
  const supplemental = {
    exitPolicy: null,
    watchlist: null,
    preMove: null,
    ownerLane: {
      openings: audit.prospective.openings,
      mirroredExact: audit.prospective.mirroredExact,
      mirrorRate: audit.prospective.mirrorRate,
      postInstrumentationOpenings: audit.postInstrumentation.openings,
      postInstrumentationMirrorRate: audit.postInstrumentation.mirrorRate,
      postInstrumentationVerdict: audit.postInstrumentation.verdict,
      realizedVerified: audit.prospective.realizedVerified,
      realizedStillOpen: audit.prospective.realizedStillOpen,
      excursionVerified: audit.prospective.excursionVerified,
    },
  };
  const packet = buildAdvisoryEvidencePacket(
    {
      reportId: "test", generatedAtMs: T0, tradingDay: CASE.sessionDate,
      overallState: "OK", activeProductionPipeline: "INDEPENDENT_OPTIONS",
      metrics: [], dataGaps: [],
    },
    supplemental,
  );

  assert.ok(packet.items.length > 0, "an empty packet means the chat can answer nothing");
  for (const item of packet.items) {
    assert.ok(item.lane, `evidence item ${item.id} must name its lane`);
    assert.ok(item.sourceRef, `evidence item ${item.id} must name its source`);
  }
  // Two lanes may never be merged into one claim.
  const ownerItems = packet.items.filter((i) => /owner/i.test(i.lane) || /owner/i.test(i.id));
  assert.ok(ownerItems.length > 0, "the owner lane must be citable");

  assert.equal(packet.safety.aiAuthority, "ADVISORY_ONLY");
  assert.equal(packet.safety.productionBehaviorChanged, false);
});

// ── THE SUBSCRIBER ASSERTION ─────────────────────────────────────────────────

test("SUBSCRIBER — this callout was never delivered to subscribers, and the claim path REFUSES it", () => {
  const d = db();
  seedCanonicalOwnerCallout(d);

  // There is no options_alerts row, because an owner callout never writes one. Every
  // identifier a subscriber surface could reach for resolves to nothing.
  const alertRows = d.prepare("SELECT COUNT(*) n FROM options_alerts").get();
  assert.equal(Number(alertRows.n), 0, "the fixture must not invent a subscriber alert");

  for (const attempt of [CASE.claimCaseId, CASE.fingerprint, "oa_anything"]) {
    const packet = buildSubscriberClaimPacket(d, attempt);
    assert.equal(packet.ok, false, `subscriber claim must refuse "${attempt}"`);
    assert.ok(packet.reason, "a refusal must say why");
    assert.equal(packet.realizedReturnPct, null,
      "owner-validation performance must never surface as a subscriber return");
    assert.equal(packet.mfePct, null);
  }
});

test("SUBSCRIBER — the owner mirror is not reachable as a DELIVERED_ALERT_PAPER row", () => {
  const d = db();
  seedCanonicalOwnerCallout(d);
  const delivered = d.prepare(
    "SELECT COUNT(*) n FROM options_paper_trades WHERE paper_kind='DELIVERED_ALERT_PAPER'",
  ).get();
  assert.equal(Number(delivered.n), 0,
    "owner and subscriber lanes share a table; only paper_kind keeps them apart");
});

test("OWNER DISCORD — the opening went to the owner lane and nowhere else", () => {
  const d = db();
  seedCanonicalOwnerCallout(d);

  const rows = d.prepare("SELECT channel_type, webhook_name, payload_type FROM discord_deliveries").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel_type, "owner");
  assert.equal(rows[0].payload_type, "owner_intraday_actionable");
  assert.notEqual(rows[0].webhook_name, "DISCORD_WEBHOOK_CONTENT",
    "content and the owner recap shared a channel once; they may not again");

  const subscriber = d.prepare(
    "SELECT COUNT(*) n FROM discord_deliveries WHERE channel_type='subscriber'",
  ).get();
  assert.equal(Number(subscriber.n), 0, "no subscriber ever saw this callout");
});

// ── THE CONTENT ASSERTION ────────────────────────────────────────────────────

test("CONTENT — an owner callout cannot power a performance draft", () => {
  const d = db();
  seedCanonicalOwnerCallout(d);

  // Every category that would print a number about how the trade did.
  for (const category of ["CLOSED_WINNER", "RETURN_MILESTONE", "NEW_HIGH", "WHY_THIS_WORKED"]) {
    const check = verifyContentClaimForCase(d, CASE.claimCaseId, category);
    assert.equal(check.ok, false,
      `${category} requires a SENT alert with a delivered mirror; an owner callout has neither`);
    assert.ok(check.reason, "the refusal must be diagnosable");
    assert.equal(check.claim, null);
  }
});

test("CONTENT — a non-performance category is allowed, and makes no performance claim", () => {
  const d = db();
  seedCanonicalOwnerCallout(d);
  const check = verifyContentClaimForCase(d, CASE.claimCaseId, "EDUCATIONAL_BREAKDOWN");
  assert.equal(check.ok, true, "commentary is not a results claim and is not blocked");
  assert.equal(check.resultType, "NON_ACTIONABLE_RESEARCH",
    "the result type is what stops it printing a return");
  assert.equal(check.claim, null, "no claim packet means no number to print");
});

test("CONTENT — realized and MFE stay distinguishable, and a peak carries its disclaimer", () => {
  const d = db();
  seedCanonicalOwnerCallout(d);
  const s = resolveEverySurface(d);

  const disclaimer = mfeDisclaimer(s.ownerRow.mfePct);
  assert.match(disclaimer, /peak|max|not.*(realized|closing)/i,
    "a peak printed without the word 'peak' is a result claim");
  assert.doesNotMatch(String(disclaimer), /guarantee|will/i);

  // The number a draft would be tempted to print, and the number that is true.
  assert.equal(s.ownerRow.mfePct, CASE.peakReturnPct);
  assert.equal(s.ownerRow.realizedReturnPct, CASE.realizedReturnPct);
});

// ── V1 and V2 read the same callout and are allowed to disagree ──────────────

test("V1 and V2 both resolve the callout, agree on identity, and differ only on the stage", () => {
  const d = db();
  seedCanonicalOwnerCallout(d);
  const s = resolveEverySurface(d);

  assert.equal(s.v1Row.optionSymbol, CASE.occ);
  assert.equal(s.v2.population.rows, 1);
  assert.equal(s.v2.coverage.capturedOwnerRows, 1);

  // V1: trigger not taken, so PRE_TRIGGER regardless of magnitude.
  assert.equal(s.v1Row.discoveryStage, "PRE_TRIGGER");

  // V2 on the same alert-instant snapshot: 302.4 sits (303.1 - 302.4)/(303.1 - 301.4)
  // = 41% of the way down the day's range, so the move is underway.
  const stageRows = s.v2.byStage.filter((x) => x.rows > 0);
  assert.equal(stageRows.length, 1);
  assert.equal(stageRows[0].stage, "EARLY_EXPANSION",
    "the same callout, honestly measured against the session rather than against a 1.8s window");
});

test("V2 still refuses to conclude from one callout", () => {
  const d = db();
  seedCanonicalOwnerCallout(d);
  const s = resolveEverySurface(d);
  assert.equal(s.v2.verdict, "INSUFFICIENT_EVIDENCE");
  for (const q of s.v2.questions) assert.equal(q.supported, false);
});

// ── the lane statistics describe the same one trade ──────────────────────────

test("the lane aggregate and the single row cannot disagree about the trade they share", () => {
  const d = db();
  seedCanonicalOwnerCallout(d);
  const s = resolveEverySurface(d);
  const stats = s.laneContext.statistics;

  assert.equal(stats.openings, 1);
  assert.equal(stats.closed, 1);
  assert.equal(stats.wins, 1, "+18.10% is a win");
  assert.equal(stats.losses, 0);
  assert.equal(stats.exactMirrors, 1);
  assert.equal(stats.mirrorRate, 1);
});

test("an OCC-mismatched mirror is censored everywhere, not priced anywhere", () => {
  const d = db();
  seedCanonicalOwnerCallout(d);
  // Move the mirror onto a neighbouring strike the case never froze.
  d.prepare("UPDATE options_paper_trades SET option_symbol=? WHERE paper_kind='OWNER_VALIDATION_PAPER'")
    .run(CASE.otherOcc);

  const s = resolveEverySurface(d);
  assert.equal(s.ownerRow.occExact, false, "the mismatch must be visible");
  assert.equal(s.trace, null, "a wrong-contract mirror is never handed to research as evidence");
  assert.equal(s.v2.population.closedOutcomes, 0,
    "a different strike's return is not this decision's return");
});
