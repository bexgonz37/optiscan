/**
 * tests/owner-mirror-audit.test.mjs
 *
 * An owner alert that leaves no paper mirror is not evidence. On 2026-08-07 three owner
 * CALL openings were delivered — QQQ 10/16 $750C, META 08/14 $600C, SPY 08/21 $777C —
 * and existed only as a Discord row and an opportunity case. 231784c added the mirror,
 * but no live owner opening had exercised it yet.
 *
 * These tests pin what the audit must say: the three pre-fix openings stay permanently
 * without forward evidence and are never reconstructed, and the prospective block —
 * the only one that can judge the fix — counts only openings delivered after it.
 */
import "./helpers/register-alias.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  auditOwnerMirrorsOnDb,
  OWNER_MIRROR_FIX_AT_MS,
} from "../lib/research/options/owner-mirror-audit.ts";

// The fixture is built by the SAME migration production runs. An earlier hand-copied
// version of this schema omitted options_paper_trades.return_pct, so the audit's query
// threw and every mirror silently read as missing — a green test describing a database
// production does not have.
const { applyProductionSchemaOnDb } = await import("@/lib/db");

const BEFORE = OWNER_MIRROR_FIX_AT_MS - 6 * 3_600_000;
const AFTER = OWNER_MIRROR_FIX_AT_MS + 6 * 3_600_000;
const NOW = OWNER_MIRROR_FIX_AT_MS + 24 * 3_600_000;
const QQQ = "O:QQQ261016C00750000";
const OTHER = "O:QQQ261016C00760000";

function db() {
  const d = new Database(":memory:");
  applyProductionSchemaOnDb(d);
  return d;
}

function seedOpening(d, { id, atMs, caseId, occ = QQQ }) {
  const iso = new Date(atMs).toISOString();
  d.prepare(
    `INSERT INTO discord_deliveries
       (delivery_id, channel_type, webhook_name, payload_type, status, created_at, sent_at, opportunity_case_id, lifecycle_state)
     VALUES (?,'owner','owner_private','owner_intraday_actionable','SENT',?,?,?,'OPENING')`,
  ).run(id, iso, iso, caseId);
  d.prepare(
    `INSERT INTO opportunity_cases
       (opportunity_id, underlying_symbol, detected_at_ms, source_path, acceptance_decision,
        delivery_decision, case_json, created_at_ms, updated_at_ms)
     VALUES (?,?,?,'owner_actionable','accepted','delivered',?,?,?)`,
  ).run(caseId, "QQQ", atMs, JSON.stringify({
    opportunityId: caseId,
    selectedContract: occ ? { optionSymbol: occ, side: "call", strike: 750, expiration: "2026-10-16" } : null,
  }), atMs, atMs);
}

function seedMirror(d, { caseId, occ = QQQ, entry = 12.4, marks = 1, status = "ENTERED", returnPct = null }) {
  const info = d.prepare(
    `INSERT INTO options_paper_trades
       (option_symbol, result_class, paper_kind, entry_fill, status, return_pct,
        feature_snapshot_json, created_at_ms, updated_at_ms)
     VALUES (?,'REAL_OPTION_PAPER','OWNER_VALIDATION_PAPER',?,?,?,?,?,?)`,
  ).run(occ, entry, status, returnPct,
    JSON.stringify({ lane: "OWNER_ONLY", opportunityCaseId: caseId }), AFTER, AFTER);
  for (let i = 0; i < marks; i++) {
    d.prepare(
      `INSERT INTO options_paper_marks (trade_id, option_symbol, mark_at_ms, return_pct, created_at_ms)
       VALUES (?,?,?,?,?)`,
    ).run(Number(info.lastInsertRowid), occ, AFTER + i * 1000, i * 3, AFTER);
  }
  return Number(info.lastInsertRowid);
}

// ── the three that can never be fixed ───────────────────────────────────────

test("pre-fix owner openings stay without forward evidence and are never reconstructed", () => {
  const d = db();
  seedOpening(d, { id: "dd_qqq", atMs: BEFORE, caseId: "oc_1m1p4bu" });
  seedOpening(d, { id: "dd_meta", atMs: BEFORE, caseId: "oc_19hkuii" });
  seedOpening(d, { id: "dd_spy", atMs: BEFORE, caseId: "oc_1jd0vu4" });

  const a = auditOwnerMirrorsOnDb(d, { sinceMs: BEFORE - 86_400_000, nowMs: NOW });
  assert.equal(a.ownerOpenings, 3);
  assert.equal(a.missingMirrors, 3);
  assert.equal(a.mirrored, 0);
  for (const o of a.openings) {
    assert.equal(o.state, "NO_FORWARD_PAPER_EVIDENCE");
    assert.equal(o.predatesMirrorFix, true);
    assert.match(o.note, /permanently without forward paper evidence/);
  }
  // They must not drag the prospective verdict down — the fix did not exist yet.
  assert.equal(a.prospective.openings, 0);
  assert.equal(a.prospective.mirrorRate, null, "no post-fix opening yet means unknown, not 0%");
});

