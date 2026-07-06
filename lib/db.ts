/**
 * db.ts — SQLite storage for Alert Lab (better-sqlite3).
 *
 * One local file: data/optiscan.db (override dir with ALERT_DB_DIR). WAL mode
 * for safe concurrent reads while the tracker writes. The handle is cached on
 * globalThis so Next.js dev-mode module reloads don't leak connections.
 *
 * Like the scan cache, this is process-local by design — single-instance
 * `next start`/`next dev` is the supported deployment (see README).
 *
 * Migrations: CREATE TABLE IF NOT EXISTS for new tables, plus guarded ALTERs
 * so existing databases pick up new alert columns without data loss.
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  source TEXT NOT NULL,               -- 'momentum' | 'unusual' | 'manual'
  direction TEXT,                     -- 'bullish' | 'bearish' | 'neutral'
  option_symbol TEXT,
  option_side TEXT,                   -- 'call' | 'put'
  strike REAL,
  expiration TEXT,
  dte INTEGER,
  alert_time TEXT NOT NULL,           -- ISO UTC
  trading_day TEXT NOT NULL,          -- YYYY-MM-DD in US/Eastern
  price_at_alert REAL,
  percent_move_at_alert REAL,
  volume REAL,                        -- underlying share volume at alert
  relative_volume REAL,
  catalyst_type TEXT,
  catalyst_quality TEXT,
  catalyst_summary TEXT,
  catalyst_source TEXT,
  signal_score REAL,                  -- setup score (0-100)
  risk_score REAL,
  options_liquidity_score REAL,
  scanner_score REAL,                 -- raw score from the scanner tab
  status TEXT NOT NULL DEFAULT 'tracking',  -- 'tracking' | 'complete'
  is_false_positive INTEGER,          -- null until EOD checkpoint decides
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_dedup
  ON alerts(ticker, source, coalesce(option_symbol,''), trading_day);
CREATE INDEX IF NOT EXISTS idx_alerts_day ON alerts(trading_day);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);

CREATE TABLE IF NOT EXISTS alert_performance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  checkpoint TEXT NOT NULL,           -- '5m' | '15m' | '30m' | '1h' | 'eod'
  checked_at TEXT NOT NULL,
  price_at_checkpoint REAL,
  percent_move_from_alert REAL,       -- FAVORABLE-signed: + = moved with the signal
  max_price_after_alert REAL,         -- most favorable price seen so far
  max_percent_move_after_alert REAL,  -- favorable-signed extreme move so far
  drawdown_after_alert REAL,          -- worst adverse move so far (<= 0)
  is_false_positive INTEGER,          -- set on 'eod' rows only
  UNIQUE(alert_id, checkpoint)
);
CREATE INDEX IF NOT EXISTS idx_perf_alert ON alert_performance(alert_id);

CREATE TABLE IF NOT EXISTS trade_journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER REFERENCES alerts(id) ON DELETE SET NULL,
  ticker TEXT NOT NULL,
  side TEXT,                          -- 'call' | 'put' | 'shares' | 'spread' | 'no trade'
  contract TEXT,                      -- contract selected (option symbol)
  entry_price REAL,
  exit_price REAL,
  quantity REAL,
  opened_at TEXT,
  closed_at TEXT,
  outcome_pct REAL,
  pnl REAL,
  entry_reason TEXT,
  exit_reason TEXT,
  mistake_notes TEXT,
  screenshot_url TEXT,
  emotion_tag TEXT,
  lesson TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_journal_alert ON trade_journal(alert_id);

CREATE TABLE IF NOT EXISTS options_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  taken_at TEXT NOT NULL,
  checkpoint TEXT NOT NULL DEFAULT 'alert',
  option_symbol TEXT,
  bid REAL, ask REAL, mid REAL,
  spread_pct REAL,
  volume REAL,
  open_interest REAL,
  iv REAL,
  delta REAL
);
CREATE INDEX IF NOT EXISTS idx_snap_alert ON options_snapshots(alert_id);

CREATE TABLE IF NOT EXISTS catalyst_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  headline TEXT,
  publisher TEXT,
  published_at TEXT,
  url TEXT,
  catalyst_type TEXT,
  quality TEXT,
  matched_keywords TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_cat_alert ON catalyst_records(alert_id);

CREATE TABLE IF NOT EXISTS scanner_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS score_breakdowns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  breakdown_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_breakdown_alert ON score_breakdowns(alert_id);

CREATE TABLE IF NOT EXISTS popup_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER REFERENCES alerts(id) ON DELETE SET NULL,
  ticker TEXT,
  action TEXT NOT NULL,               -- 'shown'|'watch'|'journal'|'trade_taken'|'snooze'|'ignore'|'open_chain'|'open_details'
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS notification_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  browser_popup_enabled INTEGER NOT NULL DEFAULT 1,
  desktop_notification_enabled INTEGER NOT NULL DEFAULT 1,
  sound_enabled INTEGER NOT NULL DEFAULT 1,
  discord_enabled INTEGER NOT NULL DEFAULT 0,        -- OFF by default
  discord_requires_manual_confirm INTEGER NOT NULL DEFAULT 1,
  public_mode_required_for_discord INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT
);
INSERT OR IGNORE INTO notification_settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS notification_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER REFERENCES alerts(id) ON DELETE SET NULL,
  channel TEXT NOT NULL,              -- 'browser_popup'|'browser_desktop_notification'|'sound_alert'|'discord_webhook'|'email_later'|'sms_later'
  status TEXT NOT NULL,               -- 'sent'|'pending_confirm'|'failed'|'skipped'
  payload_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notif_status ON notification_events(status);
`;

/** Columns added after the first Alert Lab release — guarded ALTERs. */
const ALERT_COLUMN_MIGRATIONS: [string, string][] = [
  ["alert_type", "ALTER TABLE alerts ADD COLUMN alert_type TEXT"],
  ["score_breakdown_json", "ALTER TABLE alerts ADD COLUMN score_breakdown_json TEXT"],
  ["ai_explanation", "ALTER TABLE alerts ADD COLUMN ai_explanation TEXT"],
  ["public_explanation", "ALTER TABLE alerts ADD COLUMN public_explanation TEXT"],
  ["private_label", "ALTER TABLE alerts ADD COLUMN private_label TEXT"],
  ["public_label", "ALTER TABLE alerts ADD COLUMN public_label TEXT"],
  // 0DTE pivot fields
  ["trade_bias", "ALTER TABLE alerts ADD COLUMN trade_bias TEXT"],
  ["move_status", "ALTER TABLE alerts ADD COLUMN move_status TEXT"],
  ["option_worth_score", "ALTER TABLE alerts ADD COLUMN option_worth_score REAL"],
  ["worth_verdict", "ALTER TABLE alerts ADD COLUMN worth_verdict TEXT"],
  ["chase_risk", "ALTER TABLE alerts ADD COLUMN chase_risk TEXT"],
  ["iv_risk", "ALTER TABLE alerts ADD COLUMN iv_risk TEXT"],
  ["spread_risk", "ALTER TABLE alerts ADD COLUMN spread_risk TEXT"],
  ["continuation_score", "ALTER TABLE alerts ADD COLUMN continuation_score REAL"],
  ["exhaustion_score", "ALTER TABLE alerts ADD COLUMN exhaustion_score REAL"],
  ["long_call_score", "ALTER TABLE alerts ADD COLUMN long_call_score REAL"],
  ["long_put_score", "ALTER TABLE alerts ADD COLUMN long_put_score REAL"],
  ["zero_dte_contract_score", "ALTER TABLE alerts ADD COLUMN zero_dte_contract_score REAL"],
  ["risk_flags", "ALTER TABLE alerts ADD COLUMN risk_flags TEXT"],
  // options pressure confirmation + measured outcomes
  ["options_pressure_label", "ALTER TABLE alerts ADD COLUMN options_pressure_label TEXT"],
  ["options_pressure_json", "ALTER TABLE alerts ADD COLUMN options_pressure_json TEXT"],
  ["call_side_worked", "ALTER TABLE alerts ADD COLUMN call_side_worked INTEGER"],
  ["put_side_worked", "ALTER TABLE alerts ADD COLUMN put_side_worked INTEGER"],
  ["spread_widened", "ALTER TABLE alerts ADD COLUMN spread_widened INTEGER"],
  ["reversed", "ALTER TABLE alerts ADD COLUMN reversed INTEGER"],
  ["short_rate_at_alert", "ALTER TABLE alerts ADD COLUMN short_rate_at_alert REAL"],
  ["volume_surge_at_alert", "ALTER TABLE alerts ADD COLUMN volume_surge_at_alert REAL"],
];
const JOURNAL_COLUMN_MIGRATIONS: [string, string][] = [
  ["contract", "ALTER TABLE trade_journal ADD COLUMN contract TEXT"],
  ["pnl", "ALTER TABLE trade_journal ADD COLUMN pnl REAL"],
  ["entry_reason", "ALTER TABLE trade_journal ADD COLUMN entry_reason TEXT"],
  ["exit_reason", "ALTER TABLE trade_journal ADD COLUMN exit_reason TEXT"],
  ["mistake_notes", "ALTER TABLE trade_journal ADD COLUMN mistake_notes TEXT"],
  ["screenshot_url", "ALTER TABLE trade_journal ADD COLUMN screenshot_url TEXT"],
  ["emotion_tag", "ALTER TABLE trade_journal ADD COLUMN emotion_tag TEXT"],
  ["lesson", "ALTER TABLE trade_journal ADD COLUMN lesson TEXT"],
];

function migrate(db: Database.Database) {
  db.exec(SCHEMA);
  const cols = (table: string) =>
    new Set((db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name));
  const alertCols = cols("alerts");
  for (const [col, sql] of ALERT_COLUMN_MIGRATIONS) if (!alertCols.has(col)) db.exec(sql);
  const journalCols = cols("trade_journal");
  for (const [col, sql] of JOURNAL_COLUMN_MIGRATIONS) if (!journalCols.has(col)) db.exec(sql);
}

type G = typeof globalThis & { __optiscanDb?: Database.Database };

export function getDb(): Database.Database {
  const g = globalThis as G;
  if (g.__optiscanDb) return g.__optiscanDb;
  const dir = process.env.ALERT_DB_DIR || path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, "optiscan.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  g.__optiscanDb = db;
  return db;
}

export { tradingDay, etCloseMs, minutesToClose } from "@/lib/trading-session";
