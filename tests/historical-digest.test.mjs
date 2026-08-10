/**
 * The historical digest CONSUMER, as regressions.
 *
 * Production at 9c29c31 reported `HELD_FOR_HISTORICAL_DIGEST: 30` with
 * `eventsAwaitingRecovery: 0` — the flood was stopped and the held rows had no
 * reader. These tests pin the two halves of the repair:
 *
 *   1. one canonical outcome appears ONCE, no matter how many events described
 *      the closure or how many phrasings each event produced;
 *   2. consuming held rows can never raise SENT, resend a delivered outcome,
 *      delete a row, or outrank live content.
 */
import "./helpers/register-alias.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  buildHistoricalDigest,
  groupHeldDraftsIntoOutcomes,
  renderHistoricalDigest,
  contractLabelFor,
  digestSizeCap,
  HISTORICAL_DIGEST_LABEL,
  HISTORICAL_DIGEST_EXPLANATION,
} from "../lib/content/historical-digest.ts";
import {
  readHeldDraftRows,
  generateHistoricalDigest,
  deliverHistoricalDigest,
  runHistoricalDigestScan,
  markDraftsConsumedByDigest,
  buildDigestDiagnostics,
  digestDiscordEnabled,
  casesWithDeliveredReportCard,
  priorDigestOutcomeIds,
} from "../lib/content/historical-digest-runtime.ts";
import { describeReason } from "../lib/content/delivery-reason.ts";

const NOW = Date.parse("2026-08-06T02:00:00.000Z");
const CLOSED_AT = NOW - 3 * 24 * 60 * 60_000;

const { applyProductionSchemaOnDb } = await import("@/lib/db");

/**
 * The SAME migration production runs. An earlier hand-copied version of this schema had
 * no options_paper_trades/options_paper_marks at all, so the digest's excursion check
 * could only ever resolve to "unverified" — a fixture in which the verified path was
 * unreachable and therefore untested.
 */
function makeDb() {
  const db = new Database(":memory:");
  applyProductionSchemaOnDb(db);
  return db;
}

/** One case, one alert, one exact OCC — the production linkage. */
function seedCase(db, caseId, occ, symbol = "AAPL") {
  const alertId = `a_${caseId}`;
  db.prepare(
    `INSERT INTO options_alerts (alert_id, candidate_symbol, option_symbol, side, state, created_at_ms, updated_at_ms)
     VALUES (?,?,?,'put','SENT',?,?)`,
  ).run(alertId, symbol, occ, CLOSED_AT, CLOSED_AT);
  db.prepare(
    `INSERT INTO opportunity_cases
       (opportunity_id, underlying_symbol, direction, setup_family, detected_at_ms, market_session,
        source_path, acceptance_decision, delivery_decision, alert_id, case_json, created_at_ms, updated_at_ms)
     VALUES (?,?,'bearish','lower_high',?,'REGULAR','scanner','ACCEPTED','DELIVERED',?,'{}',?,?)`,
  ).run(caseId, symbol, CLOSED_AT, alertId, CLOSED_AT, CLOSED_AT);
}

function seedEvent(db, { id, caseId, eventType, occurredAtMs = CLOSED_AT, symbol = "AAPL", maxReturn = 55.5556, ret = -48.5714 }) {
  db.prepare(
    `INSERT INTO opportunity_content_events
      (id,opportunity_case_id,event_type,symbol,occurred_at_ms,frozen_entry,current_mark,return_percent,
       max_return_percent,direction,option_type,strike,expiration,strategy_key,content_status,created_at_ms)
     VALUES (?,?,?,?,?,3.15,1.62,?,?,'bearish','PUT',305,'2026-08-03','lower_high_continuation','PROCESSED',?)`,
  ).run(id, caseId, eventType, symbol, occurredAtMs, ret, maxReturn, occurredAtMs);
}

function seedHeldDraft(db, { id, eventId, caseId, category, family, createdAtMs, reason = "HELD_FOR_HISTORICAL_DIGEST", status = "SUPPRESSED" }) {
  db.prepare(
    `INSERT INTO content_drafts
       (id, fingerprint, content_event_id, opportunity_case_id, category, template_family, template_version,
        platform, draft_text, char_count, cta_type, result_type, status, discord_delivery_status,
        created_at_ms, updated_at_ms, discord_delivery_reason, discord_delivery_retryable)
     VALUES (?,?,?,?,?,?,'v1','twitter',?,?,'NONE','LOSER','GENERATED',?,?,?,?,0)`,
  ).run(
    id, `fp_${id}`, eventId, caseId, category, family,
    `Why $AAPL failed: ${family}`, 40, status, createdAtMs, createdAtMs, reason,
  );
}

