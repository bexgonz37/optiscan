/**
 * The nightly recap reports what Discord actually sent, and labels everything else.
 *
 * The heading being replaced -- "OWNER DISCORD ALERTS -- the alerts you actually received"
 * -- sat above statistics computed from OWNER_VALIDATION_PAPER mirrors. A mirror is written
 * after the send result without reading it, so it exists for a suppressed opening too. On
 * 2026-08-20 production wrote ten owner openings, SUPPRESSED all ten, mirrored most, and
 * that heading would have called it a ten-alert day.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { buildOwnerDeliveryReconciliationOnDb } from "../lib/research/options/owner-delivery-reconciliation.ts";
import { loadOwnerDeliveryLedgerOnDb } from "../lib/notifications/owner-delivery-truth.ts";
import { OPPORTUNITY_CASE_SCHEMA_VERSION } from "../lib/opportunity-case/schema.ts";

const SESSION = "2026-08-20";
const ENTERED = Date.parse("2026-08-20T17:30:00.000Z"); // 1:30 p.m. ET
const EXITED = Date.parse("2026-08-20T18:30:00.000Z");

function db() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE options_paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      option_symbol TEXT NOT NULL, side TEXT, strike REAL, expiration TEXT, dte INTEGER,
      strategy TEXT, status TEXT NOT NULL, entry_fill REAL, exit_fill REAL, return_pct REAL,
      exit_reason TEXT, entered_at_ms INTEGER, exit_at_ms INTEGER, session TEXT,
      paper_kind TEXT, alert_id TEXT, feature_snapshot_json TEXT, created_at_ms INTEGER
    );
    CREATE TABLE options_paper_marks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, trade_id INTEGER NOT NULL, option_symbol TEXT NOT NULL,
      mark_at_ms INTEGER NOT NULL, bid REAL, ask REAL, exit_fill REAL, return_pct REAL,
      quote_age_ms INTEGER, created_at_ms INTEGER NOT NULL, UNIQUE(trade_id, mark_at_ms)
    );
    CREATE TABLE opportunity_cases (
      opportunity_id TEXT PRIMARY KEY, underlying_symbol TEXT, direction TEXT, setup_family TEXT,
      detected_at_ms INTEGER, alert_id TEXT, case_json TEXT
    );
    CREATE TABLE discord_deliveries (
      delivery_id TEXT PRIMARY KEY, alert_id INTEGER, channel_type TEXT NOT NULL,
      webhook_name TEXT NOT NULL, payload_type TEXT NOT NULL, payload_preview TEXT,
      payload_json TEXT, idempotency_key TEXT UNIQUE, created_at TEXT NOT NULL,
      attempted_at TEXT, sent_at TEXT, status TEXT NOT NULL, http_status INTEGER,
      response_body_safe TEXT, failure_reason TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT, opportunity_case_id TEXT, thesis_fingerprint TEXT,
      lifecycle_state TEXT, delivery_context_json TEXT
    );
  `);
  return d;
}

let n = 0;

/** A tracked owner callout: case + exact-OCC mirror + marks. Returns its case id. */
function callout(d, { caseId, returnPct = 40, status = "EXITED", symbol = "SPY" } = {}) {
  n += 1;
  const occ = `O:${symbol}260826C0064000${n % 10}`;
  d.prepare(
    "INSERT INTO opportunity_cases (opportunity_id, underlying_symbol, direction, setup_family, detected_at_ms, alert_id, case_json) VALUES (?,?,?,?,?,?,?)",
  ).run(caseId, symbol, "bullish", "sr_reclaim", ENTERED, null, JSON.stringify({
    schemaVersion: OPPORTUNITY_CASE_SCHEMA_VERSION,
    underlyingSymbol: symbol,
    setupFamily: "sr_reclaim",
    sessionDate: SESSION,
    opportunityFingerprint: `of_${caseId}`,
    thesisFingerprint: `tf_${caseId}`,
    selectedContract: { optionSymbol: occ, side: "CALL", strike: 640, expiration: "2026-08-26" },
    frozenTrade: { entryMid: 1.25, targetT1: 1.55, targetT2: 1.9, stop: 0.95 },
    summary: { frozenEntry: 1.25 },
  }));
  const info = d.prepare(
    `INSERT INTO options_paper_trades
      (option_symbol, side, strike, expiration, dte, strategy, status, entry_fill, exit_fill,
       return_pct, exit_reason, entered_at_ms, exit_at_ms, session, paper_kind, alert_id,
       feature_snapshot_json, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    occ, "call", 640, "2026-08-26", 6, "sr_reclaim", status, 1.25,
    status === "EXITED" ? 1.25 * (1 + returnPct / 100) : null,
    status === "EXITED" ? returnPct : null,
    status === "EXITED" ? (returnPct > 0 ? "target_hit" : "stop_hit") : null,
    ENTERED, status === "EXITED" ? EXITED : null, "REGULAR", "OWNER_VALIDATION_PAPER", null,
    JSON.stringify({ lane: "OWNER_ONLY", opportunityCaseId: caseId, quality: 0.81 }), ENTERED,
  );
  d.prepare(
    "INSERT INTO options_paper_marks (trade_id, option_symbol, mark_at_ms, bid, ask, exit_fill, return_pct, quote_age_ms, created_at_ms) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(info.lastInsertRowid, occ, ENTERED + 60_000, 1.3, 1.34, 1.31, 4.8, 500, ENTERED + 60_000);
  return caseId;
}

function ledgerRow(d, { caseId, status, reason = null }) {
  n += 1;
  d.prepare(
    `INSERT INTO discord_deliveries
      (delivery_id, channel_type, webhook_name, payload_type, payload_json, idempotency_key,
       created_at, sent_at, status, failure_reason, opportunity_case_id, thesis_fingerprint, lifecycle_state)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    `dd_${n}`, "discord_webhook", "options", "owner_intraday_actionable",
    JSON.stringify({ content: `${caseId ?? "unknown"} opening` }), `k_${n}`,
    "2026-08-20T17:30:00.000Z",
    status === "SENT" ? "2026-08-20T17:30:00.000Z" : null,
    status, reason, caseId, "tf", "OPENING",
  );
}

