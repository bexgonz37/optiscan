/**
 * Checkpoint 3 — one canonical verification contract, the delivery-proof join,
 * and parity.
 *
 * The failure these guard against already happened twice: paper-chain and
 * quant-lab each had their own verifier, they disagreed by 471 rows of 553, and
 * the Checkpoint 2 "conservative approximation" turned out to be MORE
 * permissive because it could not see delivery proof.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  verifyOpportunity, compareParity, isQuotable,
  VERIFICATION_STATUSES, OFFICIAL_STATUS,
  VERIFICATION_CONTRACT_VERSION, GRADING_VERSION, DATA_QUALITY_VERSION,
} from "../lib/research/options/verification-contract.ts";
import { buildQuantLabSnapshot } from "../lib/research/options/quant-lab.ts";
import Database from "better-sqlite3";

// ── §1 canonical contract ──────────────────────────────────────────────────

const proven = (over = {}) => ({
  alertPresent: true, alertSentToSubscriber: true, discordMessageIdPresent: true,
  opportunityCasePresent: true, paperMirrorPresent: true, alertPaperLinked: true,
  paperRowCount: 1, entryFillValid: true, exitFillValid: true, exitMarkMatched: true,
  gradingMarkValid: true, occMatches: true, sessionValid: true, returnComputable: true,
  auditOnly: false, ...over,
});

test("a fully proven opportunity is the only thing that reaches official metrics", () => {
  const v = verifyOpportunity(proven());
  assert.equal(v.verificationStatus, "VERIFIED_GRADED");
  assert.equal(v.officialEligible, true);
  assert.equal(v.linkage, "LINKED");
  assert.equal(v.verificationVersion, VERIFICATION_CONTRACT_VERSION);
  assert.equal(v.gradingVersion, GRADING_VERSION);
  assert.equal(v.dataQualityVersion, DATA_QUALITY_VERSION);
  assert.equal(OFFICIAL_STATUS, "VERIFIED_GRADED");
});

test("every declared status is reachable and named", () => {
  const cases = {
    AUDIT_ONLY: proven({ auditOnly: true }),
    MISSING_MIRROR: proven({ paperMirrorPresent: false }),
    DUPLICATE: proven({ paperRowCount: 2 }),
    SESSION_INVALID: proven({ sessionValid: false }),
    WRONG_OCC: proven({ occMatches: false }),
    UNVERIFIED_DELIVERY: proven({ discordMessageIdPresent: false }),
    UNVERIFIED_ENTRY: proven({ entryFillValid: false }),
    INVALID_OR_STALE_MARK: proven({ gradingMarkValid: false }),
    UNVERIFIED_EXIT: proven({ exitMarkMatched: false }),
    UNGRADEABLE: proven({ returnComputable: false }),
    EXCLUDED_OTHER: proven({ paperRowCount: null }),
  };
  for (const [expected, facts] of Object.entries(cases)) {
    const v = verifyOpportunity(facts);
    assert.equal(v.verificationStatus, expected, `expected ${expected}`);
    assert.equal(v.officialEligible, false);
    assert.ok(v.verificationReasons.length > 0, "every exclusion carries a reason");
    assert.ok(VERIFICATION_STATUSES.includes(v.verificationStatus));
  }
});

test("MISSING EVIDENCE IS NEVER PROOF — every null fact fails closed", () => {
  const nullable = [
    "alertPresent", "alertSentToSubscriber", "discordMessageIdPresent",
    "opportunityCasePresent", "paperMirrorPresent", "alertPaperLinked",
    "entryFillValid", "exitFillValid", "exitMarkMatched", "gradingMarkValid",
    "occMatches", "returnComputable",
  ];
  for (const k of nullable) {
    const v = verifyOpportunity(proven({ [k]: null }));
    assert.equal(v.officialEligible, false, `${k}=null must never be treated as proven`);
  }
});

test("paper existence alone does NOT prove delivery", () => {
  // A paper mirror with no Discord message and no case is not a delivered alert.
  const v = verifyOpportunity(proven({ discordMessageIdPresent: false, opportunityCasePresent: false }));
  assert.equal(v.verificationStatus, "UNVERIFIED_DELIVERY");
  assert.equal(v.deliveryVerified, false);
  assert.equal(v.linkage, "DELIVERY_NOT_PROVEN");
});

test("delivery alone does NOT prove a valid trade", () => {
  const v = verifyOpportunity(proven({ entryFillValid: false }));
  assert.equal(v.deliveryVerified, true, "delivery really was proven");
  assert.equal(v.verificationStatus, "UNVERIFIED_ENTRY", "and the trade is still rejected");
});

test("precedence is worst-cause-first so exclusions never double-count", () => {
  const v = verifyOpportunity(proven({
    paperMirrorPresent: false, paperRowCount: 3, entryFillValid: false, occMatches: false,
  }));
  assert.equal(v.verificationStatus, "MISSING_MIRROR");
});

test("an absent alerts table is LEGACY_UNLINKABLE, not a false negative link", () => {
  const v = verifyOpportunity(proven({ alertPresent: null }));
  assert.equal(v.linkage, "LEGACY_UNLINKABLE");
  assert.equal(v.verificationStatus, "AUDIT_ONLY");
});

test("quotability is a gate over parity, sample, fraction AND mark quality", () => {
  const pass = isQuotable({ parityStatus: "EXACT_PARITY", verifiedCount: 60, verifiedFraction: 0.9, independentMarkRate: 0.6 });
  assert.equal(pass.quotable, true);
  assert.deepEqual(pass.blockers, []);

  // The live production condition: parity unknown, marks at 23.4%.
  const live = isQuotable({ parityStatus: "NOT_COMPARABLE", verifiedCount: 276, verifiedFraction: 0.773, independentMarkRate: 0.234 });
  assert.equal(live.quotable, false);
  assert.equal(live.blockers.length, 3, "parity, fraction and mark rate all block");
  assert.ok(live.blockers.some((b) => /independent mark rate/.test(b)));
});

test("an unknown independent mark rate blocks rather than passes", () => {
  const r = isQuotable({ parityStatus: "EXACT_PARITY", verifiedCount: 100, verifiedFraction: 1, independentMarkRate: null });
  assert.equal(r.quotable, false);
});

// ── §3 parity ──────────────────────────────────────────────────────────────

test("identical classifications are EXACT_PARITY", () => {
  const r = compareParity([
    { key: "a", quantLabStatus: "VERIFIED_GRADED", paperChainStatus: "VERIFIED_GRADED" },
    { key: "b", quantLabStatus: "DUPLICATE", paperChainStatus: "DUPLICATE" },
  ]);
  assert.equal(r.parityStatus, "EXACT_PARITY");
  assert.equal(r.matchingRows, 2);
  assert.equal(r.mismatchingRows, 0);
});

test("a row valid in one system and excluded in the other is UNEXPLAINED", () => {
  // This is exactly the Checkpoint 2 defect and it must never be tolerated.
  const r = compareParity([
    { key: "a", quantLabStatus: "VERIFIED_GRADED", paperChainStatus: "UNVERIFIED_DELIVERY" },
  ]);
  assert.equal(r.parityStatus, "UNEXPLAINED_DIFFERENCE");
  assert.equal(r.onlyValidInQuantLab, 1);
  assert.equal(r.mismatchReasons[0].count, 1);
  assert.match(r.note, /non-quotable/);
});

test("differing exclusion reasons on both sides are EXPLAINED, not unexplained", () => {
  const r = compareParity([
    { key: "a", quantLabStatus: "DUPLICATE", paperChainStatus: "MISSING_MIRROR" },
  ]);
  assert.equal(r.parityStatus, "EXPLAINED_DIFFERENCE", "neither system called it valid");
  assert.equal(r.onlyValidInQuantLab, 0);
  assert.equal(r.onlyValidInPaperChain, 0);
});

test("population differences are reported separately from classification differences", () => {
  const r = compareParity([
    { key: "a", quantLabStatus: "VERIFIED_GRADED", paperChainStatus: null },
    { key: "b", quantLabStatus: null, paperChainStatus: "VERIFIED_GRADED" },
  ]);
  assert.equal(r.populationOnlyInQuantLab, 1);
  assert.equal(r.populationOnlyInPaperChain, 1);
  assert.equal(r.comparedRows, 0, "rows absent from one side are not 'compared'");
  assert.equal(r.parityStatus, "NOT_COMPARABLE");
});

test("unlinked rows are counted", () => {
  const r = compareParity([
    { key: "a", quantLabStatus: "AUDIT_ONLY", paperChainStatus: "AUDIT_ONLY", linkage: "NO_ALERT_LINK" },
    { key: "b", quantLabStatus: "VERIFIED_GRADED", paperChainStatus: "VERIFIED_GRADED", linkage: "LINKED" },
  ]);
  assert.equal(r.unlinkedRows, 1);
});

// ── §2 the join, end to end ────────────────────────────────────────────────

function schema(db) {
  db.exec(`
    CREATE TABLE options_paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT, side TEXT, dte INTEGER,
      status TEXT, entry_fill REAL, exit_fill REAL, exit_at_ms INTEGER, return_pct REAL,
      mfe_pct REAL, mae_pct REAL, exit_reason TEXT, strategy TEXT, strategy_family TEXT,
      paper_kind TEXT, alert_id TEXT, feature_snapshot_json TEXT, time_bucket TEXT,
      market_regime TEXT, contract_moneyness TEXT, delta_band TEXT, exit_policy_version TEXT,
      entered_at_ms INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER
    );
    CREATE TABLE options_paper_marks (
      trade_id INTEGER, option_symbol TEXT, mark_at_ms INTEGER, bid REAL, ask REAL,
      exit_fill REAL, return_pct REAL, quote_age_ms INTEGER, created_at_ms INTEGER
    );
    CREATE TABLE options_alerts (
      alert_id TEXT PRIMARY KEY, candidate_symbol TEXT, state TEXT, research_only INTEGER,
      paper_linked INTEGER, discord_message_id TEXT, opportunity_case_id TEXT,
      option_symbol TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, sent_at_ms INTEGER
    );
  `);
}

function seed(db, { alertId, occ = "O:SPY260727C00500000", returnPct = 10, alert = {}, mark = true, exited = true }) {
  const now = Date.now();
  db.prepare(`INSERT INTO options_paper_trades
    (option_symbol, side, dte, status, entry_fill, exit_fill, exit_at_ms, return_pct, mfe_pct, mae_pct,
     exit_reason, strategy, strategy_family, paper_kind, alert_id, feature_snapshot_json,
     time_bucket, market_regime, contract_moneyness, delta_band, exit_policy_version,
     entered_at_ms, created_at_ms, updated_at_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(occ, "call", 1, exited ? "EXITED" : "ENTERED", 1.0, 1.1, now, returnPct, 20, -8,
      "target_hit", "momentum", "fam", "DELIVERED_ALERT_PAPER", alertId, JSON.stringify({ qualityScore: 0.8 }),
      "open_drive", "trend", "ATM", "0.40-0.50", "fixed_r", now - 60_000, now, now);
  const id = Number(db.prepare("SELECT last_insert_rowid() id").get().id);
  if (mark) {
    db.prepare(`INSERT INTO options_paper_marks
      (trade_id, option_symbol, mark_at_ms, bid, ask, exit_fill, return_pct, quote_age_ms, created_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(id, occ, now, 1.05, 1.15, 1.1, returnPct, 1000, now);
  }
  if (alertId) {
    db.prepare(`INSERT OR IGNORE INTO options_alerts
      (alert_id, candidate_symbol, state, research_only, paper_linked, discord_message_id,
       opportunity_case_id, option_symbol, created_at_ms, updated_at_ms, sent_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(alertId, "SPY", alert.state ?? "SENT", alert.research_only ?? 0, alert.paper_linked ?? 1,
        "discord_message_id" in alert ? alert.discord_message_id : "dm_1",
        "opportunity_case_id" in alert ? alert.opportunity_case_id : "oc_1",
        alert.option_symbol ?? occ, now, now, now);
  }
  return id;
}

test("a fully linked, delivered, marked trade is VERIFIED and official", () => {
  const db = new Database(":memory:");
  schema(db);
  seed(db, { alertId: "al_1" });
  const s = buildQuantLabSnapshot(db, {});
  assert.equal(s.verification.byStatus.VERIFIED_GRADED, 1);
  assert.equal(s.verification.byLinkage.LINKED, 1);
  assert.equal(s.lanes.delivered.sampleSize, 1);
  db.close();
});

test("a paper row with NO alert link is excluded — paper does not prove delivery", () => {
  const db = new Database(":memory:");
  schema(db);
  seed(db, { alertId: null });
  const s = buildQuantLabSnapshot(db, {});
  assert.equal(s.lanes.delivered.sampleSize, 0);
  assert.equal(s.lanes.delivered_unverified.sampleSize, 1, "still visible");
  assert.equal(s.verification.byStatus.AUDIT_ONLY, 1);
  assert.equal(s.verification.byLinkage.NO_ALERT_LINK, 1);
  db.close();
});

test("an alert that was never SENT to a subscriber is excluded", () => {
  const db = new Database(":memory:");
  schema(db);
  seed(db, { alertId: "al_1", alert: { state: "PENDING" } });
  const s = buildQuantLabSnapshot(db, {});
  assert.equal(s.lanes.delivered.sampleSize, 0);
  assert.equal(s.verification.byStatus.UNVERIFIED_DELIVERY, 1);
  db.close();
});

test("a research_only alert is excluded from subscriber performance", () => {
  const db = new Database(":memory:");
  schema(db);
  seed(db, { alertId: "al_1", alert: { research_only: 1 } });
  const s = buildQuantLabSnapshot(db, {});
  assert.equal(s.lanes.delivered.sampleSize, 0);
  db.close();
});

test("a missing Discord message id excludes the row", () => {
  const db = new Database(":memory:");
  schema(db);
  seed(db, { alertId: "al_1", alert: { discord_message_id: null } });
  const s = buildQuantLabSnapshot(db, {});
  assert.equal(s.verification.byStatus.UNVERIFIED_DELIVERY, 1);
  db.close();
});

test("an OCC mismatch between alert and paper excludes the row", () => {
  const db = new Database(":memory:");
  schema(db);
  seed(db, { alertId: "al_1", occ: "O:SPY260727C00500000", alert: { option_symbol: "O:SPY260727C00999000" } });
  const s = buildQuantLabSnapshot(db, {});
  assert.equal(s.verification.byStatus.WRONG_OCC, 1);
  assert.equal(s.verification.byLinkage.OCC_MISMATCH, 1);
  db.close();
});

test("a trade with no marks is INVALID_OR_STALE_MARK", () => {
  const db = new Database(":memory:");
  schema(db);
  seed(db, { alertId: "al_1", mark: false });
  const s = buildQuantLabSnapshot(db, {});
  assert.equal(s.verification.byStatus.INVALID_OR_STALE_MARK, 1);
  db.close();
});

test("both halves of a duplicated alert are excluded", () => {
  const db = new Database(":memory:");
  schema(db);
  seed(db, { alertId: "al_dup", returnPct: 10 });
  seed(db, { alertId: "al_dup", returnPct: -80 });
  const s = buildQuantLabSnapshot(db, {});
  assert.equal(s.lanes.delivered.sampleSize, 0);
  assert.equal(s.verification.byStatus.DUPLICATE, 2);
  db.close();
});

test("an unverified loss cannot move the official median", () => {
  const db = new Database(":memory:");
  schema(db);
  seed(db, { alertId: "al_1", occ: "O:SPY260727C00500000", returnPct: 10 });
  seed(db, { alertId: null, occ: "O:QQQ260727P00480000", returnPct: -95 });
  const s = buildQuantLabSnapshot(db, {});
  assert.equal(s.lanes.delivered.metrics.medianReturn, 10);
  assert.ok(s.lanes.delivered_unverified.metrics.medianReturn < 0);
  db.close();
});

test("official performance stays NON-QUOTABLE with its blockers named", () => {
  const db = new Database(":memory:");
  schema(db);
  seed(db, { alertId: "al_1" });
  const s = buildQuantLabSnapshot(db, {});
  assert.equal(s.verification.quotable, false);
  assert.ok(s.verification.quotableBlockers.length > 0);
  assert.ok(s.verification.quotableBlockers.some((b) => /independent mark rate/.test(b)));
  assert.equal(s.verification.contractVersion, VERIFICATION_CONTRACT_VERSION);
  db.close();
});

// ── boundaries ─────────────────────────────────────────────────────────────

test("the contract is pure — no DB, network, env, AI, or broker path", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("lib/research/options/verification-contract.ts", "utf8");
  for (const banned of ["require(", "fetch(", "prepare(", "process.env", "openai", "anthropic", "broker", "webhook"]) {
    assert.equal(src.toLowerCase().includes(banned.toLowerCase()), false, `${banned} must not appear`);
  }
});


test("quant-lab reads only; it issues no provider call", async () => {
  const { readFileSync } = await import("node:fs");
  const raw = readFileSync("lib/research/options/quant-lab.ts", "utf8");
  // Comment lines are stripped by prefix rather than by regex: a diagnostic may
  // legitimately NAME Polygon in prose, it just must never CALL it.
  const code = raw
    .split("\n")
    .filter((line) => {
      const t = line.trimStart();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n")
    .toLowerCase();
  for (const banned of ["fetch(", "fetchoptionchain", "fetchoptioncontractsnapshot", "polyrequest"]) {
    assert.equal(code.includes(banned), false, `${banned} must not appear in a diagnostic`);
  }
  for (const write of ["insert into", "update options_", "delete from"]) {
    assert.equal(code.includes(write), false, `quant-lab must never write (${write})`);
  }
});
