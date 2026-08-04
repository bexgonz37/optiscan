/**
 * LEGACY DATABASE UPGRADE — the regression coverage the 0cc84fb outage proved missing.
 *
 * 0cc84fb put `CREATE INDEX ... ON content_drafts(discord_delivery_status,
 * discord_delivery_reason)` inside SCHEMA. On a fresh database that is fine. On a
 * long-lived one `CREATE TABLE IF NOT EXISTS` is a no-op, the reason columns
 * arrive later via ALTER, and the index therefore ran against a column that did
 * not exist. "no such column" aborted db.exec(SCHEMA) — the first statement every
 * database open runs — so EVERY route returned 503 SCHEMA_MISMATCH or 500, not
 * only the content ones. 1a4131a moved the index after its ALTERs.
 *
 * tests/content-drafts-migration.test.mjs guards the shape of that fix, but it
 * re-declares the migration list locally: it can only prove that a COPY of
 * production's ordering is safe. It could not have caught the outage, because the
 * defect lived in the ordering between SCHEMA and migrate() inside lib/db.ts.
 *
 * This file exercises the real thing. tests/helpers/register-alias.mjs teaches
 * node:test the `@/` mapping tsconfig already declares, so the production
 * getDb() — real SCHEMA, real migrate(), real ordering — runs against a real
 * legacy database file on disk. Nothing here restates production migration logic;
 * every assertion is made against whatever lib/db.ts actually did.
 */
import "./helpers/register-alias.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * content_drafts as it existed in production BEFORE the delivery-reason columns,
 * carrying rows — the state every long-lived deployment was actually in.
 * Deliberately NOT the current schema: the point is that init must upgrade it.
 */
const LEGACY_CONTENT_DRAFTS = `
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
  CREATE INDEX idx_content_drafts_event ON content_drafts(content_event_id, created_at_ms);
`;

/** Rows that predate the migration, in the delivery states production actually holds. */
const LEGACY_ROWS = [
  ["legacy-sent", "fp-sent", "evt-1", "CLOSED_WINNER", "SENT", "msg-991", 1_785_000_000_000],
  ["legacy-suppressed", "fp-supp", "evt-2", "CLOSED_WINNER", "SUPPRESSED", null, 1_785_000_100_000],
  ["legacy-failed", "fp-fail", "evt-3", "MILESTONE", "FAILED", null, 1_785_000_200_000],
  ["legacy-nowebhook", "fp-nohook", "evt-4", "MILESTONE", "SKIPPED_NO_WEBHOOK", null, 1_785_000_300_000],
];

function seedLegacyDatabase(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, "optiscan.db"));
  db.exec(LEGACY_CONTENT_DRAFTS);
  const insert = db.prepare(
    `INSERT INTO content_drafts
       (id,fingerprint,content_event_id,category,template_family,draft_text,char_count,
        discord_delivery_status,discord_message_id,created_at_ms,updated_at_ms)
     VALUES (?,?,?,?,'F0','legacy draft text',17,?,?,?,?)`,
  );
  for (const [id, fp, evt, cat, status, msgId, ts] of LEGACY_ROWS) {
    insert.run(id, fp, evt, cat, status, msgId, ts, ts);
  }
  db.close();
}

/** A fresh temp ALERT_DB_DIR seeded with the legacy file, isolated per test. */
function legacyWorkspace(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `optiscan-legacy-${label}-`));
  seedLegacyDatabase(dir);
  return dir;
}

/**
 * Run production's real database initialization, exactly as a cold process does.
 * getDb() memoizes on globalThis, so the cache is cleared first — otherwise the
 * second and third "initializations" would be cache hits proving nothing.
 */
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

function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

function indexes(db, table) {
  return new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND name IS NOT NULL")
      .all(table)
      .map((r) => r.name),
  );
}

