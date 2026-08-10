/**
 * tests/content-identity-gate.test.mjs
 *
 * A performance draft is a public claim about a trade a subscriber was given. Until
 * now the gate asked only: is there a SENT alert, and does a DELIVERED_ALERT_PAPER
 * mirror's entry price match the alert's frozen entry?
 *
 * Neither question mentions the contract. A case re-selects preferred strikes and
 * expirations for as long as its thesis lives, and the peak accumulated on the case
 * can describe an instrument the subscriber never held. That is how
 *
 *     "Closed: $GOOGL 2026-08-07 $357.50 PUT finished +47.2%.
 *      Frozen entry $2.33. Max favorable move was +185.4% (MFE)."
 *
 * reached Discord when that contract's own 427 marks never printed better than
 * +47.2%. The realized number was right; the peak beside it was not on this trade.
 *
 * These tests pin the gate: prove one contract or publish no number.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { verifyContentClaimForCase } from "../lib/content/claim-integrity.ts";

const NOW = Date.parse("2026-08-07T14:39:40.783Z");
const FROZEN = "O:GOOGL260807P00357500";
const RESELECTED = "O:GOOGL260819P00355000";

function makeDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE options_alerts (
      alert_id TEXT PRIMARY KEY, opportunity_case_id TEXT, state TEXT, entry_mid REAL,
      discord_message_id TEXT, sent_at_ms INTEGER, candidate_symbol TEXT, option_symbol TEXT, side TEXT,
      target_t1 REAL, target_t2 REAL, target_stop REAL, target_method TEXT
    );
    CREATE TABLE options_paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, alert_id TEXT, paper_kind TEXT, entry_fill REAL,
      status TEXT, return_pct REAL, last_mark_return_pct REAL, mfe_pct REAL, mae_pct REAL,
      option_symbol TEXT, side TEXT, strike REAL, expiration TEXT, exit_reason TEXT
    );
    CREATE TABLE options_paper_marks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, trade_id INTEGER, option_symbol TEXT,
      mark_at_ms INTEGER, return_pct REAL
    );
    CREATE TABLE opportunity_cases (
      opportunity_id TEXT PRIMARY KEY, underlying_symbol TEXT, detected_at_ms INTEGER,
      delivery_decision TEXT, case_json TEXT
    );
    CREATE TABLE opportunity_milestones (
      opportunity_case_id TEXT, event_type TEXT, milestone_percent REAL, label TEXT,
      reached_at_ms INTEGER, delivered_at_ms INTEGER
    );
  `);
  return db;
}

/** The GOOGL shape: a real delivered trade whose stored peak overstates the contract. */
function seedGoogl(db, {
  storedMax = 185.4077,
  mirrorOcc = FROZEN,
  markOcc = FROZEN,
  marks = [12.0, 47.2103],
} = {}) {
  db.prepare(
    `INSERT INTO options_alerts (alert_id, opportunity_case_id, state, entry_mid, discord_message_id, sent_at_ms, candidate_symbol, option_symbol, side)
     VALUES ('oa_1a0sp4l','oc_15gylwt','SENT',2.33,'1534978451721814016',?,'GOOGL',?,'put')`,
  ).run(NOW - 76_000_000, FROZEN);
  db.prepare(
    `INSERT INTO options_paper_trades (id, alert_id, paper_kind, entry_fill, status, return_pct, last_mark_return_pct, mfe_pct, mae_pct, option_symbol, side, strike, expiration)
     VALUES (795,'oa_1a0sp4l','DELIVERED_ALERT_PAPER',2.33,'EXITED',47.2103,47.2103,47.2103,-39.7425,?,'put',357.5,'2026-08-07')`,
  ).run(mirrorOcc);
  for (const [i, pct] of marks.entries()) {
    db.prepare("INSERT INTO options_paper_marks (trade_id, option_symbol, mark_at_ms, return_pct) VALUES (795,?,?,?)")
      .run(markOcc, NOW - 60_000 + i * 1000, pct);
  }
  db.prepare(
    `INSERT INTO opportunity_cases (opportunity_id, underlying_symbol, detected_at_ms, delivery_decision, case_json)
     VALUES ('oc_15gylwt','GOOGL',?,'delivered',?)`,
  ).run(NOW - 76_000_000, JSON.stringify({
    schemaVersion: 1,
    opportunityId: "oc_15gylwt",
    underlyingSymbol: "GOOGL",
    alertId: "oa_1a0sp4l",
    selectedContract: { optionSymbol: FROZEN, strike: 357.5, expiration: "2026-08-07" },
    frozenTrade: { entryMid: 2.33, immutable: true },
    summary: {
      frozenEntry: 2.33, currentMark: 3.43, currentReturnPct: 47.2103,
      maxReturnPct: storedMax, currentStatus: "CLOSED",
    },
    contractCandidates: [
      { optionSymbol: FROZEN, observedAtMs: NOW - 76_000_000, reason: "initial_contract" },
      { optionSymbol: RESELECTED, observedAtMs: NOW - 75_000_000, reason: "preferred_contract_reselected" },
    ],
    contractUpdates: [
      { previousOptionSymbol: FROZEN, newOptionSymbol: RESELECTED, changedAtMs: NOW - 75_000_000, reason: "reselected" },
    ],
  }));
}

// ── the claim that reached Discord ──────────────────────────────────────────

