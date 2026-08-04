/**
 * Schema init against an EXISTING pre-migration content_drafts table.
 *
 * This is the case the previous test suite could not see. Every fixture built a
 * fresh in-memory database, where `CREATE TABLE IF NOT EXISTS` creates the table
 * WITH the new columns, so a SCHEMA-level index over those columns always
 * succeeded. Production has a long-lived table: the CREATE is a no-op, the
 * columns arrive later via ALTER, and an index declared in SCHEMA therefore runs
 * against a column that does not exist yet.
 *
 * That threw "no such column: discord_delivery_reason", which aborted
 * db.exec(SCHEMA) and took the ENTIRE database init down — every route returned
 * 503 SCHEMA_MISMATCH or 500, not just the content ones.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

/** The production table as it existed before the delivery-reason columns. */
function preMigrationDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE content_drafts (
      id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, content_event_id TEXT NOT NULL,
      opportunity_case_id TEXT, alert_id TEXT, claim_packet_id TEXT, category TEXT NOT NULL,
      template_family TEXT NOT NULL, template_version TEXT NOT NULL DEFAULT 'v1',
      platform TEXT NOT NULL DEFAULT 'twitter', draft_text TEXT NOT NULL, char_count INTEGER NOT NULL,
      hashtags_json TEXT, screenshot_suggestion TEXT, chart_annotation TEXT,
      cta_type TEXT NOT NULL DEFAULT 'NONE', result_type TEXT, frozen_entry REAL, mark_used REAL,
      original_alert_at_ms INTEGER, trading_session_date TEXT, status TEXT NOT NULL DEFAULT 'GENERATED',
      discord_delivery_status TEXT NOT NULL DEFAULT 'PENDING', discord_message_id TEXT, final_copy TEXT,
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      approved_at_ms INTEGER, rejected_at_ms INTEGER, manually_posted_at_ms INTEGER
    );
  `);
  db.prepare(
    `INSERT INTO content_drafts
      (id,fingerprint,content_event_id,category,template_family,draft_text,char_count,
       discord_delivery_status,created_at_ms,updated_at_ms)
     VALUES ('d1','f1','e1','CLOSED_WINNER','F0','text',4,'SKIPPED_NO_WEBHOOK',1000,1000)`,
  ).run();
  return db;
}

const MIGRATIONS = [
  ["discord_delivery_reason", "ALTER TABLE content_drafts ADD COLUMN discord_delivery_reason TEXT"],
  ["discord_delivery_explanation", "ALTER TABLE content_drafts ADD COLUMN discord_delivery_explanation TEXT"],
  ["discord_delivery_retryable", "ALTER TABLE content_drafts ADD COLUMN discord_delivery_retryable INTEGER"],
  ["discord_delivery_detail", "ALTER TABLE content_drafts ADD COLUMN discord_delivery_detail TEXT"],
  ["discord_attempt_count", "ALTER TABLE content_drafts ADD COLUMN discord_attempt_count INTEGER NOT NULL DEFAULT 0"],
  ["discord_last_attempt_at_ms", "ALTER TABLE content_drafts ADD COLUMN discord_last_attempt_at_ms INTEGER"],
];
const REASON_INDEX =
  "CREATE INDEX IF NOT EXISTS idx_content_drafts_delivery_reason ON content_drafts(discord_delivery_status, discord_delivery_reason)";

const colNames = (db) => new Set(db.prepare("PRAGMA table_info(content_drafts)").all().map((c) => c.name));

function migrate(db) {
  const have = colNames(db);
  for (const [col, sql] of MIGRATIONS) if (!have.has(col)) db.exec(sql);
  db.exec(REASON_INDEX);
}

test("REGRESSION: the reason index must not run before the column exists", () => {
  const db = preMigrationDb();
  // The shipped defect: index first, ALTERs after.
  assert.throws(
    () => db.exec(REASON_INDEX),
    /no such column/i,
    "declaring this index in SCHEMA is what broke production db init",
  );
});

test("migrating an EXISTING pre-migration table succeeds and is repeat-safe", () => {
  const db = preMigrationDb();
  assert.equal(colNames(db).has("discord_delivery_reason"), false, "precondition: column absent");

  migrate(db);
  migrate(db);
  migrate(db);

  const have = colNames(db);
  for (const [col] of MIGRATIONS) assert.ok(have.has(col), `${col} added`);

  const idx = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_content_drafts_delivery_reason'",
  ).get();
  assert.ok(idx, "index created after the column exists");
});

test("existing rows survive the migration with NULL reasons, never invented ones", () => {
  const db = preMigrationDb();
  migrate(db);
  const row = db.prepare(
    "SELECT id, discord_delivery_status s, discord_delivery_reason r, discord_attempt_count a FROM content_drafts WHERE id='d1'",
  ).get();
  assert.equal(row.s, "SKIPPED_NO_WEBHOOK", "status preserved");
  assert.equal(row.r, null, "no reason was ever recorded for this row — that is NULL, not a guess");
  assert.equal(row.a, 0);
});

/**
 * NOT COVERED HERE, deliberately: the real `getDb()`.
 *
 * `lib/db.ts` imports through the `@/` alias, which the node:test runner does
 * not resolve, so the actual schema path cannot be exercised from a test. That
 * gap is exactly why this defect reached production — every content test builds
 * its own in-memory table and so can never observe SCHEMA running against a
 * long-lived one.
 *
 * The tests above pin the failing SQL itself rather than the module, which is
 * the strongest guard available without reworking the alias setup. Closing the
 * gap properly means giving the test runner the alias (a tsconfig path or an
 * import map) and asserting on `getDb()` against a seeded file.
 */
