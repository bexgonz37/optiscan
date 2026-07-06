/**
 * db.ts — SQLite storage for Alert Lab (better-sqlite3).
 *
 * One local file: data/optiscan.db (override dir with ALERT_DB_DIR). WAL mode
 * for safe concurrent reads while the tracker writes. The handle is cached on
 * globalThis so Next.js dev-mode module reloads don't leak connections.
 *
 * Like the scan cache, this is process-local by design — single-instance
 * `next start`/`next dev` is the supported deployment (see README).
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  source TEXT NOT NULL,               -- 'momentum' | 'unusual'
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
  signal_score REAL,
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
  side TEXT,                          -- 'call' | 'put' | 'shares'
  entry_price REAL,
  exit_price REAL,
  quantity REAL,
  opened_at TEXT,
  closed_at TEXT,
  outcome_pct REAL,
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
`;

type G = typeof globalThis & { __optiscanDb?: Database.Database };

export function getDb(): Database.Database {
  const g = globalThis as G;
  if (g.__optiscanDb) return g.__optiscanDb;
  const dir = process.env.ALERT_DB_DIR || path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, "optiscan.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  g.__optiscanDb = db;
  return db;
}

/** YYYY-MM-DD in US/Eastern for a timestamp — the "trading day" key. */
const etDayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });
export function tradingDay(ms: number = Date.now()): string {
  return etDayFmt.format(new Date(ms));
}

/** Epoch ms of 16:00 US/Eastern on a YYYY-MM-DD trading day (DST-safe). */
export function etCloseMs(day: string): number {
  const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false });
  for (const off of ["-04:00", "-05:00"]) {
    const ms = Date.parse(`${day}T16:00:00${off}`);
    if (Number.isFinite(ms) && hourFmt.format(new Date(ms)) === "16") return ms;
  }
  return Date.parse(`${day}T16:00:00-05:00`);
}