/** The nine-message flood, exactly as oc_4pu17q produced it, but HELD. */
function seedFloodCase(db, caseId = "oc_flood") {
  seedCase(db, caseId, "AAPL260803P00305000");
  const events = [
    { id: "ce_exit", type: "EXIT_HIT", cat: "CLOSED_LOSER" },
    { id: "ce_closed", type: "OPPORTUNITY_CLOSED", cat: "CLOSED_LOSER" },
    { id: "ce_card", type: "OPPORTUNITY_REPORT_CARD_READY", cat: "WHY_THIS_FAILED" },
  ];
  let t = CLOSED_AT;
  for (const e of events) {
    seedEvent(db, { id: e.id, caseId, eventType: e.type });
    for (const family of ["a_0", "b_1", "c_2"]) {
      seedHeldDraft(db, {
        id: `cd_${e.id}_${family}`, eventId: e.id, caseId, category: e.cat,
        family, createdAtMs: (t += 1000),
      });
    }
  }
  return caseId;
}

/**
 * Make a case's peak PROVABLE: give it the frozen contract identity it would really
 * carry, a mirror on that exact contract, and enough same-contract marks to support an
 * extreme. Without this the digest can only ever say "unverified", which is correct but
 * is only half the behaviour worth pinning.
 */
function seedVerifiedPeak(db, caseId, occ, { entry = 3.15, marks = [-10, 55.5556, -48.5714] } = {}) {
  db.prepare("UPDATE opportunity_cases SET case_json=? WHERE opportunity_id=?").run(
    JSON.stringify({
      opportunityId: caseId,
      underlyingSymbol: "AAPL",
      alertId: `a_${caseId}`,
      selectedContract: { optionSymbol: occ, side: "put", strike: 305, expiration: "2026-08-03" },
      frozenTrade: { entryMid: entry, immutable: true },
      summary: { frozenEntry: entry, maxReturnPct: 55.5556 },
    }),
    caseId,
  );
  const info = db.prepare(
    `INSERT INTO options_paper_trades
       (option_symbol, side, strike, expiration, dte, result_class, entry_fill, status,
        paper_kind, alert_id, created_at_ms, updated_at_ms)
     VALUES (?,'put',305,'2026-08-03',0,'REAL_OPTION_PAPER',?,'EXITED','DELIVERED_ALERT_PAPER',?,?,?)`,
  ).run(occ, entry, `a_${caseId}`, CLOSED_AT, CLOSED_AT);
  marks.forEach((ret, i) => {
    db.prepare(
      `INSERT INTO options_paper_marks (trade_id, option_symbol, mark_at_ms, return_pct, created_at_ms)
       VALUES (?,?,?,?,?)`,
    ).run(Number(info.lastInsertRowid), occ, CLOSED_AT + (i + 1) * 60_000, ret, CLOSED_AT);
  });
}

function capture(ok = true) {
  const sent = [];
  return {
    sent,
    deps: {
      now: () => NOW,
      send: async (content) => {
        sent.push(content);
        return ok
          ? { ok: true, messageId: `msg_${sent.length}`, error: null }
          : { ok: false, messageId: null, error: "discord 500", suppressed: false };
      },
    },
  };
}

// ── the collapse ────────────────────────────────────────────────────────────

test("nine held drafts from one closure collapse to exactly one outcome", () => {
  const db = makeDb();
  seedFloodCase(db);
  const rows = readHeldDraftRows(db);
  assert.equal(rows.length, 9, "all nine held drafts are readable");

  const outcomes = groupHeldDraftsIntoOutcomes(rows);
  assert.equal(outcomes.length, 1, "one closure is one outcome");
  assert.equal(outcomes[0].draftIds.length, 9, "no draft is dropped");
  assert.equal(outcomes[0].contentEventIds.length, 3, "all three events are recorded");
  assert.equal(outcomes[0].collapsedVariantCount, 8, "eight duplicate variants collapsed");
});

test("the representative draft is the recommended phrasing of a report category", () => {
  const db = makeDb();
  seedFloodCase(db);
  const [outcome] = groupHeldDraftsIntoOutcomes(readHeldDraftRows(db));
  // Earliest-created draft of an outcome-report category — the same choice
  // individual delivery makes, so the digest cannot show a different draft than
  // the one the owner would have received.
  assert.equal(outcome.representativeDraftId, "cd_ce_exit_a_0");
  assert.ok(outcome.draftIds.includes("cd_ce_card_c_2"), "alternates stay attached, not discarded");
});

