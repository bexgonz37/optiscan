import test from "node:test";
import assert from "node:assert/strict";
import {
  refreshStatisticsOnDb,
  listStatisticsOnDb,
  computeAllStatistics,
  enrichedOutcomesOnDb,
} from "../lib/statistics-store.ts";

let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch {
  Database = null;
}

const DDL = `
CREATE TABLE IF NOT EXISTS setup_fingerprints (
  fingerprint_id TEXT PRIMARY KEY, fingerprint_version INTEGER NOT NULL, strategy TEXT,
  strategy_version INTEGER, dimensions_json TEXT NOT NULL, human_summary TEXT NOT NULL, first_seen_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS paper_trade_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, paper_trade_id INTEGER NOT NULL UNIQUE,
  fingerprint_id TEXT, fingerprint_version INTEGER, strategy TEXT, strategy_version INTEGER,
  instrument_type TEXT, direction TEXT, selector_profile TEXT, entry_session TEXT,
  net_pnl REAL, gross_pnl REAL, return_pct REAL, r_multiple REAL,
  entry_fees REAL, exit_fees REAL, entry_slippage REAL, exit_slippage REAL,
  hold_minutes REAL, mfe_pct REAL, mae_pct REAL, exit_time_ms INTEGER,
  grade TEXT NOT NULL, grading_status TEXT NOT NULL, data_quality_status TEXT
);
CREATE TABLE IF NOT EXISTS authoritative_statistics (
  id INTEGER PRIMARY KEY AUTOINCREMENT, group_kind TEXT NOT NULL, group_key TEXT NOT NULL,
  statistics_version INTEGER NOT NULL, fingerprint_version INTEGER, strategy_version INTEGER,
  graded_sample_size INTEGER NOT NULL DEFAULT 0, ungradable_count INTEGER NOT NULL DEFAULT 0,
  evidence_state TEXT NOT NULL, stats_json TEXT NOT NULL, source_watermark INTEGER NOT NULL DEFAULT 0,
  last_refresh_ms INTEGER NOT NULL, updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(group_kind, group_key, statistics_version)
);`;

let pid = 0;
function insertOutcome(db, grade, netPnl, over = {}) {
  pid += 1;
  const row = {
    paper_trade_id: pid, fingerprint_id: "sf1_aaaaaaaaaaaaaaaa", fingerprint_version: 1,
    strategy: "zero_dte_momentum", strategy_version: 1, instrument_type: "option", direction: "CALL",
    selector_profile: "zero_dte_momentum", entry_session: "regular",
    net_pnl: netPnl, gross_pnl: netPnl, return_pct: null, r_multiple: netPnl == null ? null : netPnl / 50,
    entry_fees: 0.65, exit_fees: 0.65, entry_slippage: 0.02, exit_slippage: 0.02,
    hold_minutes: 10, mfe_pct: 20, mae_pct: -8, exit_time_ms: pid,
    grade, grading_status: grade === "UNGRADABLE" ? "UNGRADABLE" : "GRADED", data_quality_status: "OK",
    ...over,
  };
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO paper_trade_outcomes (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((k) => row[k]));
}

function freshDb() {
  const db = new Database(":memory:");
  db.exec(DDL);
  db.prepare("INSERT OR IGNORE INTO setup_fingerprints (fingerprint_id, fingerprint_version, strategy, strategy_version, dimensions_json, human_summary, first_seen_at_ms) VALUES (?,?,?,?,?,?,?)")
    .run("sf1_aaaaaaaaaaaaaaaa", 1, "zero_dte_momentum", 1, JSON.stringify({ session: "REGULAR", todBucket: "OPEN", dteBucket: "0DTE", deltaBand: "0.45-0.55" }), "readable", 1);
  return db;
}

test("statistics-store reads paper_trade_outcomes only, never legacy trade_outcomes (source-spec)", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(join(root, "lib/statistics-store.ts"), "utf8");
  assert.ok(src.includes("paper_trade_outcomes"));
  assert.ok(!/FROM\s+trade_outcomes/.test(src), "must not read the legacy gross-P&L table");
  const dbsrc = readFileSync(join(root, "lib/db.ts"), "utf8");
  assert.ok(/CREATE TABLE IF NOT EXISTS authoritative_statistics/.test(dbsrc));
});

if (Database) {
  test("refresh materializes overall + group stats and reports a watermark", () => {
    const db = freshDb();
    insertOutcome(db, "WIN", 100);
    insertOutcome(db, "LOSS", -40);
    insertOutcome(db, "UNGRADABLE", null);
    const res = refreshStatisticsOnDb(db, Date.now());
    assert.ok(res.groups >= 2);
    assert.equal(res.watermark, 3);
    const overall = listStatisticsOnDb(db, "overall")[0];
    assert.equal(overall.stats.gradedSampleSize, 2);
    assert.equal(overall.stats.ungradableCount, 1);
    assert.equal(overall.stats.netPnl, 60);
    assert.equal(overall.evidenceState, "INSUFFICIENT_HISTORY");
    const byStrategy = listStatisticsOnDb(db, "strategy");
    assert.ok(byStrategy.some((g) => g.groupKey === "zero_dte_momentum"));
  });

  test("refresh is idempotent — repeated refresh does not duplicate rows", () => {
    const db = freshDb();
    insertOutcome(db, "WIN", 10);
    insertOutcome(db, "LOSS", -5);
    refreshStatisticsOnDb(db, 1000);
    const before = db.prepare("SELECT COUNT(*) AS n FROM authoritative_statistics").get().n;
    refreshStatisticsOnDb(db, 2000);
    refreshStatisticsOnDb(db, 3000);
    const after = db.prepare("SELECT COUNT(*) AS n FROM authoritative_statistics").get().n;
    assert.equal(before, after);
    // watermark/refresh time updates in place
    const overall = db.prepare("SELECT source_watermark, last_refresh_ms FROM authoritative_statistics WHERE group_kind='overall'").get();
    assert.equal(overall.source_watermark, 2);
    assert.equal(overall.last_refresh_ms, 3000);
  });

  test("dimension cuts (session/tod/dte) are produced from frozen fingerprint dims", () => {
    const db = freshDb();
    insertOutcome(db, "WIN", 10);
    insertOutcome(db, "LOSS", -10);
    refreshStatisticsOnDb(db, Date.now());
    const tod = listStatisticsOnDb(db, "tod_bucket");
    assert.ok(tod.some((g) => g.groupKey === "OPEN"));
    const dte = listStatisticsOnDb(db, "dte_bucket");
    assert.ok(dte.some((g) => g.groupKey === "0DTE"));
  });

  test("enriched outcomes carry fingerprint dimensions", () => {
    const db = freshDb();
    insertOutcome(db, "WIN", 10);
    const rows = enrichedOutcomesOnDb(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]._dims.dteBucket, "0DTE");
    const recs = computeAllStatistics(rows);
    assert.ok(recs.find((r) => r.groupKind === "overall"));
  });

  test("empty DB yields an overall NOT_TRACKED record", () => {
    const db = freshDb();
    const res = refreshStatisticsOnDb(db, Date.now());
    assert.equal(res.watermark, 0);
    const overall = listStatisticsOnDb(db, "overall")[0];
    assert.equal(overall.evidenceState, "NOT_TRACKED");
    assert.equal(overall.stats.gradedSampleSize, 0);
  });
}
