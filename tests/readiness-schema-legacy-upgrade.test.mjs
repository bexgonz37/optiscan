/**
 * The readiness and rank-breakdown tables must arrive safely on a LONG-LIVED database.
 *
 * The 0cc84fb outage is the reason this file exists: an index placed inside SCHEMA
 * referenced a column that only arrived later via ALTER, so `db.exec(SCHEMA)` — the first
 * statement every database open runs — aborted, and EVERY route returned 503. New tables
 * are far less dangerous than new indexes on migrated columns, but "less dangerous" is not
 * a reason to skip the test on a change that gates subscriber delivery.
 *
 * This runs production's real getDb() (real SCHEMA, real migrate(), real ordering) against
 * a real legacy database file, repeatedly. Nothing here restates migration logic.
 */
import "./helpers/register-alias.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * A database that predates every table this change adds, carrying rows — the state a
 * long-lived deployment is actually in.
 */
function legacyDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optiscan-readiness-legacy-"));
  const db = new Database(path.join(dir, "optiscan.db"));
  db.exec(`
    CREATE TABLE alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ticker TEXT NOT NULL, direction TEXT,
      alert_time TEXT, created_at TEXT
    );
    CREATE TABLE options_paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT NOT NULL, side TEXT,
      strike REAL, expiration TEXT, dte INTEGER, result_class TEXT NOT NULL,
      bid REAL, ask REAL, mid REAL, spread_pct REAL, entry_fill REAL,
      volume REAL, open_interest REAL, iv REAL, delta REAL, underlying_price REAL,
      strategy TEXT, target REAL, invalidation REAL, provenance TEXT, status TEXT NOT NULL,
      exit_fill REAL, pnl REAL, return_pct REAL, exit_reason TEXT,
      entered_at_ms INTEGER, exit_at_ms INTEGER, session TEXT, core_broad TEXT,
      feature_snapshot_json TEXT,
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
  `);
  db.prepare("INSERT INTO alerts (ticker, direction) VALUES (?,?)").run("SPY", "bearish");
  db.prepare(
    `INSERT INTO options_paper_trades
       (option_symbol, side, result_class, status, strategy, entry_fill, return_pct, created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run("O:SPY260807P00770000", "put", "REAL_OPTION_PAPER", "EXITED", "lower_high_continuation", 2.22, -12.5, 1, 1);
  db.close();
  return dir;
}

async function initializeLikeProduction(dir) {
  process.env.ALERT_DB_DIR = dir;
  const g = globalThis;
  if (g.__optiscanDb) {
    try { g.__optiscanDb.close(); } catch { /* already closed */ }
    delete g.__optiscanDb;
  }
  const { getDb } = await import("@/lib/db");
  return getDb();
}

function cleanup(dir) {
  const g = globalThis;
  if (g.__optiscanDb) {
    try { g.__optiscanDb.close(); } catch { /* already closed */ }
    delete g.__optiscanDb;
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

const tables = (db) =>
  new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));

test("legacy database: the readiness and rank-breakdown tables are created on first init", async () => {
  const dir = legacyDir();
  try {
    const db = await initializeLikeProduction(dir);
    const t = tables(db);
    assert.ok(t.has("strategy_readiness_state"), "readiness state table must exist");
    assert.ok(t.has("strategy_readiness_transitions"), "readiness transition journal must exist");
    assert.ok(t.has("opportunity_rank_breakdown"), "persisted rank breakdown must exist");
  } finally {
    cleanup(dir);
  }
});

test("legacy database: repeated initialization is safe and changes nothing", async () => {
  const dir = legacyDir();
  try {
    const first = await initializeLikeProduction(dir);
    const before = [...tables(first)].sort();
    // Two more cold initializations, cache cleared each time, exactly like a restart loop.
    await initializeLikeProduction(dir);
    const third = await initializeLikeProduction(dir);
    assert.deepEqual([...tables(third)].sort(), before, "table set must be stable across restarts");
    assert.equal(
      third.prepare("SELECT COUNT(*) n FROM strategy_readiness_state").get().n, 0,
      "migration must not invent readiness rows",
    );
    assert.equal(
      third.prepare("SELECT COUNT(*) n FROM opportunity_rank_breakdown").get().n, 0,
      "migration must not invent rank rows",
    );
  } finally {
    cleanup(dir);
  }
});

test("legacy database: pre-existing rows survive the upgrade untouched", async () => {
  const dir = legacyDir();
  try {
    const db = await initializeLikeProduction(dir);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM alerts").get().n, 1);
    const trade = db.prepare("SELECT strategy, return_pct, entry_fill FROM options_paper_trades").get();
    assert.equal(trade.strategy, "lower_high_continuation");
    assert.equal(trade.return_pct, -12.5);
    assert.equal(trade.entry_fill, 2.22);
  } finally {
    cleanup(dir);
  }
});

test("legacy database: an unmigrated readiness state means RESEARCH_ONLY, never permission", async () => {
  const dir = legacyDir();
  try {
    const db = await initializeLikeProduction(dir);
    const { subscriberEligibility } = await import("@/lib/research/options/strategy-readiness");
    // Schema now exists but holds no rows: a real database on the morning of this deploy.
    const e = subscriberEligibility(db, "lower_high_continuation", "1", {});
    assert.equal(e.allowed, false, "an unassessed strategy must not be subscriber-eligible");
    assert.equal(e.state, "RESEARCH_ONLY");
    assert.equal(e.enforced, true);
  } finally {
    cleanup(dir);
  }
});

test("legacy database: the outcome loader tolerates a table missing newer columns", async () => {
  const dir = legacyDir();
  try {
    const db = await initializeLikeProduction(dir);
    const { loadOutcomeRowsOnDb } = await import("@/lib/research/options/strategy-performance-loader");
    const rows = loadOutcomeRowsOnDb(db, {});
    assert.ok(Array.isArray(rows), "loader must not throw on a legacy shape");
    const spy = rows.find((r) => r.symbol === "SPY");
    assert.ok(spy, "the legacy row is still read");
    assert.equal(spy.strategy, "lower_high_continuation");
    assert.equal(spy.returnPct, -12.5);
    // Attribution that never existed as a column must stay NULL, not be invented.
    assert.equal(spy.strategyVersion, null);
    assert.equal(spy.deploymentSha, null);
  } finally {
    cleanup(dir);
  }
});