test("two contracts on one underlying stay distinct outcomes", () => {
  const db = makeDb();
  seedCase(db, "oc_a", "AAPL260803P00305000");
  seedCase(db, "oc_b", "AAPL260803P00300000");
  seedEvent(db, { id: "ce_a", caseId: "oc_a", eventType: "EXIT_HIT" });
  seedEvent(db, { id: "ce_b", caseId: "oc_b", eventType: "EXIT_HIT" });
  seedHeldDraft(db, { id: "cd_a", eventId: "ce_a", caseId: "oc_a", category: "CLOSED_LOSER", family: "a_0", createdAtMs: CLOSED_AT });
  seedHeldDraft(db, { id: "cd_b", eventId: "ce_b", caseId: "oc_b", category: "CLOSED_LOSER", family: "a_0", createdAtMs: CLOSED_AT });
  assert.equal(groupHeldDraftsIntoOutcomes(readHeldDraftRows(db)).length, 2);
});

test("the exact OCC is read from options_alerts through opportunity_cases", () => {
  const db = makeDb();
  seedFloodCase(db);
  const [row] = readHeldDraftRows(db);
  assert.equal(row.occ, "AAPL260803P00305000");
  assert.equal(contractLabelFor(row), "AAPL260803P00305000");
});

test("a missing OCC shows parts, never a synthesised OCC-looking string", () => {
  const label = contractLabelFor({ occ: null, symbol: "NFLX", optionType: "PUT", strike: 71, expiration: "2026-08-07" });
  assert.equal(label, "NFLX 2026-08-07 $71 PUT");
  assert.ok(!/^[A-Z]+\d{6}[CP]\d{8}$/.test(label), "must not look like a real OCC");
});

// ── exclusions ──────────────────────────────────────────────────────────────

test("an outcome already reported to Discord is excluded with its reason, not silently", () => {
  const db = makeDb();
  const caseId = seedFloodCase(db);
  // One draft for this case genuinely went out individually.
  db.prepare(
    `INSERT INTO content_drafts (id, fingerprint, content_event_id, opportunity_case_id, category,
       template_family, template_version, platform, draft_text, char_count, cta_type, status,
       discord_delivery_status, discord_message_id, created_at_ms, updated_at_ms, discord_delivery_reason)
     VALUES ('cd_sent','fp_sent','ce_exit',?,'CLOSED_LOSER','a_0','v1','twitter','sent',10,'NONE',
             'GENERATED','SENT','snowflake',?,?, 'SENT')`,
  ).run(caseId, CLOSED_AT, CLOSED_AT);

  assert.deepEqual(casesWithDeliveredReportCard(db), [caseId]);
  const digest = buildHistoricalDigest({
    rows: readHeldDraftRows(db), nowMs: NOW,
    casesWithDeliveredReportCard: casesWithDeliveredReportCard(db), env: {},
  });
  assert.equal(digest.included.length, 0);
  assert.equal(digest.excluded.length, 1);
  assert.equal(digest.excluded[0].reason, "ALREADY_DELIVERED_INDIVIDUALLY");
  assert.match(digest.excluded[0].explanation, /already reached Discord/);
});

test("the size cap defers overflow rather than dropping it", () => {
  const db = makeDb();
  for (let i = 0; i < 5; i++) {
    const caseId = `oc_${i}`;
    seedCase(db, caseId, `AAPL26080${i}P0030${i}000`);
    seedEvent(db, { id: `ce_${i}`, caseId, eventType: "EXIT_HIT", occurredAtMs: CLOSED_AT + i * 1000 });
    seedHeldDraft(db, { id: `cd_${i}`, eventId: `ce_${i}`, caseId, category: "CLOSED_LOSER", family: "a_0", createdAtMs: CLOSED_AT });
  }
  const digest = buildHistoricalDigest({
    rows: readHeldDraftRows(db), nowMs: NOW, env: { CONTENT_DIGEST_MAX_OUTCOMES: "2" },
  });
  assert.equal(digest.included.length, 2);
  assert.equal(digest.remainingOutcomes, 3);
  assert.equal(digest.hasMore, true);
  assert.ok(digest.excluded.every((e) => e.reason === "EXCEEDS_DIGEST_SIZE_CAP"));
  assert.equal(digestSizeCap({ CONTENT_DIGEST_MAX_OUTCOMES: "2" }), 2);
});

