import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { deliveryAlertIdSql, verifiedSubscriberDeliverySql } from "../lib/alert-delivery-proof.ts";
import { postableOptionsAlerts, premiumDiscordCallouts } from "../lib/social-post.ts";

function makeDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT, source TEXT, direction TEXT, option_symbol TEXT, option_side TEXT,
      strike REAL, expiration TEXT, dte INTEGER, alert_time TEXT, trading_day TEXT,
      price_at_alert REAL, percent_move_at_alert REAL, signal_score REAL, status TEXT,
      is_false_positive INTEGER, alert_tier TEXT, capture_action TEXT, asset_class TEXT,
      session TEXT, option_return_pct REAL, option_outcome_win INTEGER
    );
    CREATE TABLE options_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id INTEGER, taken_at TEXT, checkpoint TEXT, option_symbol TEXT,
      bid REAL, ask REAL, mid REAL, spread_pct REAL
    );
    CREATE TABLE notification_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id INTEGER, channel TEXT, status TEXT, error TEXT, created_at TEXT, sent_at TEXT
    );
    CREATE TABLE options_alerts (
      alert_id TEXT PRIMARY KEY, candidate_symbol TEXT, strategy TEXT, option_symbol TEXT,
      side TEXT, research_only INTEGER, state TEXT, paper_linked INTEGER, sent_at_ms INTEGER,
      discord_status INTEGER, discord_message_id TEXT, opportunity_case_id TEXT, entry_mid REAL,
      created_at_ms INTEGER, updated_at_ms INTEGER
    );
    CREATE TABLE options_paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      option_symbol TEXT, side TEXT, strike REAL, expiration TEXT, dte INTEGER,
      result_class TEXT, status TEXT, paper_kind TEXT, alert_id TEXT, entry_fill REAL,
      created_at_ms INTEGER, updated_at_ms INTEGER
    );
  `);
  return db;
}

function insertLegacyAlert(db, over = {}) {
  const row = {
    ticker: "NVDA",
    source: "momentum",
    direction: "bearish",
    option_symbol: "O:NVDA260727P00200000",
    option_side: "put",
    strike: 200,
    expiration: "2026-07-27",
    dte: 0,
    alert_time: "2026-07-27T14:22:10.777Z",
    trading_day: "2026-07-27",
    price_at_alert: 200.24,
    percent_move_at_alert: -3.1087,
    signal_score: 100,
    status: "complete",
    is_false_positive: 0,
    alert_tier: "trade",
    capture_action: "TRADE",
    asset_class: "options",
    session: "regular",
    option_return_pct: 591.9,
    option_outcome_win: 1,
    ...over,
  };
  const res = db.prepare(
    `INSERT INTO alerts (
      ticker, source, direction, option_symbol, option_side, strike, expiration, dte,
      alert_time, trading_day, price_at_alert, percent_move_at_alert, signal_score,
      status, is_false_positive, alert_tier, capture_action, asset_class, session,
      option_return_pct, option_outcome_win
    ) VALUES (
      @ticker, @source, @direction, @option_symbol, @option_side, @strike, @expiration, @dte,
      @alert_time, @trading_day, @price_at_alert, @percent_move_at_alert, @signal_score,
      @status, @is_false_positive, @alert_tier, @capture_action, @asset_class, @session,
      @option_return_pct, @option_outcome_win
    )`,
  ).run(row);
  return Number(res.lastInsertRowid);
}

function insertSnapshots(db, alertId, optionSymbol = "O:NVDA260727P00200000") {
  db.prepare(
    `INSERT INTO options_snapshots (alert_id, taken_at, checkpoint, option_symbol, bid, ask, mid, spread_pct)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(alertId, "2026-07-27T14:22:10.777Z", "alert", optionSymbol, 0.49, 0.5, 0.495, 2.02);
  db.prepare(
    `INSERT INTO options_snapshots (alert_id, taken_at, checkpoint, option_symbol, bid, ask, mid, spread_pct)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(alertId, "2026-07-27T20:00:55.546Z", "eod", optionSymbol, 3.25, 3.6, 3.425, 10.22);
}

test("NVDA $200 PUT +591.90% without hard Discord proof is audit-only", () => {
  const db = makeDb();
  const alertId = insertLegacyAlert(db);
  insertSnapshots(db, alertId);
  db.prepare(
    `INSERT INTO notification_events (alert_id, channel, status, error, created_at)
     VALUES (?, 'discord_webhook', 'skipped', ?, '2026-07-27T14:22:11.370Z')`,
  ).run(alertId, "superseded by independent options subscriber path (SUBSCRIBER_OPTIONS_DISCORD_OWNER=independent)");

  const deliveredRows = db.prepare(
    `SELECT a.*, CASE WHEN ${verifiedSubscriberDeliverySql("a")} THEN 1 ELSE 0 END AS subscriber_delivered
     FROM alerts a
     WHERE a.alert_tier='trade' AND ${verifiedSubscriberDeliverySql("a")}`,
  ).all();
  assert.equal(deliveredRows.some((r) => r.id === alertId), false);

  const auditRows = db.prepare(
    `SELECT a.*, CASE WHEN ${verifiedSubscriberDeliverySql("a")} THEN 1 ELSE 0 END AS subscriber_delivered
     FROM alerts a
     WHERE a.ticker='NVDA' AND a.trading_day='2026-07-27'`,
  ).all();
  const audit = auditRows.find((r) => r.id === alertId);
  assert.equal(audit.option_return_pct, 591.9);
  assert.equal(audit.subscriber_delivered, 0);
  assert.equal(postableOptionsAlerts(auditRows).some((r) => r.id === alertId), false);
  assert.equal(premiumDiscordCallouts(auditRows).some((r) => r.id === alertId), false);
});

test("delivered accuracy requires Discord message, opportunity case, mirror, OCC, and frozen entry", () => {
  const db = makeDb();
  const alertId = insertLegacyAlert(db, {
    ticker: "AAPL",
    option_symbol: "O:AAPL260727C00220000",
    option_side: "call",
    strike: 220,
    direction: "bullish",
    option_return_pct: 25,
  });
  insertSnapshots(db, alertId, "O:AAPL260727C00220000");
  const sentAt = Date.parse("2026-07-27T14:22:20.000Z");
  db.prepare(
    `INSERT INTO options_alerts (
      alert_id, candidate_symbol, strategy, option_symbol, side, research_only, state,
      paper_linked, sent_at_ms, discord_status, discord_message_id, opportunity_case_id,
      entry_mid, created_at_ms, updated_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    "oa_verified_aapl", "AAPL", "momentum_acceleration", "O:AAPL260727C00220000", "call",
    0, "SENT", 1, sentAt, 200, "discord-msg-1", "oc_verified_aapl", 0.495, sentAt, sentAt,
  );
  db.prepare(
    `INSERT INTO options_paper_trades (
      option_symbol, side, strike, expiration, dte, result_class, status, paper_kind,
      alert_id, entry_fill, created_at_ms, updated_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run("O:AAPL260727C00220000", "call", 220, "2026-07-27", 0, "WIN", "EXITED", "DELIVERED_ALERT_PAPER", "oa_verified_aapl", 0.495, sentAt, sentAt);

  const deliveredRows = db.prepare(
    `SELECT a.*, CASE WHEN ${verifiedSubscriberDeliverySql("a")} THEN 1 ELSE 0 END AS subscriber_delivered
     FROM alerts a
     WHERE a.alert_tier='trade' AND ${verifiedSubscriberDeliverySql("a")}`,
  ).all();
  const row = deliveredRows.find((r) => r.id === alertId);
  assert.ok(row);
  assert.equal(row.subscriber_delivered, 1);
  assert.equal(deliveredRows.length, 1);
});

test("delivery metadata lookup compiles with SQLite outer alert aliases", () => {
  const db = makeDb();
  const alertId = insertLegacyAlert(db, {
    ticker: "AAPL",
    option_symbol: "O:AAPL260727C00220000",
    option_side: "call",
    direction: "bullish",
  });
  const sentAt = Date.parse("2026-07-27T14:23:00.000Z");
  db.prepare(
    `INSERT INTO options_alerts (
      alert_id, candidate_symbol, strategy, option_symbol, side, research_only, state,
      paper_linked, sent_at_ms, discord_status, discord_message_id, opportunity_case_id,
      entry_mid, created_at_ms, updated_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    "oa_verified_aapl", "AAPL", "momentum_acceleration", "O:AAPL260727C00220000", "call",
    0, "SENT", 1, sentAt, 200, "discord-msg-1", "oc_verified_aapl", 0.495, sentAt, sentAt,
  );

  const row = db.prepare(
    `SELECT ${deliveryAlertIdSql("a")} AS delivery_alert_id
     FROM alerts a
     WHERE a.id=?`,
  ).get(alertId);
  assert.equal(row.delivery_alert_id, "oa_verified_aapl");
});