// ── what the fix must produce ───────────────────────────────────────────────

test("a post-fix opening mirrored on the exact contract is the target state", () => {
  const d = db();
  seedOpening(d, { id: "dd_new", atMs: AFTER, caseId: "oc_new" });
  seedMirror(d, { caseId: "oc_new" });

  const a = auditOwnerMirrorsOnDb(d, { sinceMs: BEFORE, nowMs: NOW });
  assert.equal(a.openings[0].state, "MIRRORED_EXACT");
  assert.equal(a.prospective.openings, 1);
  assert.equal(a.prospective.mirrorRate, 1);
});

test("a mirror on a different contract than the opening alerted is caught", () => {
  const d = db();
  seedOpening(d, { id: "dd_x", atMs: AFTER, caseId: "oc_x" });
  seedMirror(d, { caseId: "oc_x", occ: OTHER });

  const a = auditOwnerMirrorsOnDb(d, { sinceMs: BEFORE, nowMs: NOW });
  assert.equal(a.occMismatches, 1);
  assert.equal(a.openings[0].state, "MIRROR_OCC_MISMATCH");
  assert.equal(a.prospective.mirrorRate, 0);
});

test("two mirrors for one opening is a duplicate, not a success", () => {
  const d = db();
  seedOpening(d, { id: "dd_d", atMs: AFTER, caseId: "oc_d" });
  seedMirror(d, { caseId: "oc_d" });
  seedMirror(d, { caseId: "oc_d" });

  const a = auditOwnerMirrorsOnDb(d, { sinceMs: BEFORE, nowMs: NOW });
  assert.equal(a.duplicateMirrors, 1);
  assert.equal(a.openings[0].state, "DUPLICATE_MIRROR");
});

test("a mirror with no marks is reported as unmeasured", () => {
  const d = db();
  seedOpening(d, { id: "dd_u", atMs: AFTER, caseId: "oc_u" });
  seedMirror(d, { caseId: "oc_u", marks: 0 });

  const a = auditOwnerMirrorsOnDb(d, { sinceMs: BEFORE, nowMs: NOW });
  assert.equal(a.unmarkedMirrors, 1);
  assert.equal(a.openings[0].state, "MIRRORED_UNMARKED");
});

test("a post-fix opening with no mirror says the fix did not hold", () => {
  const d = db();
  seedOpening(d, { id: "dd_gap", atMs: AFTER, caseId: "oc_gap" });

  const a = auditOwnerMirrorsOnDb(d, { sinceMs: BEFORE, nowMs: NOW });
  assert.equal(a.openings[0].state, "NO_FORWARD_PAPER_EVIDENCE");
  assert.match(a.openings[0].note, /the fix did not hold/);
  assert.equal(a.prospective.mirrorRate, 0);
});

test("an opening with no exact contract cannot be matched and says so", () => {
  const d = db();
  seedOpening(d, { id: "dd_noocc", atMs: AFTER, caseId: "oc_noocc", occ: null });

  const a = auditOwnerMirrorsOnDb(d, { sinceMs: BEFORE, nowMs: NOW });
  assert.equal(a.openings[0].state, "OPENING_OCC_UNKNOWN");
});

test("pre-fix and post-fix openings are judged separately in one window", () => {
  const d = db();
  seedOpening(d, { id: "dd_old", atMs: BEFORE, caseId: "oc_old" });
  seedOpening(d, { id: "dd_new", atMs: AFTER, caseId: "oc_new" });
  seedMirror(d, { caseId: "oc_new" });

  const a = auditOwnerMirrorsOnDb(d, { sinceMs: BEFORE - 86_400_000, nowMs: NOW });
  assert.equal(a.ownerOpenings, 2);
  assert.equal(a.missingMirrors, 1, "the pre-fix opening is still missing");
  assert.equal(a.prospective.openings, 1);
  assert.equal(a.prospective.mirrorRate, 1, "the fix is judged only on what it could affect");
});