test("a DELIVERED digest's outcomes are not repeated in the next one", async () => {
  const db = makeDb();
  seedFloodCase(db);
  const first = generateHistoricalDigest(db, { nowMs: NOW, env: {} });
  assert.equal(first.ok, true);
  assert.equal(first.digest.included.length, 1);
  const { deps } = capture();
  assert.equal((await deliverHistoricalDigest(db, first.digest, first.renderedText, deps)).ok, true);
  // Delivery consumes every held row of the included outcome, so the ordinary
  // next run finds nothing at all.
  assert.equal(generateHistoricalDigest(db, { nowMs: NOW + 60_000, env: {} }).reason, "NO_HELD_DRAFTS");

  // A LATE variant of the same closure arrives after the digest went out. The
  // prior-digest guard is what stops it becoming a second report of one outcome.
  seedHeldDraft(db, {
    id: "cd_late", eventId: "ce_exit", caseId: "oc_flood", category: "WHY_THIS_FAILED",
    family: "d_3", createdAtMs: NOW,
  });
  const second = generateHistoricalDigest(db, { nowMs: NOW + 120_000, env: {} });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "ALL_HELD_OUTCOMES_ALREADY_COVERED");
  assert.equal(second.digest.excluded[0].reason, "ALREADY_IN_PRIOR_DIGEST");
});

/**
 * Measured in production at 2047e8e: the scheduled path generated dig_xhf3b4
 * covering 3 outcomes, correctly refused to send it (Discord delivery disabled),
 * and the NEXT candidate then excluded all three as ALREADY_IN_PRIOR_DIGEST. A
 * digest the owner never received was suppressing the one they would have.
 */
test("a generated-but-undelivered digest never locks its outcomes out", () => {
  const db = makeDb();
  seedFloodCase(db);
  const first = generateHistoricalDigest(db, { nowMs: NOW, env: {} });
  assert.equal(first.ok, true);
  assert.equal(
    db.prepare("SELECT delivery_status FROM content_digests WHERE id=?").get(first.digest.digestId).delivery_status,
    "GENERATED",
  );
  assert.deepEqual(priorDigestOutcomeIds(db), [], "an undelivered digest reports nothing as covered");

  const second = generateHistoricalDigest(db, { nowMs: NOW + 60_000, env: {} });
  assert.equal(second.ok, true, "the outcome is still reachable");
  assert.equal(second.digest.included.length, 1);
});

test("regenerating the same outcome set upserts one pending digest, not many", () => {
  const db = makeDb();
  seedFloodCase(db);
  const a = generateHistoricalDigest(db, { nowMs: NOW, env: {} });
  const b = generateHistoricalDigest(db, { nowMs: NOW + 3 * 60_000, env: {} });
  const c = generateHistoricalDigest(db, { nowMs: NOW + 6 * 60_000, env: {} });
  assert.equal(a.digest.digestId, b.digest.digestId);
  assert.equal(b.digest.digestId, c.digest.digestId);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM content_digests").get().n, 1);
  assert.equal(
    db.prepare("SELECT generated_at_ms AS t FROM content_digests WHERE id=?").get(a.digest.digestId).t,
    NOW,
    "the original generation time survives a re-persist",
  );
});

test("a delivered digest is never overwritten by a later regeneration", async () => {
  const db = makeDb();
  seedFloodCase(db);
  const gen = generateHistoricalDigest(db, { nowMs: NOW, env: {} });
  const { deps } = capture();
  await deliverHistoricalDigest(db, gen.digest, gen.renderedText, deps);
  const before = db.prepare("SELECT * FROM content_digests WHERE id=?").get(gen.digest.digestId);
  assert.equal(before.delivery_status, "DELIVERED");
  assert.equal(before.discord_message_id, "msg_1");

  // Force the same content back through persistence.
  db.prepare("UPDATE content_drafts SET discord_delivery_reason='HELD_FOR_HISTORICAL_DIGEST'").run();
  generateHistoricalDigest(db, { nowMs: NOW + 60_000, env: {} });
  const after = db.prepare("SELECT * FROM content_digests WHERE id=?").get(gen.digest.digestId);
  assert.equal(after.delivery_status, "DELIVERED", "delivery evidence survives");
  assert.equal(after.discord_message_id, "msg_1");
  assert.equal(after.delivered_at_ms, NOW);
});

// ── truthful copy ───────────────────────────────────────────────────────────

test("the rendered digest carries the required label and frozen-evidence warning", () => {
  const db = makeDb();
  seedFloodCase(db);
  const digest = buildHistoricalDigest({ rows: readHeldDraftRows(db), nowMs: NOW, env: {} });
  const text = renderHistoricalDigest(digest);
  assert.ok(text.includes(HISTORICAL_DIGEST_LABEL), "label present verbatim");
  assert.ok(text.includes(HISTORICAL_DIGEST_EXPLANATION), "frozen-evidence explanation present verbatim");
  assert.ok(!/\bbuy\b|\bentry now\b|current quote/i.test(text.replace(HISTORICAL_DIGEST_EXPLANATION, "")));
});

