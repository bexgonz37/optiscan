import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureOptionsDeliveryDecisionsColumns,
  hasSqliteColumn,
  listMissingLegacyColumns,
} from "../lib/db-legacy-columns.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
} catch {
  Database = null;
}

function legacyProductionDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE alerts (id INTEGER PRIMARY KEY, ticker TEXT NOT NULL, source TEXT NOT NULL, alert_time TEXT NOT NULL, trading_day TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'tracking', created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE scanner_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE options_delivery_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      strategy TEXT,
      side TEXT,
      tier INTEGER,
      outcome TEXT NOT NULL,
      reason TEXT,
      quality REAL,
      rank INTEGER,
      batch_size INTEGER,
      components_json TEXT,
      cluster_key TEXT,
      threshold REAL,
      session_state TEXT,
      alert_id TEXT,
      would_deliver_solo INTEGER,
      competing_json TEXT,
      created_at_ms INTEGER NOT NULL
    );
    INSERT INTO options_delivery_decisions (batch_id, symbol, outcome, created_at_ms)
      VALUES ('b1', 'NVDA', 'REJECT', 1000);
  `);
  return db;
}

test("SCHEMA no longer creates final_delivery_outcome index before column migrations", () => {
  const schema = read("lib/db.ts").match(/const SCHEMA = `([\s\S]*?)`;/)[1];
  assert.doesNotMatch(
    schema,
    /CREATE INDEX IF NOT EXISTS idx_options_delivery_final_outcome ON options_delivery_decisions\(final_delivery_outcome/,
  );
});

test("alerts base-column migrations cover old production SQLite files", () => {
  const dbSrc = read("lib/db.ts");
  for (const col of ["source", "direction", "option_symbol", "option_side", "alert_time", "trading_day", "status"]) {
    assert.match(dbSrc, new RegExp(`\\["${col}", "ALTER TABLE alerts ADD COLUMN`), `missing guarded alert migration for ${col}`);
  }
});

test("alert list and accuracy queries repair legacy alert columns before proof SQL", () => {
  const store = read("lib/alert-store.ts");
  assert.match(store, /function ensureAlertQueryCompatColumns/);
  assert.match(store, /function alertDeliveryProofSqlForDb/);
  assert.match(store, /export function listAlerts[\s\S]*?ensureAlertQueryCompatColumns\(db\)/);
  assert.match(store, /export function listAlerts[\s\S]*?alertDeliveryProofSqlForDb\(db, "a"\)/);
  assert.match(store, /export function tradeSignalAccuracy[\s\S]*?ensureAlertQueryCompatColumns\(db\)/);
  assert.match(store, /export function tradeSignalAccuracy[\s\S]*?alertDeliveryProofSqlForDb\(db, "a"\)/);
  assert.match(store, /verified: "0"/);
  assert.match(store, /deliveryAlertId: "NULL"/);
  assert.match(store, /"alert_time", "ALTER TABLE alerts ADD COLUMN alert_time TEXT"/);
});

test("legacy DB missing final_delivery_outcome: column migration runs before SCHEMA can succeed", { skip: !Database }, () => {
  const db = legacyProductionDb();
  assert.equal(hasSqliteColumn(db, "options_delivery_decisions", "final_delivery_outcome"), false);
  const added = ensureOptionsDeliveryDecisionsColumns(db);
  assert.ok(added.includes("final_delivery_outcome"));
  assert.equal(hasSqliteColumn(db, "options_delivery_decisions", "final_delivery_outcome"), true);
  assert.doesNotThrow(() => {
    db.exec("CREATE INDEX IF NOT EXISTS idx_options_delivery_final_outcome ON options_delivery_decisions(final_delivery_outcome, created_at_ms)");
  });
  const row = db.prepare("SELECT final_delivery_outcome FROM options_delivery_decisions WHERE symbol='NVDA'").get();
  assert.equal(row.final_delivery_outcome, "REJECTED");
});

test("legacy column migration is repeat-safe and preserves existing rows", { skip: !Database }, () => {
  const db = legacyProductionDb();
  ensureOptionsDeliveryDecisionsColumns(db);
  const before = db.prepare("SELECT COUNT(*) n FROM options_delivery_decisions").get().n;
  assert.deepEqual(ensureOptionsDeliveryDecisionsColumns(db), []);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM options_delivery_decisions").get().n, before);
  ensureOptionsDeliveryDecisionsColumns(db);
});

test("full migrate on legacy fixture adds final_delivery_outcome and enterprise tables", { skip: !Database }, async () => {
  const db = legacyProductionDb();
  const { ensureEnterpriseSchemaOnDb } = await import("../lib/db-schema-readiness.ts");
  const { ensureOptionsDeliveryDecisionsColumns, ensureOptionsShadowDecisionsColumns, ensureSubscriberPipelineInstrumentationColumns } = await import("../lib/db-legacy-columns.ts");
  ensureOptionsDeliveryDecisionsColumns(db);
  const schema = read("lib/db.ts").match(/const SCHEMA = `([\s\S]*?)`;/)[1];
  assert.doesNotThrow(() => db.exec(schema));
  ensureSubscriberPipelineInstrumentationColumns(db);
  ensureEnterpriseSchemaOnDb(db);
  assert.equal(hasSqliteColumn(db, "options_delivery_decisions", "final_delivery_outcome"), true);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='opportunity_cases'").get());
  assert.deepEqual(listMissingLegacyColumns(db), []);
});