function cleanup(dir) {
  const g = globalThis;
  if (g.__optiscanDb) {
    try { g.__optiscanDb.close(); } catch { /* already closed */ }
    delete g.__optiscanDb;
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

test("legacy database: first initialization upgrades a pre-migration table without a missing-column index failure", async () => {
  const dir = legacyWorkspace("first");
  try {
    // The outage was exactly this call throwing. If SCHEMA ever again indexes a
    // migrated column ahead of its ALTER, this line fails and nothing else runs.
    const db = await initializeLikeProduction(dir);

    const cols = columns(db, "content_drafts");
    for (const col of [
      "discord_delivery_reason",
      "discord_delivery_explanation",
      "discord_delivery_retryable",
      "discord_delivery_detail",
      "discord_attempt_count",
      "discord_last_attempt_at_ms",
    ]) {
      assert.ok(cols.has(col), `migration must add ${col} to a legacy content_drafts`);
    }
  } finally {
    cleanup(dir);
  }
});

test("legacy database: the dependent index exists only after the column it references", async () => {
  const dir = legacyWorkspace("ordering");
  try {
    const before = new Database(path.join(dir, "optiscan.db"));
    assert.ok(
      !columns(before, "content_drafts").has("discord_delivery_reason"),
      "fixture must start without the column, or it cannot observe the ordering",
    );
    assert.ok(
      !indexes(before, "content_drafts").has("idx_content_drafts_delivery_reason"),
      "fixture must start without the index",
    );
    // Negative control: this is the failure production suffered. It proves the
    // fixture really is a pre-migration table and that the ordering is load-bearing.
    assert.throws(
      () =>
        before.exec(
          "CREATE INDEX IF NOT EXISTS idx_content_drafts_delivery_reason ON content_drafts(discord_delivery_status, discord_delivery_reason)",
        ),
      /no such column/i,
      "indexing before the ALTER must still be the fatal operation this test guards",
    );
    before.close();

    const db = await initializeLikeProduction(dir);
    assert.ok(
      columns(db, "content_drafts").has("discord_delivery_reason"),
      "column must exist after real init",
    );
    assert.ok(
      indexes(db, "content_drafts").has("idx_content_drafts_delivery_reason"),
      "index must exist after real init — the fix is ordering, not deletion",
    );
  } finally {
    cleanup(dir);
  }
});

test("legacy database: second and third initializations remain safe and change nothing", async () => {
  const dir = legacyWorkspace("repeat");
  try {
    const first = await initializeLikeProduction(dir);
    const firstCols = [...columns(first, "content_drafts")].sort();
    const firstIdx = [...indexes(first, "content_drafts")].sort();

    const second = await initializeLikeProduction(dir);
    assert.deepEqual([...columns(second, "content_drafts")].sort(), firstCols, "2nd init must not alter columns");
    assert.deepEqual([...indexes(second, "content_drafts")].sort(), firstIdx, "2nd init must not alter indexes");

    const third = await initializeLikeProduction(dir);
    assert.deepEqual([...columns(third, "content_drafts")].sort(), firstCols, "3rd init must not alter columns");
    assert.deepEqual([...indexes(third, "content_drafts")].sort(), firstIdx, "3rd init must not alter indexes");
  } finally {
    cleanup(dir);
  }
});

test("legacy database: existing rows survive, and new nullable fields stay NULL rather than invented", async () => {
  const dir = legacyWorkspace("rows");
  try {
    let db = await initializeLikeProduction(dir);
    // Three initializations, because a migration that rewrites rows tends to do
    // it on the pass that finds the column already present.
    db = await initializeLikeProduction(dir);
    db = await initializeLikeProduction(dir);

    const rows = db.prepare("SELECT * FROM content_drafts ORDER BY created_at_ms").all();
    assert.equal(rows.length, LEGACY_ROWS.length, "no legacy row may be dropped by the upgrade");

    for (const row of rows) {
      const [, , , , expectedStatus, expectedMsgId] =
        LEGACY_ROWS.find(([id]) => id === row.id) ?? [];
      assert.equal(row.discord_delivery_status, expectedStatus, `${row.id} delivery status preserved`);
      assert.equal(row.discord_message_id, expectedMsgId, `${row.id} message id preserved`);
      assert.equal(row.draft_text, "legacy draft text", `${row.id} payload preserved`);

      // The historical reason was never recorded. The upgrade must not guess one:
      // a fabricated reason is indistinguishable from evidence downstream.
      assert.equal(row.discord_delivery_reason, null, `${row.id} legacy reason must remain NULL`);
      assert.equal(row.discord_delivery_explanation, null, `${row.id} legacy explanation must remain NULL`);
      assert.equal(row.discord_delivery_retryable, null, `${row.id} legacy retryable must remain NULL`);
      assert.equal(row.discord_delivery_detail, null, `${row.id} legacy detail must remain NULL`);
      assert.equal(row.discord_last_attempt_at_ms, null, `${row.id} legacy attempt time must remain NULL`);

      // The one new column with a DEFAULT — backfilled to its declared default,
      // which is a fact about the schema, not an invented claim about the past.
      assert.equal(row.discord_attempt_count, 0, `${row.id} attempt count takes its declared default`);
    }
  } finally {
    cleanup(dir);
  }
});

/**
 * The outage was not scoped to content_drafts: SCHEMA is the first thing every
 * database open runs, so unrelated routes returned 503/500 too. These assert the
 * blast radius is closed — each route's own database entry point must work
 * against a migrated legacy file.
 */
test("legacy database: /api/discord/health can open a migrated legacy database", async () => {
  const dir = legacyWorkspace("discord-health");
  try {
    const db = await initializeLikeProduction(dir);
    const { discordDeliverySummary, discordDeliveryWindowMetrics } = await import("@/lib/alert-store");
    assert.doesNotThrow(() => discordDeliverySummary(), "delivery summary must read a migrated legacy database");
    assert.doesNotThrow(() => discordDeliveryWindowMetrics(24), "window metrics must read a migrated legacy database");
    assert.ok(db.prepare("SELECT count(*) n FROM discord_deliveries").get(), "route's table must be reachable");
  } finally {
    cleanup(dir);
  }
});

test("legacy database: /api/opportunity-cases can open a migrated legacy database", async () => {
  const dir = legacyWorkspace("opportunity-cases");
  try {
    const db = await initializeLikeProduction(dir);
    const { listRecentOpportunityCasesOnDb } = await import("@/lib/opportunity-case/store");
    assert.doesNotThrow(
      () => listRecentOpportunityCasesOnDb(db, 50),
      "opportunity cases must list against a migrated legacy database",
    );
  } finally {
    cleanup(dir);
  }
});

test("legacy database: /api/content-drafts can open a migrated legacy database and still sees legacy rows", async () => {
  const dir = legacyWorkspace("content-drafts");
  try {
    const db = await initializeLikeProduction(dir);
    const { listContentDraftsOnDb } = await import("@/lib/content/content-drafts-runtime");
    const drafts = listContentDraftsOnDb(db, { limit: 50 });
    assert.ok(Array.isArray(drafts), "content drafts must list against a migrated legacy database");
    assert.equal(drafts.length, LEGACY_ROWS.length, "the route must see the pre-migration rows, not an empty table");
  } finally {
    cleanup(dir);
  }
});