test("an unprovable cause is stated as unproven, never as a story", () => {
  const db = makeDb();
  seedCase(db, "oc_x", "AAPL260803P00305000");
  // No max_return_percent recorded: nothing establishes WHY it lost.
  seedEvent(db, { id: "ce_x", caseId: "oc_x", eventType: "EXIT_HIT", maxReturn: null });
  seedHeldDraft(db, { id: "cd_x", eventId: "ce_x", caseId: "oc_x", category: "WHY_THIS_FAILED", family: "a_0", createdAtMs: CLOSED_AT });
  const digest = buildHistoricalDigest({ rows: readHeldDraftRows(db), nowMs: NOW, env: {} });
  assert.equal(digest.included[0].causeProvable, false);
  assert.equal(digest.included[0].causeCode, "INSUFFICIENT_EVIDENCE");
  assert.match(renderHistoricalDigest(digest), /No verified root cause has been established/);
  assert.equal(digest.stats.insufficientEvidenceRootCauses, 1);
  assert.equal(digest.stats.verifiedRootCauses, 0);
});

test("a PROVEN peak far above entry closing red is reported as PROFIT_GIVEN_BACK", () => {
  const db = makeDb();
  const caseId = seedFloodCase(db);
  seedVerifiedPeak(db, caseId, "AAPL260803P00305000");
  const digest = buildHistoricalDigest({ rows: readHeldDraftRows(db), nowMs: NOW, env: {} });
  assert.equal(digest.included[0].maxReturnPercent, 55.5556, "the peak is on the frozen contract");
  assert.equal(digest.included[0].causeCode, "PROFIT_GIVEN_BACK");
  assert.equal(digest.included[0].causeProvable, true);
  assert.equal(digest.stats.verifiedRootCauses, 1);
});

test("an UNPROVEN peak cannot narrate PROFIT_GIVEN_BACK, and the loss still stands", () => {
  const db = makeDb();
  // Identical case with the same +55.5556% stored on the content event — but no mirror
  // and no marks, so nothing the frozen contract printed supports it. This is the shape
  // that published +185.4%: the digest read the ratcheted copy raw and called it
  // "best mark".
  seedFloodCase(db);
  const digest = buildHistoricalDigest({ rows: readHeldDraftRows(db), nowMs: NOW, env: {} });
  const o = digest.included[0];
  assert.equal(o.maxReturnPercent, null, "an unsupported peak is withheld, never the original");
  assert.equal(o.causeCode, "INSUFFICIENT_EVIDENCE");
  assert.equal(o.causeProvable, false);
  // Withholding the peak must not discard the outcome. The realized return is one
  // observation against the frozen entry and reconciles on its own.
  assert.equal(o.result, "LOSER");
  assert.equal(o.returnPercent, -48.5714);
  assert.equal(o.evidenceQuality, "PARTIAL", "less complete evidence, honestly scored");
});

test("a peak the frozen contract never printed is withheld, not quietly reduced", () => {
  const db = makeDb();
  const caseId = seedFloodCase(db);
  // The mirror exists and is well marked, but its best mark is +12%. The case summary
  // still claims +55.5556% — exactly the cross-contract inflation pattern.
  seedVerifiedPeak(db, caseId, "AAPL260803P00305000", { marks: [-10, 12, -48.5714] });
  const digest = buildHistoricalDigest({ rows: readHeldDraftRows(db), nowMs: NOW, env: {} });
  // UNSUPPORTED_MAX_RETURN yields null, NOT the +12% the contract did print. That is the
  // established policy and it is the conservative one: a case whose summary is provably
  // wrong has an identity problem, and quietly swapping in a smaller number would
  // publish a second unaudited figure while looking like a correction.
  assert.equal(
    digest.included[0].maxReturnPercent,
    null,
    "knowing the stored peak is wrong is not knowing the right one",
  );
  assert.notEqual(digest.included[0].maxReturnPercent, 55.5556, "and the inflated value never survives");
});

test("an unrecorded return falls back to the category, not to a loss", () => {
  const db = makeDb();
  seedCase(db, "oc_u", "AAPL260803P00305000");
  seedEvent(db, { id: "ce_u", caseId: "oc_u", eventType: "EXIT_HIT", ret: null, maxReturn: null });
  seedHeldDraft(db, { id: "cd_u", eventId: "ce_u", caseId: "oc_u", category: "MARKET_OBSERVATION", family: "a_0", createdAtMs: CLOSED_AT });
  const digest = buildHistoricalDigest({ rows: readHeldDraftRows(db), nowMs: NOW, env: {} });
  assert.equal(digest.included[0].result, "UNRESOLVED");
  assert.equal(digest.stats.unresolvedOutcomes, 1);
  assert.equal(digest.stats.verifiedLosers, 0);
});

