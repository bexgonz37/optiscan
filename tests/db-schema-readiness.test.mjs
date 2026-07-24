import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENTERPRISE_REQUIRED_TABLES,
  ensureEnterpriseSchemaOnDb,
  inspectSchemaReadiness,
  listMissingEnterpriseTables,
  resolveDbLocation,
} from "../lib/db-schema-readiness.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
} catch {
  Database = null;
}

function legacyPreEnterpriseDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE alerts (id INTEGER PRIMARY KEY, ticker TEXT NOT NULL, source TEXT NOT NULL, alert_time TEXT NOT NULL, trading_day TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'tracking', created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE scanner_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return db;
}

test("resolveDbLocation uses ALERT_DB_DIR when set", () => {
  const loc = resolveDbLocation({ ALERT_DB_DIR: "/app/data" });
  assert.equal(loc.directory.replace(/\\/g, "/"), "/app/data");
  assert.ok(loc.file.replace(/\\/g, "/").endsWith("/app/data/optiscan.db"));
});

test("ensureEnterpriseSchemaOnDb creates all required tables on legacy DB", { skip: !Database }, () => {
  const db = legacyPreEnterpriseDb();
  assert.deepEqual(listMissingEnterpriseTables(db), [...ENTERPRISE_REQUIRED_TABLES]);
  const repaired = ensureEnterpriseSchemaOnDb(db);
  assert.deepEqual(repaired, [...ENTERPRISE_REQUIRED_TABLES]);
  assert.deepEqual(listMissingEnterpriseTables(db), []);
  const readiness = inspectSchemaReadiness(db, { ALERT_DB_DIR: "/app/data" });
  assert.equal(readiness.ok, true);
  assert.equal(readiness.missing.length, 0);
});

test("ensureEnterpriseSchemaOnDb is repeat-safe", { skip: !Database }, () => {
  const db = legacyPreEnterpriseDb();
  ensureEnterpriseSchemaOnDb(db);
  assert.deepEqual(ensureEnterpriseSchemaOnDb(db), []);
  ensureEnterpriseSchemaOnDb(db);
});

test("getDb migrate path includes enterprise schema repair", () => {
  const dbSrc = read("lib/db.ts");
  assert.match(dbSrc, /ensureEnterpriseSchemaOnDb\(db\)/);
  assert.match(dbSrc, /enterprise schema incomplete after migrate/);
});

test("healthz reports schema readiness without secrets", () => {
  const src = read("app/api/healthz/route.ts");
  assert.match(src, /schemaOk/);
  assert.match(src, /schemaMissing/);
  assert.match(src, /dbDirectory/);
  assert.doesNotMatch(src, /SCAN_API_TOKEN|POLYGON_API_KEY/);
});

test("runtime schema route is auth-gated and returns structured JSON", () => {
  const src = read("app/api/runtime/schema/route.ts");
  assert.match(src, /checkApiToken\(req\)/);
  assert.match(src, /repairAndInspectSchemaReadiness/);
});

test("docker entrypoint logs SQLite directory for production diagnostics", () => {
  assert.match(read("docker-entrypoint.sh"), /SQLite directory/);
});

test("standalone tracing includes db schema modules for health and schema routes", () => {
  const cfg = read("next.config.mjs");
  assert.match(cfg, /"\/api\/healthz"/);
  assert.match(cfg, /db-schema-readiness/);
});
