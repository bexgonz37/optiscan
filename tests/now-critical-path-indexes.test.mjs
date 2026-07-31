/**
 * tests/now-critical-path-indexes.test.mjs — regression cover for the /api/now
 * latency incident.
 *
 * Measured on a 1.27 GB production snapshot: /api/now took ~13-15s in
 * production. 84% of it was ONE statement —
 *   SELECT opportunity_id FROM opportunity_cases WHERE alert_id=?
 * — which the paper-chain diagnostic issues once per SENT alert (~460x). With
 * no index on alert_id that is a full SCAN of ~20.6k rows plus a temp B-tree
 * each time: 23.9s of a 28.5s request. A second unindexed lookup on
 * options_delivery_decisions(alert_id) cost a further 1.7s over 546 calls.
 *
 * Both indexes are additive and repeat-safe. These tests assert the query
 * PLANNER actually uses them, so the fix cannot silently regress if a column,
 * index name, or query shape changes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

/** Minimal schema mirroring the real column sets these queries touch. */
function seedDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE opportunity_cases (
      opportunity_id TEXT PRIMARY KEY,
      alert_id TEXT,
      underlying_symbol TEXT,
      delivery_decision TEXT,
      detected_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE options_delivery_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id TEXT,
      final_delivery_outcome TEXT NOT NULL DEFAULT 'SKIPPED',
      created_at_ms INTEGER
    );
  `);
  return db;
}

function applyIndexes(db) {
  db.exec("CREATE INDEX IF NOT EXISTS idx_opportunity_cases_alert ON opportunity_cases(alert_id);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_options_delivery_decisions_alert ON options_delivery_decisions(alert_id);");
}

const plan = (db, sql, ...args) =>
  db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((r) => r.detail).join(" | ");

test("without the index the case lookup is a full scan (the measured defect)", () => {
  const db = seedDb();
  const detail = plan(db, "SELECT opportunity_id FROM opportunity_cases WHERE alert_id=? ORDER BY created_at_ms DESC", "a");
  assert.match(detail, /SCAN opportunity_cases/, "this is the 23.9s behaviour the index removes");
  db.close();
});

test("the alert_id index makes the case lookup an indexed search", () => {
  const db = seedDb();
  applyIndexes(db);
  const detail = plan(db, "SELECT opportunity_id FROM opportunity_cases WHERE alert_id=? ORDER BY created_at_ms DESC", "a");
  assert.match(detail, /SEARCH opportunity_cases USING INDEX idx_opportunity_cases_alert/);
  assert.equal(/SCAN opportunity_cases/.test(detail), false, "must not fall back to a scan");
  db.close();
});

test("the alert_id index makes the delivery-decision lookup an indexed search", () => {
  const db = seedDb();
  applyIndexes(db);
  const detail = plan(db, "SELECT * FROM options_delivery_decisions WHERE alert_id=? ORDER BY id DESC", "a");
  assert.match(detail, /SEARCH options_delivery_decisions USING INDEX idx_options_delivery_decisions_alert/);
  db.close();
});

test("both index migrations are additive and repeat-safe", () => {
  const db = seedDb();
  applyIndexes(db);
  applyIndexes(db); // a second migration pass must be a no-op, not an error
  const names = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%_alert%'").all().map((r) => r.name),
  );
  assert.equal(names.size, 2, "a repeat pass must not duplicate indexes");
  assert.ok(names.has("idx_opportunity_cases_alert"));
  assert.ok(names.has("idx_options_delivery_decisions_alert"));
  db.close();
});

test("an index cannot change query RESULTS, only the plan", () => {
  const seed = (db) => {
    const ins = db.prepare("INSERT INTO opportunity_cases (opportunity_id, alert_id, created_at_ms, updated_at_ms) VALUES (?,?,?,?)");
    for (let i = 0; i < 200; i++) ins.run(`oc_${i}`, `alert_${i % 25}`, 1000 + i, 1000 + i);
  };
  const q = "SELECT opportunity_id FROM opportunity_cases WHERE alert_id=? ORDER BY created_at_ms DESC";

  const plain = seedDb(); seed(plain);
  const indexed = seedDb(); seed(indexed); applyIndexes(indexed);

  for (const alertId of ["alert_0", "alert_7", "alert_24", "missing"]) {
    assert.deepEqual(
      indexed.prepare(q).all(alertId),
      plain.prepare(q).all(alertId),
      `results for ${alertId} must be identical with and without the index`,
    );
  }
  plain.close(); indexed.close();
});

test("the migrations are declared in the shipped schema", () => {
  const schema = readFileSync("lib/db.ts", "utf8");
  assert.match(
    schema,
    /CREATE INDEX IF NOT EXISTS idx_opportunity_cases_alert ON opportunity_cases\(alert_id\)/,
    "the case index must ship in the canonical schema",
  );
  const legacy = readFileSync("lib/db-legacy-columns.ts", "utf8");
  assert.match(
    legacy,
    /CREATE INDEX IF NOT EXISTS idx_options_delivery_decisions_alert ON options_delivery_decisions\(alert_id\)/,
    "the delivery-decision index must ship in the additive column migration",
  );
});

test("the fix adds no cache and no write to the /api/now read path", () => {
  const route = readFileSync("app/api/now/route.ts", "utf8");
  // /api/now must stay a pure read: no INSERT/UPDATE/DELETE, no module-level cache.
  assert.equal(/INSERT |UPDATE |DELETE /.test(route), false, "/api/now must perform no writes");
  assert.equal(/globalThis\.__now|let cache|const cache/.test(route), false, "no ad-hoc global cache was introduced");
});
