/**
 * Delivery truth: only `discord_deliveries.status='SENT'` means the owner received a message.
 *
 * The three sources this file proves are NOT evidence of delivery are exactly the three that
 * exist for a suppressed opening: the owner paper mirror, the opportunity case, and the
 * notify idempotency log. On 2026-08-20 production had all three for ten openings and sent
 * none of them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  loadOwnerDeliveryLedgerOnDb,
  ownerOpeningDeliveriesForCaseOnDb,
  ownerOpeningWasSentOnDb,
  OWNER_OPENING_PAYLOAD_TYPE,
} from "../lib/notifications/owner-delivery-truth.ts";

// 2026-08-20 13:30 ET == 17:30 UTC. Session membership is decided in ET.
const SESSION = "2026-08-20";
const AT = (utcHhMm) => `2026-08-20T${utcHhMm}:00.000Z`;

function db() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE discord_deliveries (
      delivery_id TEXT PRIMARY KEY,
      alert_id INTEGER,
      channel_type TEXT NOT NULL,
      webhook_name TEXT NOT NULL,
      payload_type TEXT NOT NULL,
      payload_preview TEXT,
      payload_json TEXT,
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL,
      attempted_at TEXT,
      sent_at TEXT,
      status TEXT NOT NULL,
      http_status INTEGER,
      response_body_safe TEXT,
      failure_reason TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      opportunity_case_id TEXT,
      thesis_fingerprint TEXT,
      lifecycle_state TEXT,
      delivery_context_json TEXT
    );
  `);
  return d;
}

let seq = 0;
function row(d, over = {}) {
  seq += 1;
  const r = {
    delivery_id: `dd_${seq}`,
    channel_type: "discord_webhook",
    webhook_name: "options",
    payload_type: OWNER_OPENING_PAYLOAD_TYPE,
    payload_json: JSON.stringify({ content: "SPY CALL opening\n\nSPY 08/26 $640 Call" }),
    payload_preview: "preview",
    idempotency_key: `k_${seq}`,
    created_at: AT("17:30"),
    sent_at: null,
    status: "SENT",
    failure_reason: null,
    opportunity_case_id: `oc_${seq}`,
    thesis_fingerprint: `tf_${seq}`,
    lifecycle_state: "OPENING",
    ...over,
  };
  d.prepare(
    `INSERT INTO discord_deliveries
      (delivery_id, channel_type, webhook_name, payload_type, payload_json, payload_preview,
       idempotency_key, created_at, sent_at, status, failure_reason, opportunity_case_id,
       thesis_fingerprint, lifecycle_state)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    r.delivery_id, r.channel_type, r.webhook_name, r.payload_type, r.payload_json, r.payload_preview,
    r.idempotency_key, r.created_at, r.sent_at, r.status, r.failure_reason, r.opportunity_case_id,
    r.thesis_fingerprint, r.lifecycle_state,
  );
  return r;
}

test("SENT is delivered; every other status is NOT SENT", () => {
  const d = db();
  const sent = row(d, { status: "SENT", sent_at: AT("17:30") });
  const suppressed = row(d, { status: "SUPPRESSED", failure_reason: "owner_watch_discord_suppressed" });
  const failed = row(d, { status: "FAILED", failure_reason: "discord 500" });
  const retrying = row(d, { status: "RETRYING", failure_reason: "timeout" });
  const notConfigured = row(d, { status: "NOT_CONFIGURED", failure_reason: "webhook not set" });

  const ledger = loadOwnerDeliveryLedgerOnDb(d, { sessionDate: SESSION });
  assert.equal(ledger.ledgerAvailable, true);
  assert.equal(ledger.delivered.length, 1);
  assert.equal(ledger.delivered[0].deliveryId, sent.delivery_id);
  assert.equal(ledger.notSent.length, 4);
  assert.deepEqual(
    ledger.notSent.map((x) => x.deliveryId).sort(),
    [suppressed, failed, retrying, notConfigured].map((x) => x.delivery_id).sort(),
  );
  assert.equal(ledger.notSentByReason.owner_watch_discord_suppressed, 1);
  d.close();
});

test("delivered and not-sent case id sets are disjoint", () => {
  const d = db();
  row(d, { status: "SENT", opportunity_case_id: "oc_a", sent_at: AT("17:30") });
  row(d, { status: "SUPPRESSED", opportunity_case_id: "oc_b", failure_reason: "owner_watch_discord_suppressed" });
  const ledger = loadOwnerDeliveryLedgerOnDb(d, { sessionDate: SESSION });
  assert.ok(ledger.deliveredCaseIds.has("oc_a"));
  assert.ok(ledger.notSentCaseIds.has("oc_b"));
  assert.ok(!ledger.notSentCaseIds.has("oc_a"));
  assert.ok(!ledger.deliveredCaseIds.has("oc_b"));
  d.close();
});

test("a case suppressed then later SENT counts as delivered exactly once", () => {
  const d = db();
  row(d, { status: "SUPPRESSED", opportunity_case_id: "oc_x", failure_reason: "owner_watch_discord_suppressed" });
  row(d, { status: "SENT", opportunity_case_id: "oc_x", sent_at: AT("18:00") });
  const ledger = loadOwnerDeliveryLedgerOnDb(d, { sessionDate: SESSION });
  assert.equal(ledger.delivered.length, 1);
  assert.ok(ledger.deliveredCaseIds.has("oc_x"));
  // The suppression really happened and is still reported, but the case is not in both sets.
  assert.equal(ledger.notSent.length, 1);
  assert.ok(!ledger.notSentCaseIds.has("oc_x"));
  assert.equal(ownerOpeningWasSentOnDb(d, "oc_x"), true);
  d.close();
});

test("ownerOpeningWasSentOnDb fails closed in every direction", () => {
  const d = db();
  row(d, { status: "SUPPRESSED", opportunity_case_id: "oc_sup", failure_reason: "owner_watch_discord_suppressed" });
  assert.equal(ownerOpeningWasSentOnDb(d, "oc_sup"), false, "suppressed is not sent");
  assert.equal(ownerOpeningWasSentOnDb(d, "oc_missing"), false, "no row is not sent");
  assert.equal(ownerOpeningWasSentOnDb(d, ""), false, "no case id is not sent");
  const empty = new Database(":memory:");
  assert.equal(ownerOpeningWasSentOnDb(empty, "oc_any"), false, "no ledger table is not sent");
  empty.close();
  d.close();
});

test("only the owner opening payload type is read", () => {
  const d = db();
  row(d, { status: "SENT", payload_type: "callout", opportunity_case_id: "oc_sub", sent_at: AT("17:30") });
  row(d, { status: "SENT", payload_type: "stock_buy", opportunity_case_id: "oc_stk", sent_at: AT("17:30") });
  const ledger = loadOwnerDeliveryLedgerOnDb(d, { sessionDate: SESSION });
  assert.equal(ledger.delivered.length, 0, "a subscriber callout is not an owner opening");
  assert.equal(ownerOpeningWasSentOnDb(d, "oc_sub"), false);
  d.close();
});

test("session membership is resolved in ET, not UTC", () => {
  const d = db();
  // 2026-08-20 21:00 ET == 2026-08-21 01:00 UTC. A UTC boundary would file it on the 21st.
  row(d, { status: "SENT", created_at: "2026-08-21T01:00:00.000Z", opportunity_case_id: "oc_late", sent_at: "2026-08-21T01:00:00.000Z" });
  const today = loadOwnerDeliveryLedgerOnDb(d, { sessionDate: SESSION });
  assert.equal(today.delivered.length, 1, "a 21:00 ET delivery belongs to the 20th");
  const tomorrow = loadOwnerDeliveryLedgerOnDb(d, { sessionDate: "2026-08-21" });
  assert.equal(tomorrow.delivered.length, 0);
  d.close();
});

test("a delivery with an unparseable timestamp is excluded from a session, not defaulted in", () => {
  const d = db();
  row(d, { status: "SENT", created_at: "not-a-timestamp", opportunity_case_id: "oc_bad" });
  const ledger = loadOwnerDeliveryLedgerOnDb(d, { sessionDate: SESSION });
  assert.equal(ledger.delivered.length, 0, "an unattributable delivery is not today's evidence");
  // It is still resolvable by case id, which is not session-scoped.
  assert.equal(ownerOpeningWasSentOnDb(d, "oc_bad"), true);
  d.close();
});

test("every attempt on a case is returned, oldest first", () => {
  const d = db();
  row(d, { status: "SUPPRESSED", opportunity_case_id: "oc_m", created_at: AT("17:30"), failure_reason: "owner_watch_discord_suppressed" });
  row(d, { status: "SENT", opportunity_case_id: "oc_m", created_at: AT("18:30"), sent_at: AT("18:30") });
  const rows = ownerOpeningDeliveriesForCaseOnDb(d, "oc_m");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].state, "NOT_SENT");
  assert.equal(rows[1].state, "DELIVERED");
  d.close();
});

test("the headline is the message's first line, never the webhook", () => {
  const d = db();
  row(d, { status: "SENT", opportunity_case_id: "oc_h", sent_at: AT("17:30") });
  const [r] = ownerOpeningDeliveriesForCaseOnDb(d, "oc_h");
  assert.equal(r.headline, "SPY CALL opening");
  assert.ok(!/discord\.com|webhook|https?:/i.test(String(r.headline)));
  d.close();
});

test("a missing ledger reports unavailable rather than an empty delivered day", () => {
  const empty = new Database(":memory:");
  const ledger = loadOwnerDeliveryLedgerOnDb(empty, { sessionDate: SESSION });
  assert.equal(ledger.ledgerAvailable, false);
  assert.equal(ledger.delivered.length, 0);
  empty.close();
});
