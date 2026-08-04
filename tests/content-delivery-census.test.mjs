/**
 * Content delivery census — the counts must be whole-table, and an unavailable
 * count must never render as a real zero.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { buildContentDeliveryCensus } from "../lib/content/content-delivery-census.ts";
import { listContentDraftsOnDb } from "../lib/content/content-drafts-runtime.ts";

function makeDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE content_drafts (
      id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, content_event_id TEXT NOT NULL,
      opportunity_case_id TEXT, alert_id TEXT, claim_packet_id TEXT, category TEXT NOT NULL,
      template_family TEXT NOT NULL, template_version TEXT NOT NULL DEFAULT 'v1', platform TEXT NOT NULL DEFAULT 'twitter',
      draft_text TEXT NOT NULL, char_count INTEGER NOT NULL, hashtags_json TEXT, screenshot_suggestion TEXT,
      chart_annotation TEXT, cta_type TEXT NOT NULL DEFAULT 'NONE', result_type TEXT,
      frozen_entry REAL, mark_used REAL, original_alert_at_ms INTEGER, trading_session_date TEXT,
      status TEXT NOT NULL DEFAULT 'GENERATED', discord_delivery_status TEXT NOT NULL DEFAULT 'PENDING',
      discord_message_id TEXT, final_copy TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      approved_at_ms INTEGER, rejected_at_ms INTEGER, manually_posted_at_ms INTEGER
    );
    CREATE TABLE opportunity_content_events (
      id TEXT PRIMARY KEY, symbol TEXT, event_type TEXT, occurred_at_ms INTEGER
    );
  `);
  return db;
}

let seq = 0;
function addDraft(db, { eventId, status, createdAtMs, messageId = null }) {
  seq += 1;
  db.prepare(
    `INSERT INTO content_drafts
      (id,fingerprint,content_event_id,category,template_family,draft_text,char_count,
       discord_delivery_status,discord_message_id,created_at_ms,updated_at_ms)
     VALUES (?,?,?,'CLOSED_WINNER','F0','text',4,?,?,?,?)`,
  ).run(`d${seq}`, `f${seq}`, eventId, status, messageId, createdAtMs, createdAtMs);
}

test("a missing table is NOT_INITIALIZED with null counts — never a zero", () => {
  const db = new Database(":memory:");
  const c = buildContentDeliveryCensus(db);
  assert.equal(c.state, "NOT_INITIALIZED");
  assert.equal(c.total, null);
  assert.equal(c.delivered, null);
  assert.equal(c.eligibleForRecovery, null);
});

test("an empty table is GENUINELY_EMPTY and says zero, because zero is true", () => {
  const c = buildContentDeliveryCensus(makeDb());
  assert.equal(c.state, "GENUINELY_EMPTY");
  assert.equal(c.total, 0);
  assert.deepEqual(c.byDeliveryStatus, {});
});

test("a read failure is READ_FAILED with null counts, not an empty set", () => {
  const broken = {
    prepare(sql) {
      if (sql.includes("sqlite_master")) return { get: () => ({ 1: 1 }), all: () => [] };
      throw new Error("disk I/O error");
    },
  };
  const c = buildContentDeliveryCensus(broken);
  assert.equal(c.state, "READ_FAILED");
  assert.equal(c.total, null);
  assert.equal(c.delivered, null);
  assert.match(c.headline, /could not be read/);
});

test("counts every delivery status across the whole table", () => {
  const db = makeDb();
  addDraft(db, { eventId: "e1", status: "SENT", createdAtMs: 1000, messageId: "m1" });
  addDraft(db, { eventId: "e1", status: "SENT", createdAtMs: 1001, messageId: "m2" });
  addDraft(db, { eventId: "e2", status: "FAILED", createdAtMs: 2000 });
  addDraft(db, { eventId: "e3", status: "SKIPPED_NO_WEBHOOK", createdAtMs: 3000 });
  addDraft(db, { eventId: "e4", status: "SKIPPED_NO_WEBHOOK", createdAtMs: 4000 });

  const c = buildContentDeliveryCensus(db);
  assert.equal(c.state, "DATA_PRESENT");
  assert.equal(c.total, 5);
  assert.equal(c.delivered, 2);
  assert.equal(c.deliveredWithMessageId, 2);
  assert.equal(c.failed, 1);
  // FAILED is retryable, so it counts toward the recovery backlog.
  assert.equal(c.eligibleForRecovery, 3);
  assert.equal(c.eventsAwaitingRecovery, 3);
  assert.equal(c.oldestUndeliveredAtMs, 2000);
  assert.equal(c.scansToDrainBacklog, 3);
});

test("REGRESSION: the census sees recovery that the 200-row list endpoint hides", () => {
  // The 2026-08-04 false reading. Recovery drains OLDEST-first; the list endpoint
  // returns at most 200 rows ordered created_at_ms DESC. With more than 200
  // drafts, every recovered row sits outside that window, so the endpoint shows
  // 200/200 undelivered no matter how much progress recovery has made.
  const db = makeDb();
  for (let i = 0; i < 60; i++) addDraft(db, { eventId: `old${i}`, status: "SENT", createdAtMs: 1_000 + i, messageId: `m${i}` });
  for (let i = 0; i < 250; i++) addDraft(db, { eventId: `new${i}`, status: "SKIPPED_NO_WEBHOOK", createdAtMs: 900_000 + i });

  const page = listContentDraftsOnDb(db, { limit: 500 });
  assert.equal(page.length, 200, "the list endpoint hard-caps at 200 rows");
  assert.ok(
    page.every((r) => r.discord_delivery_status === "SKIPPED_NO_WEBHOOK"),
    "and every visible row is undelivered — which looks like total failure",
  );

  const c = buildContentDeliveryCensus(db);
  assert.equal(c.total, 310, "the census counts the whole table");
  assert.equal(c.delivered, 60, "and can see the 60 rows recovery already delivered");
  assert.equal(c.eligibleForRecovery, 250);
});

test("the census makes no provider call and writes nothing", () => {
  const db = makeDb();
  addDraft(db, { eventId: "e1", status: "SENT", createdAtMs: 1000, messageId: "m1" });
  const before = db.prepare("SELECT COUNT(*) n FROM content_drafts").get().n;
  const statuses = db.prepare("SELECT discord_delivery_status s FROM content_drafts").all();
  buildContentDeliveryCensus(db);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM content_drafts").get().n, before);
  assert.deepEqual(db.prepare("SELECT discord_delivery_status s FROM content_drafts").all(), statuses);
});