test("DELIVERED TO YOU reconciles exactly with the ledger SENT rows", () => {
  const d = db();
  callout(d, { caseId: "oc_sent1", returnPct: 60 });
  callout(d, { caseId: "oc_sent2", returnPct: -30 });
  callout(d, { caseId: "oc_supp1", returnPct: 100 });
  ledgerRow(d, { caseId: "oc_sent1", status: "SENT" });
  ledgerRow(d, { caseId: "oc_sent2", status: "SENT" });
  ledgerRow(d, { caseId: "oc_supp1", status: "SUPPRESSED", reason: "owner_watch_discord_suppressed" });

  const r = buildOwnerDeliveryReconciliationOnDb(d, { sessionDate: SESSION });
  const ledger = loadOwnerDeliveryLedgerOnDb(d, { sessionDate: SESSION });

  assert.equal(r.reconciles, true);
  assert.equal(r.deliveredToYou.length, ledger.delivered.length);
  assert.equal(r.deliveredToYou.length, 2);
  assert.deepEqual(
    r.deliveredToYou.map((x) => x.opportunityCaseId).sort(),
    ["oc_sent1", "oc_sent2"],
  );
  d.close();
});

test("suppressed rows are excluded from delivered statistics", () => {
  const d = db();
  callout(d, { caseId: "oc_sent1", returnPct: 60 });
  callout(d, { caseId: "oc_sent2", returnPct: -30 });
  // A +100% winner the owner NEVER saw. If it leaked in, the delivered expectancy would
  // read +43.3% instead of +15%.
  callout(d, { caseId: "oc_supp1", returnPct: 100 });
  ledgerRow(d, { caseId: "oc_sent1", status: "SENT" });
  ledgerRow(d, { caseId: "oc_sent2", status: "SENT" });
  ledgerRow(d, { caseId: "oc_supp1", status: "SUPPRESSED", reason: "owner_watch_discord_suppressed" });

  const r = buildOwnerDeliveryReconciliationOnDb(d, { sessionDate: SESSION });
  assert.equal(r.deliveredStats.closed, 2);
  assert.equal(r.deliveredStats.wins, 1);
  assert.equal(r.deliveredStats.losses, 1);
  assert.equal(r.deliveredStats.expectancyPct, 15);
  assert.equal(r.deliveredStats.bestPct, 60, "the suppressed +100% is not the delivered best");
  assert.equal(r.deliveredStats.profitFactor, 2);
  d.close();
});

test("internal paper rows are never represented as delivered alerts", () => {
  const d = db();
  callout(d, { caseId: "oc_sent1", returnPct: 60 });
  callout(d, { caseId: "oc_supp1", returnPct: 100 });
  callout(d, { caseId: "oc_supp2", returnPct: -20 });
  ledgerRow(d, { caseId: "oc_sent1", status: "SENT" });
  ledgerRow(d, { caseId: "oc_supp1", status: "SUPPRESSED", reason: "owner_watch_discord_suppressed" });
  ledgerRow(d, { caseId: "oc_supp2", status: "SUPPRESSED", reason: "owner_watch_discord_suppressed" });

  const r = buildOwnerDeliveryReconciliationOnDb(d, { sessionDate: SESSION });
  assert.equal(r.deliveredStats.tracked, 1);
  assert.equal(r.internalPaperStats.tracked, 2);
  assert.match(r.internalPaperStats.population, /INTERNAL \/ PAPER/);
  assert.match(r.internalPaperStats.population, /no Discord message/);
  assert.match(r.deliveredStats.population, /DELIVERED TO YOU/);
  // Disjoint: no case can be in both populations.
  assert.equal(r.deliveredStats.tracked + r.internalPaperStats.tracked, 3);
  d.close();
});

