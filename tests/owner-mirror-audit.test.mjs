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
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  auditOwnerMirrorsOnDb,
  OWNER_MIRROR_FIX_AT_MS,
} from "../lib/research/options/owner-mirror-audit.ts";

const BEFORE = OWNER_MIRROR_FIX_AT_MS - 6 * 3_600_000;
const AFTER = OWNER_MIRROR_FIX_AT_MS + 6 * 3_600_000;
const NOW = OWNER_MIRROR_FIX_AT_MS + 24 * 3_600_000;
const QQQ = "O:QQQ261016C00750000";
const OTHER = "O:QQQ261016C00760000";

function db() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE discord_deliveries (
      delivery_id TEXT PRIMARY KEY, payload_type TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, sent_at TEXT, payload_json TEXT,
      opportunity_case_id TEXT, thesis_fingerprint TEXT, lifecycle_state TEXT
    );
    CREATE TABLE opportunity_cases (
      opportunity_id TEXT PRIMARY KEY, underlying_symbol TEXT, detected_at_ms INTEGER,
      delivery_decision TEXT, case_json TEXT
    );
    CREATE TABLE options_paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT, paper_kind TEXT,
      entry_fill REAL, status TEXT, feature_snapshot_json TEXT
    );
    CREATE TABLE options_paper_marks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, trade_id INTEGER, option_symbol TEXT,
      mark_at_ms INTEGER, return_pct REAL
    );
  `);
  return d;
}

function seedOpening(d, { id, atMs, caseId, occ = QQQ }) {
  const iso = new Date(atMs).toISOString();
  d.prepare(
    `INSERT INTO discord_deliveries (delivery_id, payload_type, status, created_at, sent_at, opportunity_case_id, lifecycle_state)
     VALUES (?,'owner_intraday_actionable','SENT',?,?,?,'OPENING')`,
  ).run(id, iso, iso, caseId);
  d.prepare(
    "INSERT INTO opportunity_cases (opportunity_id, underlying_symbol, detected_at_ms, delivery_decision, case_json) VALUES (?,?,?,?,?)",
  ).run(caseId, "QQQ", atMs, "delivered", JSON.stringify({
    opportunityId: caseId,
    selectedContract: occ ? { optionSymbol: occ, side: "call", strike: 750, expiration: "2026-10-16" } : null,
  }));
}

function seedMirror(d, { caseId, occ = QQQ, entry = 12.4, marks = 1 }) {
  const info = d.prepare(
    `INSERT INTO options_paper_trades (option_symbol, paper_kind, entry_fill, status, feature_snapshot_json)
     VALUES (?,'OWNER_VALIDATION_PAPER',?,'ENTERED',?)`,
  ).run(occ, entry, JSON.stringify({ lane: "OWNER_ONLY", opportunityCaseId: caseId }));
  for (let i = 0; i < marks; i++) {
    d.prepare("INSERT INTO options_paper_marks (trade_id, option_symbol, mark_at_ms, return_pct) VALUES (?,?,?,?)")
      .run(Number(info.lastInsertRowid), occ, AFTER + i * 1000, i * 3);
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