/**
 * Measured in production at 2047e8e. Draft cd_jpfsgi is a CLOSED_WINNER that
 * closed +45.1% ($2.77 -> $4.02), and its result_type is
 * "REALIZED_CLOSED_RETURN" — the MEASUREMENT, not the verdict. A substring test
 * for "LOS" matches the LOS inside "cLOSed", so two winners were both reported
 * as LOSER.
 */
test("result_type naming a measurement never decides win or loss", () => {
  const db = makeDb();
  seedCase(db, "oc_w", "AAPL260805P00305000");
  seedEvent(db, { id: "ce_w", caseId: "oc_w", eventType: "EXIT_HIT", ret: 45.1264, maxReturn: 87.7256 });
  seedHeldDraft(db, { id: "cd_w", eventId: "ce_w", caseId: "oc_w", category: "CLOSED_WINNER", family: "a_0", createdAtMs: CLOSED_AT });
  db.prepare("UPDATE content_drafts SET result_type='REALIZED_CLOSED_RETURN' WHERE id='cd_w'").run();

  const digest = buildHistoricalDigest({ rows: readHeldDraftRows(db), nowMs: NOW, env: {} });
  assert.equal(digest.included[0].result, "WINNER");
  assert.equal(digest.stats.verifiedWinners, 1);
  assert.equal(digest.stats.verifiedLosers, 0);
});

test("a winner is never given a failure cause or counted as unexplained", () => {
  const db = makeDb();
  seedCase(db, "oc_w2", "AAPL260805P00305000");
  seedEvent(db, { id: "ce_w2", caseId: "oc_w2", eventType: "EXIT_HIT", ret: 48.8372, maxReturn: 51.1628 });
  seedHeldDraft(db, { id: "cd_w2", eventId: "ce_w2", caseId: "oc_w2", category: "CLOSED_WINNER", family: "a_0", createdAtMs: CLOSED_AT });
  const digest = buildHistoricalDigest({ rows: readHeldDraftRows(db), nowMs: NOW, env: {} });
  assert.equal(digest.included[0].causeApplicable, false);
  assert.equal(digest.stats.insufficientEvidenceRootCauses, 0, "a winner is not an unexplained loss");
  assert.equal(digest.stats.verifiedRootCauses, 0);
  assert.deepEqual(digest.stats.repeatedFailureCauses, {});
  const text = renderHistoricalDigest(digest);
  assert.ok(!/No verified root cause/.test(text), "no failure narrative under a profitable close");
});

test("a category contradicting the recorded return claims no result at all", () => {
  const db = makeDb();
  seedCase(db, "oc_c", "AAPL260805P00305000");
  seedEvent(db, { id: "ce_c", caseId: "oc_c", eventType: "EXIT_HIT", ret: 45.1264, maxReturn: 87.7256 });
  seedHeldDraft(db, { id: "cd_c", eventId: "ce_c", caseId: "oc_c", category: "CLOSED_LOSER", family: "a_0", createdAtMs: CLOSED_AT });
  const digest = buildHistoricalDigest({ rows: readHeldDraftRows(db), nowMs: NOW, env: {} });
  assert.equal(digest.included[0].result, "UNRESOLVED");
  assert.match(digest.included[0].dataQualityWarning, /disagree/);
  assert.equal(digest.stats.contradictoryOutcomes, 1);
  assert.equal(digest.stats.verifiedWinners, 0);
  assert.equal(digest.stats.verifiedLosers, 0);
  assert.match(renderHistoricalDigest(digest), /Records disagree/);
});

test("the label survives a character budget that truncates the outcome list", () => {
  const db = makeDb();
  for (let i = 0; i < 12; i++) {
    const caseId = `oc_${i}`;
    seedCase(db, caseId, `AAPL2608${String(i).padStart(2, "0")}P00305000`);
    seedEvent(db, { id: `ce_${i}`, caseId, eventType: "EXIT_HIT", occurredAtMs: CLOSED_AT + i * 1000 });
    seedHeldDraft(db, { id: `cd_${i}`, eventId: `ce_${i}`, caseId, category: "CLOSED_LOSER", family: "a_0", createdAtMs: CLOSED_AT });
  }
  const digest = buildHistoricalDigest({ rows: readHeldDraftRows(db), nowMs: NOW, env: {} });
  const text = renderHistoricalDigest(digest, { maxChars: 700 });
  assert.ok(text.length <= 700);
  assert.ok(text.includes(HISTORICAL_DIGEST_LABEL));
  assert.ok(text.includes(HISTORICAL_DIGEST_EXPLANATION));
  assert.match(text, /more in the app/);
});

