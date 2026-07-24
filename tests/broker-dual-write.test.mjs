import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BROKER_RECORD_SCHEMA_VERSION,
  BROKER_REQUIRED_TABLES,
  ensureBrokerSchemaOnDb,
  paperSimBrokerAdapter,
  dualWriteAfterOptionsPaperEntry,
  dualWriteAfterOptionsPaperExit,
  paperBrokerV2Enabled,
} from "../lib/broker/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
} catch {
  Database = null;
}

function brokerDb() {
  const db = new Database(":memory:");
  ensureBrokerSchemaOnDb(db);
  db.exec(`
    CREATE TABLE options_paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      option_symbol TEXT NOT NULL,
      side TEXT,
      strike REAL,
      expiration TEXT,
      dte INTEGER,
      result_class TEXT,
      bid REAL,
      ask REAL,
      mid REAL,
      spread_pct REAL,
      entry_fill REAL,
      volume INTEGER,
      open_interest INTEGER,
      iv REAL,
      delta REAL,
      underlying_price REAL,
      strategy TEXT,
      target REAL,
      invalidation REAL,
      provenance TEXT,
      status TEXT NOT NULL,
      session TEXT,
      core_broad TEXT,
      feature_snapshot_json TEXT,
      paper_kind TEXT,
      alert_id TEXT,
      entry_source TEXT,
      experiment_id TEXT,
      experiment_variant TEXT,
      entered_at_ms INTEGER,
      exit_fill REAL,
      pnl REAL,
      return_pct REAL,
      exit_reason TEXT,
      exit_at_ms INTEGER,
      created_at_ms INTEGER,
      updated_at_ms INTEGER
    );
  `);
  return db;
}

test("architectural: immutable records carry record_schema_version", () => {
  const ddl = read("lib/broker/schema-ddl.ts");
  for (const table of [
    "broker_orders",
    "broker_fills",
    "broker_ledger_entries",
    "broker_position_snapshots",
    "broker_equity_snapshots",
    "broker_audit_events",
    "broker_marks",
  ]) {
    assert.match(ddl, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}[\\s\\S]*record_schema_version`));
  }
  assert.equal(BROKER_RECORD_SCHEMA_VERSION, 2);
});

test("architectural: market snapshots table and fill linkage exist", () => {
  const ddl = read("lib/broker/schema-ddl.ts");
  assert.match(ddl, /broker_market_snapshots/);
  assert.match(ddl, /broker_fills[\s\S]*market_snapshot_id/);
  assert.match(ddl, /broker_marks[\s\S]*market_snapshot_id/);
  assert.match(ddl, /broker_position_snapshots[\s\S]*market_snapshot_id/);
});

test("architectural: generic BrokerAdapter contract + paper implementation", () => {
  assert.equal(paperSimBrokerAdapter.paper, true);
  assert.equal(paperSimBrokerAdapter.kind, "PAPER_SIM");
  assert.match(read("lib/broker/adapter/contract.ts"), /interface BrokerAdapter/);
});

test("B1 dual-write mirrors options entry and exit with parity when enabled", { skip: !Database }, () => {
  const env = { ...process.env, PAPER_BROKER_V2_ENABLED: "1", BROKER_V2_OPENING_BALANCE_USD: "100000" };
  assert.equal(paperBrokerV2Enabled(env), true);
  const db = brokerDb();
  const now = Date.now();
  const ins = db.prepare(`
    INSERT INTO options_paper_trades
      (option_symbol, side, strike, expiration, dte, result_class, bid, ask, mid, spread_pct, entry_fill,
       underlying_price, strategy, provenance, status, paper_kind, alert_id, entry_source, entered_at_ms, created_at_ms, updated_at_ms)
    VALUES ('O:SPY250124C00590000','call',590,'2025-01-24',0,'REAL_OPTION_PAPER',2.3,2.5,2.4,8.3,2.42,590.1,'zero_dte','polygon','ENTERED','RESEARCH_ONLY_PAPER',NULL,'monitor_shadow',?,?,?)
  `).run(now, now, now);
  const tradeId = Number(ins.lastInsertRowid);
  dualWriteAfterOptionsPaperEntry(db, tradeId, env);
  const link = db.prepare(`SELECT * FROM broker_legacy_links WHERE legacy_table='options_paper_trades' AND legacy_id=?`).get(String(tradeId));
  assert.ok(link);
  const fill = db.prepare(`SELECT price, market_snapshot_id FROM broker_fills WHERE id=?`).get(link.entry_fill_id);
  assert.equal(fill.price, 2.42);
  assert.ok(fill.market_snapshot_id);
  const parityOk = db.prepare(`SELECT COUNT(*) AS c FROM broker_parity_events WHERE legacy_table='options_paper_trades' AND legacy_id=? AND matched=1`).get(String(tradeId)).c;
  assert.ok(parityOk >= 2);

  db.prepare(`UPDATE options_paper_trades SET status='EXITED', exit_fill=2.9, pnl=48, return_pct=19.83, exit_at_ms=?, updated_at_ms=? WHERE id=?`).run(now + 60_000, now + 60_000, tradeId);
  dualWriteAfterOptionsPaperExit(db, tradeId, env);
  const link2 = db.prepare(`SELECT exit_fill_id FROM broker_legacy_links WHERE legacy_id=?`).get(String(tradeId));
  assert.ok(link2.exit_fill_id);
  const mismatches = db.prepare(`SELECT COUNT(*) AS c FROM broker_parity_events WHERE legacy_table='options_paper_trades' AND legacy_id=? AND matched=0`).get(String(tradeId)).c;
  assert.equal(mismatches, 0);
});

test("B1 dual-write is no-op when PAPER_BROKER_V2_ENABLED=0", { skip: !Database }, () => {
  const db = brokerDb();
  const now = Date.now();
  const ins = db.prepare(`
    INSERT INTO options_paper_trades
      (option_symbol, status, paper_kind, entry_fill, entered_at_ms, created_at_ms, updated_at_ms, result_class, provenance, entry_source)
    VALUES ('O:SPY_C600','ENTERED','RESEARCH_ONLY_PAPER',1.5,?,?,?,'REAL_OPTION_PAPER','x','monitor_shadow')
  `).run(now, now, now);
  dualWriteAfterOptionsPaperEntry(db, Number(ins.lastInsertRowid), { PAPER_BROKER_V2_ENABLED: "0" });
  const links = db.prepare(`SELECT COUNT(*) AS c FROM broker_legacy_links`).get().c;
  assert.equal(links, 0);
});

test("schema includes parity events and legacy link tables", () => {
  assert.ok(BROKER_REQUIRED_TABLES.includes("broker_parity_events"));
  assert.ok(BROKER_REQUIRED_TABLES.includes("broker_legacy_links"));
  assert.ok(BROKER_REQUIRED_TABLES.includes("broker_market_snapshots"));
});