test("the all-suppressed day reports zero delivered, not a full day of alerts", () => {
  const d = db();
  // The shape of production on 2026-08-20.
  for (let i = 0; i < 10; i += 1) {
    const id = `oc_s${i}`;
    callout(d, { caseId: id, returnPct: 25 });
    ledgerRow(d, { caseId: id, status: "SUPPRESSED", reason: "owner_watch_discord_suppressed" });
  }
  const r = buildOwnerDeliveryReconciliationOnDb(d, { sessionDate: SESSION });
  assert.equal(r.deliveredToYou.length, 0, "nothing was delivered, so nothing is claimed");
  assert.equal(r.deliveredStats.closed, 0);
  assert.equal(r.deliveredStats.expectancyPct, null, "no delivered trades means no expectancy");
  assert.equal(r.notSent.length, 10);
  assert.equal(r.notSentByReason.owner_watch_discord_suppressed, 10);
  assert.equal(r.internalPaperStats.tracked, 10, "the evidence survives, labelled INTERNAL");
  d.close();
});

test("a delivered opening with no tracking row is surfaced, not dropped", () => {
  const d = db();
  callout(d, { caseId: "oc_tracked", returnPct: 30 });
  ledgerRow(d, { caseId: "oc_tracked", status: "SENT" });
  // Delivered, and nothing is tracking it.
  ledgerRow(d, { caseId: "oc_orphan", status: "SENT" });

  const r = buildOwnerDeliveryReconciliationOnDb(d, { sessionDate: SESSION });
  assert.equal(r.deliveredToYou.length, 2, "both delivered openings are reported");
  assert.equal(r.orphanedDeliveries.length, 1);
  assert.equal(r.orphanedDeliveries[0].opportunityCaseId, "oc_orphan");
  assert.equal(r.orphanedDeliveries[0].tracked, false);
  // The orphan contributes no performance figure, because there is none to contribute.
  assert.equal(r.deliveredStats.closed, 1);
  d.close();
});

test("a delivered row carrying no case id is counted, never silently dropped", () => {
  const d = db();
  ledgerRow(d, { caseId: null, status: "SENT" });
  const r = buildOwnerDeliveryReconciliationOnDb(d, { sessionDate: SESSION });
  assert.equal(r.deliveredToYou.length, 1);
  assert.equal(r.deliveriesWithoutCaseIdentity, 1);
  assert.equal(r.orphanedDeliveries.length, 0, "an unidentifiable row is not an orphan claim");
  d.close();
});

test("no delivery ledger reports unavailable rather than substituting the mirrors", () => {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE options_paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT NOT NULL, side TEXT, strike REAL,
      expiration TEXT, dte INTEGER, strategy TEXT, status TEXT NOT NULL, entry_fill REAL,
      exit_fill REAL, return_pct REAL, exit_reason TEXT, entered_at_ms INTEGER, exit_at_ms INTEGER,
      session TEXT, paper_kind TEXT, alert_id TEXT, feature_snapshot_json TEXT, created_at_ms INTEGER
    );
    CREATE TABLE options_paper_marks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, trade_id INTEGER NOT NULL, option_symbol TEXT NOT NULL,
      mark_at_ms INTEGER NOT NULL, bid REAL, ask REAL, exit_fill REAL, return_pct REAL,
      quote_age_ms INTEGER, created_at_ms INTEGER NOT NULL, UNIQUE(trade_id, mark_at_ms)
    );
    CREATE TABLE opportunity_cases (
      opportunity_id TEXT PRIMARY KEY, underlying_symbol TEXT, direction TEXT, setup_family TEXT,
      detected_at_ms INTEGER, alert_id TEXT, case_json TEXT
    );
  `);
  callout(d, { caseId: "oc_only_mirror", returnPct: 80 });
  const r = buildOwnerDeliveryReconciliationOnDb(d, { sessionDate: SESSION });
  assert.equal(r.ledgerAvailable, false);
  assert.equal(r.deliveredToYou.length, 0, "a mirror is never promoted to a delivery");
  assert.match(r.reconciliationNote, /unavailable/);
  d.close();
});