// ── delivery policy ─────────────────────────────────────────────────────────

test("consuming held rows never raises SENT and never deletes a draft", async () => {
  const db = makeDb();
  seedFloodCase(db);
  const before = db.prepare("SELECT COUNT(*) AS n FROM content_drafts").get().n;
  const sentBefore = db.prepare("SELECT COUNT(*) AS n FROM content_drafts WHERE discord_delivery_status='SENT'").get().n;

  const gen = generateHistoricalDigest(db, { nowMs: NOW, env: {} });
  const { deps, sent } = capture();
  const res = await deliverHistoricalDigest(db, gen.digest, gen.renderedText, deps);

  assert.equal(res.ok, true);
  assert.equal(sent.length, 1, "one message for nine held drafts");
  assert.equal(res.draftsConsumed, 9);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM content_drafts").get().n, before, "no draft deleted");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM content_drafts WHERE discord_delivery_status='SENT'").get().n,
    sentBefore,
    "SENT did not rise because a digest ran",
  );
  const consumed = db.prepare(
    "SELECT COUNT(*) AS n FROM content_drafts WHERE discord_delivery_reason='DELIVERED_IN_HISTORICAL_DIGEST'",
  ).get().n;
  assert.equal(consumed, 9, "held rows moved to a truthful consumed state");
  assert.equal(describeReason("DELIVERED_IN_HISTORICAL_DIGEST").status, "SUPPRESSED");
});

test("a failed digest send leaves the outcomes HELD, not marked as reported", async () => {
  const db = makeDb();
  seedFloodCase(db);
  const gen = generateHistoricalDigest(db, { nowMs: NOW, env: {} });
  const { deps } = capture(false);
  const res = await deliverHistoricalDigest(db, gen.digest, gen.renderedText, deps);

  assert.equal(res.ok, false);
  assert.equal(res.draftsConsumed, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM content_drafts WHERE discord_delivery_reason='HELD_FOR_HISTORICAL_DIGEST'").get().n,
    9,
    "content the owner never received must stay held",
  );
  assert.equal(db.prepare("SELECT delivery_status FROM content_digests WHERE id=?").get(gen.digest.digestId).delivery_status, "FAILED");
});

test("live content outranks the digest in the same scan", async () => {
  const db = makeDb();
  seedFloodCase(db);
  const { deps, sent } = capture();
  const res = await runHistoricalDigestScan(
    db, { ...deps, liveDeliveredThisRun: true }, { CONTENT_DIGEST_DISCORD_ENABLED: "1" },
  );
  assert.equal(res.skippedReason, "LIVE_CONTENT_HAS_PRIORITY");
  assert.equal(res.generated, false);
  assert.equal(sent.length, 0, "the digest must not spend a channel slot ahead of live content");
});

test("Discord delivery is off unless the owner turns it on", async () => {
  const db = makeDb();
  seedFloodCase(db);
  assert.equal(digestDiscordEnabled({}), false);
  const { deps, sent } = capture();
  const res = await runHistoricalDigestScan(db, deps, {});
  assert.equal(res.generated, true, "the digest is still built and stored in the app");
  assert.equal(res.delivered, false);
  assert.equal(res.skippedReason, "DIGEST_DISCORD_DELIVERY_DISABLED");
  assert.equal(sent.length, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM content_drafts WHERE discord_delivery_reason='HELD_FOR_HISTORICAL_DIGEST'").get().n,
    9,
    "generation alone does not consume held rows",
  );
});

test("the minimum interval bounds how often a digest may be delivered", async () => {
  const db = makeDb();
  seedFloodCase(db);
  const env = { CONTENT_DIGEST_DISCORD_ENABLED: "1", CONTENT_DIGEST_MIN_INTERVAL_MS: String(24 * 60 * 60_000) };
  const { deps, sent } = capture();
  const first = await runHistoricalDigestScan(db, deps, env);
  assert.equal(first.delivered, true);
  assert.equal(sent.length, 1);

  // A second case appears an hour later — still inside the interval.
  seedCase(db, "oc_two", "MSFT260803P00305000", "MSFT");
  seedEvent(db, { id: "ce_two", caseId: "oc_two", eventType: "EXIT_HIT", symbol: "MSFT" });
  seedHeldDraft(db, { id: "cd_two", eventId: "ce_two", caseId: "oc_two", category: "CLOSED_LOSER", family: "a_0", createdAtMs: CLOSED_AT });
  const second = await runHistoricalDigestScan(
    db, { ...deps, now: () => NOW + 60 * 60_000 }, env,
  );
  assert.equal(second.delivered, false);
  assert.equal(second.skippedReason, "WITHIN_DIGEST_MIN_INTERVAL");
  assert.equal(sent.length, 1, "no second message inside the interval");
});