test("REPRODUCES IT: the GOOGL peak is stripped, the realized return survives", () => {
  const db = makeDb();
  seedGoogl(db);

  const c = verifyContentClaimForCase(db, "oc_15gylwt", "CLOSED_WINNER");

  // The peak is the thing that was false, and it is the thing that is withheld.
  assert.equal(c.verifiedMaxReturnPct, null, "a peak the contract never printed cannot be printed");
  assert.notEqual(c.verifiedMaxReturnPct, 185.4077);
  assert.ok(c.identityDefects.includes("UNSUPPORTED_MAX_RETURN"));

  // The truthful number is still reported — for diagnosis, not for copy.
  assert.equal(c.observedBestMarkPct, 47.2103);

  // The realized return was never in doubt: it reproduces on the frozen contract, as
  // it does for all 78 delivered cases. Suppressing it to punish the peak would be
  // the same error pointed the other way.
  assert.equal(c.realizedVerified, true);
  assert.equal(c.ok, true, "a valid realized outcome is not discarded for a weak excursion");
});

test("a verified excursion is quotable", () => {
  const db = makeDb();
  seedGoogl(db, { storedMax: 47.2103 });

  const c = verifyContentClaimForCase(db, "oc_15gylwt", "CLOSED_WINNER");
  assert.equal(c.ok, true);
  assert.equal(c.identityVerdict, "SAME_OCC_VERIFIED");
  assert.equal(c.resultType, "REALIZED_CLOSED_RETURN");
  assert.equal(c.realizedVerified, true);
});

// ── the identity failures ───────────────────────────────────────────────────

test("a mirror on a different contract than the alert named is refused", () => {
  const db = makeDb();
  seedGoogl(db, { storedMax: 47.2103, mirrorOcc: RESELECTED, markOcc: RESELECTED });

  const c = verifyContentClaimForCase(db, "oc_15gylwt", "CLOSED_WINNER");
  assert.equal(c.ok, false);
  assert.match(c.reason, /O:GOOGL260819P00355000|identity/i);
});

test("marks taken on a re-selected contract are refused", () => {
  const db = makeDb();
  seedGoogl(db, { storedMax: 47.2103, markOcc: RESELECTED });

  const c = verifyContentClaimForCase(db, "oc_15gylwt", "CLOSED_WINNER");
  assert.equal(c.ok, false);
  assert.equal(c.resultType, "CONTENT_PERFORMANCE_UNVERIFIED");
  assert.ok(c.identityDefects.includes("CROSS_CONTRACT_MARK"));
});

test("a case with no marks at all cannot support a peak", () => {
  const db = makeDb();
  seedGoogl(db, { marks: [] });

  const c = verifyContentClaimForCase(db, "oc_15gylwt", "CLOSED_WINNER");
  // Nothing was ever observed along the way, so no excursion can be claimed. This is
  // the hole the old gate had: it only refused a peak it could prove WRONG, so a case
  // with no marks — nothing to contradict — passed and printed whatever it held.
  assert.equal(c.verifiedMaxReturnPct, null);
  assert.equal(c.excursionState, "INSUFFICIENT_MARKS");
  // The realized return is still evidenced: the mirror is on the frozen contract and
  // carries its own realized return_pct.
  assert.equal(c.realizedVerified, true);
});

test("a mirror carrying neither marks nor a realized return blocks everything", () => {
  const db = makeDb();
  seedGoogl(db, { marks: [] });
  db.prepare("UPDATE options_paper_trades SET return_pct=NULL WHERE id=795").run();

  const c = verifyContentClaimForCase(db, "oc_15gylwt", "CLOSED_WINNER");
  assert.equal(c.ok, false, "with no evidence at all, even the realized return is unprovable");
  assert.equal(c.resultType, "CONTENT_PERFORMANCE_UNVERIFIED");
  assert.equal(c.realizedVerified, false);
  assert.ok(c.identityDefects.includes("NO_PERFORMANCE_MIRROR"));
});

test("a missing opportunity case fails closed rather than defaulting to publishable", () => {
  const db = makeDb();
  seedGoogl(db);
  db.prepare("DELETE FROM opportunity_cases").run();

  const c = verifyContentClaimForCase(db, "oc_15gylwt", "CLOSED_WINNER");
  assert.equal(c.ok, false);
  assert.equal(c.resultType, "CONTENT_PERFORMANCE_UNVERIFIED");
});

// ── what the gate must NOT block ────────────────────────────────────────────

test("non-performance categories are untouched by the identity gate", () => {
  const db = makeDb();
  // No alert, no mirror, no case — an observation makes no numeric claim.
  const c = verifyContentClaimForCase(db, "oc_none", "JUST_ENTERED_RADAR");
  assert.equal(c.ok, true);
  assert.equal(c.resultType, "NON_ACTIONABLE_RESEARCH");
});

test("a loser whose peak is honestly reported still publishes", () => {
  const db = makeDb();
  seedGoogl(db, { storedMax: 12.0, marks: [12.0, -39.7425] });

  const c = verifyContentClaimForCase(db, "oc_15gylwt", "CLOSED_LOSER");
  assert.equal(c.ok, true, "truthful loss copy is the point of the system, not a casualty");
  assert.equal(c.identityVerdict, "SAME_OCC_VERIFIED");
});