test("a database with no deliveries table reports that, not a clean audit", () => {
  const d = new Database(":memory:");
  const a = auditOwnerMirrorsOnDb(d, { nowMs: NOW });
  assert.equal(a.ownerOpenings, 0);
  assert.match(a.note, /discord_deliveries table missing/);
  assert.equal(a.prospective.mirrorRate, null);
});

// ── realized vs trajectory evidence, answered separately ────────────────────

test("a closed owner mirror reports a VERIFIED realized return", () => {
  const d = db();
  seedOpening(d, { id: "dd_win", atMs: AFTER, caseId: "oc_win" });
  seedMirror(d, { caseId: "oc_win", status: "EXITED", returnPct: 47.2103, marks: 5 });

  const a = auditOwnerMirrorsOnDb(d, { sinceMs: BEFORE, nowMs: NOW });
  const o = a.openings[0];
  assert.equal(o.realizedEvidence, "VERIFIED");
  assert.equal(o.realizedReturnPct, 47.2103);
  assert.equal(o.excursionState, "VERIFIED_EXCURSION");
  assert.equal(a.prospective.realizedVerified, 1);
  assert.equal(a.prospective.excursionVerified, 1);
});

test("a realized winner with two marks keeps the win and reports no peak", () => {
  const d = db();
  seedOpening(d, { id: "dd_thin", atMs: AFTER, caseId: "oc_thin" });
  seedMirror(d, { caseId: "oc_thin", status: "EXITED", returnPct: 47.2103, marks: 2 });

  const a = auditOwnerMirrorsOnDb(d, { sinceMs: BEFORE, nowMs: NOW });
  const o = a.openings[0];
  // This is the distinction the nightly must honour: a VERIFIED realized winner whose
  // trajectory was never measured densely enough to place an extreme.
  assert.equal(o.realizedEvidence, "VERIFIED");
  assert.equal(o.realizedReturnPct, 47.2103);
  assert.equal(o.excursionState, "INSUFFICIENT_MARKS");
  assert.equal(o.excursionMfePct, null, "an unmeasured peak is null, never 0");
  assert.equal(o.excursionMaePct, null);
  assert.equal(a.prospective.realizedVerified, 1);
  assert.equal(a.prospective.excursionVerified, 0);
  assert.equal(a.prospective.excursionInsufficient, 1);
});

test("an open owner mirror is STILL_OPEN, not a zero return", () => {
  const d = db();
  seedOpening(d, { id: "dd_open", atMs: AFTER, caseId: "oc_open" });
  seedMirror(d, { caseId: "oc_open", status: "ENTERED", marks: 4 });

  const a = auditOwnerMirrorsOnDb(d, { sinceMs: BEFORE, nowMs: NOW });
  assert.equal(a.openings[0].realizedEvidence, "STILL_OPEN");
  assert.equal(a.openings[0].realizedReturnPct, null);
  assert.equal(a.prospective.realizedStillOpen, 1);
  assert.equal(a.prospective.realizedVerified, 0);
});

test("the prospective block separates marked from unmarked mirrors", () => {
  const d = db();
  seedOpening(d, { id: "dd_m", atMs: AFTER, caseId: "oc_m" });
  seedMirror(d, { caseId: "oc_m", marks: 3 });
  seedOpening(d, { id: "dd_n", atMs: AFTER, caseId: "oc_n" });
  seedMirror(d, { caseId: "oc_n", marks: 0 });

  const a = auditOwnerMirrorsOnDb(d, { sinceMs: BEFORE, nowMs: NOW });
  assert.equal(a.prospective.openings, 2);
  assert.equal(a.prospective.withMarks, 1);
  assert.equal(a.prospective.withoutMarks, 1);
});

test("a mismatched mirror supplies neither realized nor excursion evidence", () => {
  const d = db();
  seedOpening(d, { id: "dd_bad", atMs: AFTER, caseId: "oc_bad" });
  seedMirror(d, { caseId: "oc_bad", occ: OTHER, status: "EXITED", returnPct: 185.4077, marks: 6 });

  const a = auditOwnerMirrorsOnDb(d, { sinceMs: BEFORE, nowMs: NOW });
  const o = a.openings[0];
  assert.equal(o.state, "MIRROR_OCC_MISMATCH");
  assert.equal(o.realizedEvidence, "UNAVAILABLE");
  assert.equal(o.realizedReturnPct, null, "a foreign contract's return is not this opening's");
  assert.equal(o.excursionState, "NO_MIRROR");
  assert.equal(o.excursionMfePct, null);
});