test("archive-only rows are excluded from the digest and reported as archived", () => {
  const db = makeDb();
  seedCase(db, "oc_old", "AAPL250101P00305000");
  seedEvent(db, { id: "ce_old", caseId: "oc_old", eventType: "EXIT_HIT", occurredAtMs: NOW - 400 * 24 * 60 * 60_000 });
  seedHeldDraft(db, {
    id: "cd_old", eventId: "ce_old", caseId: "oc_old", category: "CLOSED_LOSER",
    family: "a_0", createdAtMs: CLOSED_AT, reason: "ARCHIVED_IN_APP_ONLY",
  });
  assert.equal(readHeldDraftRows(db, { includeArchive: false }).length, 0, "archive rows are not digest input");
  assert.equal(readHeldDraftRows(db, { includeArchive: true }).length, 1, "but they remain readable");
  const diag = buildDigestDiagnostics(db, {}, NOW);
  assert.equal(diag.heldDigestRows, 0);
  assert.equal(diag.archiveOnlyRows, 1);
});

test("a digest is never generated from an empty backlog", () => {
  const db = makeDb();
  const gen = generateHistoricalDigest(db, { nowMs: NOW, env: {} });
  assert.equal(gen.ok, false);
  assert.equal(gen.reason, "NO_HELD_DRAFTS");
  assert.equal(gen.persisted, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM content_digests").get().n, 0);
});

// ── schema tolerance ────────────────────────────────────────────────────────

test("a legacy database without the reason columns degrades instead of throwing", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE content_drafts (
      id TEXT PRIMARY KEY, content_event_id TEXT, opportunity_case_id TEXT, category TEXT,
      template_family TEXT, template_version TEXT, draft_text TEXT, result_type TEXT,
      frozen_entry REAL, created_at_ms INTEGER, discord_delivery_status TEXT
    );
    CREATE TABLE opportunity_content_events (id TEXT PRIMARY KEY, symbol TEXT, occurred_at_ms INTEGER);
  `);
  assert.deepEqual(readHeldDraftRows(db), []);
  const gen = generateHistoricalDigest(db, { nowMs: NOW, env: {} });
  assert.equal(gen.ok, false);
  assert.equal(gen.reason, "NO_HELD_DRAFTS");
  const diag = buildDigestDiagnostics(db, {}, NOW);
  assert.equal(diag.heldDigestRows, 0);
  assert.equal(diag.digestsGenerated, 0);
});

test("marking consumed touches only included outcomes' held rows", () => {
  const db = makeDb();
  seedFloodCase(db, "oc_in");
  seedCase(db, "oc_out", "MSFT260803P00305000", "MSFT");
  seedEvent(db, { id: "ce_out", caseId: "oc_out", eventType: "EXIT_HIT", symbol: "MSFT" });
  seedHeldDraft(db, { id: "cd_out", eventId: "ce_out", caseId: "oc_out", category: "CLOSED_LOSER", family: "a_0", createdAtMs: CLOSED_AT });

  const digest = buildHistoricalDigest({
    rows: readHeldDraftRows(db), nowMs: NOW, env: { CONTENT_DIGEST_MAX_OUTCOMES: "1" },
  });
  const changed = markDraftsConsumedByDigest(db, digest, NOW);
  assert.equal(changed, digest.included[0].draftIds.length);
  const stillHeld = db.prepare(
    "SELECT COUNT(*) AS n FROM content_drafts WHERE discord_delivery_reason='HELD_FOR_HISTORICAL_DIGEST'",
  ).get().n;
  assert.equal(stillHeld, 10 - changed, "deferred outcomes stay held for the next digest");
});

test("diagnostics count held rows, unique outcomes and duplicates without sending", () => {
  const db = makeDb();
  seedFloodCase(db);
  const diag = buildDigestDiagnostics(db, {}, NOW);
  assert.equal(diag.heldDigestRows, 9);
  assert.equal(diag.uniqueOutcomes, 1);
  assert.equal(diag.digestReadyOutcomes, 1);
  assert.equal(diag.duplicateVariants, 8);
  assert.equal(diag.digestsGenerated, 0, "diagnostics must not persist a digest");
  assert.equal(diag.discordDeliveryEnabled, false);
});
