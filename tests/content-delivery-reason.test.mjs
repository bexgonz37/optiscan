/**
 * Delivery reason codes — a transient refusal must never terminate a draft, and
 * a reason must never carry a secret.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  classifyDeliveryResult,
  describeReason,
  redactForPersistence,
} from "../lib/content/delivery-reason.ts";
import { buildContentDeliveryCensus } from "../lib/content/content-delivery-census.ts";

test("a successful send is SENT and terminal", () => {
  const r = classifyDeliveryResult({ ok: true, messageId: "123" });
  assert.equal(r.code, "SENT");
  assert.equal(r.status, "SENT");
  assert.equal(r.retryable, false);
});

test("REGRESSION: a rate limit is TRANSIENT and returns the draft to the queue", () => {
  // The production defect. contentDrafts runs every 3 min; the recap guard allows
  // MAX_POSTS=2 per 10 min, so ~40% of sweeps are refused for budget alone. The
  // old code wrote SUPPRESSED, which is not in RETRYABLE_DELIVERY_STATES, so each
  // of those drafts was permanently destroyed by a momentary channel budget.
  const r = classifyDeliveryResult({ ok: false, suppressed: true, error: "recap suppressed: rate_limited" });
  assert.equal(r.code, "SUPPRESSED_RATE_LIMIT");
  assert.equal(r.retryable, true);
  assert.equal(r.status, "PENDING", "PENDING is retryable; SUPPRESSED is not");
  assert.notEqual(r.status, "SUPPRESSED");
});

test("in_flight and retry_backoff are transient too", () => {
  for (const [raw, code] of [["in_flight", "SUPPRESSED_IN_FLIGHT"], ["retry_backoff", "SUPPRESSED_RETRY_BACKOFF"]]) {
    const r = classifyDeliveryResult({ ok: false, suppressed: true, error: `recap suppressed: ${raw}` });
    assert.equal(r.code, code);
    assert.equal(r.retryable, true);
    assert.equal(r.status, "PENDING");
  }
});

test("a genuine duplicate stays TERMINAL — dedup is not weakened", () => {
  const r = classifyDeliveryResult({ ok: false, suppressed: true, error: "recap suppressed: duplicate" });
  assert.equal(r.code, "SUPPRESSED_DUPLICATE");
  assert.equal(r.retryable, false);
  assert.equal(r.status, "SUPPRESSED");
});

test("retry_exhausted stays terminal", () => {
  const r = classifyDeliveryResult({ ok: false, suppressed: true, error: "recap suppressed: retry_exhausted" });
  assert.equal(r.code, "SUPPRESSED_RETRY_EXHAUSTED");
  assert.equal(r.retryable, false);
});

test("the kill switch defers rather than discards — the owner can turn it back on", () => {
  const r = classifyDeliveryResult({ ok: false, suppressed: true, error: "recap suppressed: disabled" });
  assert.equal(r.code, "DISABLED_BY_KILL_SWITCH");
  assert.equal(r.retryable, true);
  assert.equal(r.status, "SKIPPED_NO_WEBHOOK");
});

test("an UNRECOGNIZED suppression is treated as transient, not terminal", () => {
  // A new guard verdict must not silently inherit "delete this draft".
  const r = classifyDeliveryResult({ ok: false, suppressed: true, error: "recap suppressed: some_future_reason" });
  assert.equal(r.retryable, true);
});

test("transport failures classify separately and only 4xx is non-retryable", () => {
  assert.equal(classifyDeliveryResult({ ok: false, error: "discord 400: bad" }).code, "FAILED_DISCORD_REJECTED");
  assert.equal(classifyDeliveryResult({ ok: false, error: "discord 400: bad" }).retryable, false);
  assert.equal(classifyDeliveryResult({ ok: false, error: "discord 503: nope" }).code, "FAILED_NETWORK");
  assert.equal(classifyDeliveryResult({ ok: false, error: "discord 503: nope" }).retryable, true);
  assert.equal(classifyDeliveryResult({ ok: false, error: "The operation timed out" }).code, "FAILED_TIMEOUT");
  assert.equal(classifyDeliveryResult({ ok: false, error: "DISCORD_WEBHOOK_RECAP not configured" }).code, "FAILED_CONFIGURATION");
  assert.equal(classifyDeliveryResult({ ok: false, error: "" }).code, "FAILED_UNKNOWN");
});

test("every reason code carries a non-empty owner-safe explanation", () => {
  const codes = [
    "SENT", "SUPPRESSED_DUPLICATE", "SUPPRESSED_RATE_LIMIT", "SUPPRESSED_IN_FLIGHT",
    "SUPPRESSED_RETRY_BACKOFF", "SUPPRESSED_RETRY_EXHAUSTED", "SUPPRESSED_PERSISTENCE_FAILED",
    "DISABLED_BY_KILL_SWITCH", "SKIPPED_NO_WEBHOOK", "FAILED_DISCORD_REJECTED",
    "FAILED_NETWORK", "FAILED_TIMEOUT", "FAILED_INVALID_PAYLOAD", "FAILED_CONFIGURATION", "FAILED_UNKNOWN",
  ];
  for (const c of codes) {
    const r = describeReason(c);
    assert.ok(r.explanation && r.explanation.length > 10, `${c} needs an explanation`);
    assert.equal(r.code, c);
  }
});

test("a webhook URL or token never reaches the persisted detail", () => {
  const secret = "https://discord.com/api/webhooks/123456/aVeryRealTokenValue";
  const out = redactForPersistence(`discord 401 posting to ${secret}`);
  assert.ok(!out.includes("aVeryRealTokenValue"), "the token must not survive");
  assert.ok(!out.includes("discord.com/api/webhooks"), "the webhook path must not survive");
  assert.match(out, /redacted/);
  assert.equal(redactForPersistence(null), null);
  assert.equal(redactForPersistence("   "), null);
  assert.ok(!redactForPersistence("Authorization: Bearer sk-abc123").includes("sk-abc123"));
});

// ── census reason breakdown ────────────────────────────────────────────────

function makeDb({ withReasonColumns } = { withReasonColumns: true }) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE content_drafts (
      id TEXT PRIMARY KEY, content_event_id TEXT NOT NULL,
      discord_delivery_status TEXT NOT NULL DEFAULT 'PENDING',
      discord_message_id TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
      ${withReasonColumns ? ", discord_delivery_reason TEXT, discord_delivery_retryable INTEGER" : ""}
    );
  `);
  return db;
}

let n = 0;
function add(db, status, reason, retryable) {
  n += 1;
  const hasCols = reason !== undefined;
  if (hasCols) {
    db.prepare(
      `INSERT INTO content_drafts (id,content_event_id,discord_delivery_status,created_at_ms,updated_at_ms,discord_delivery_reason,discord_delivery_retryable)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(`d${n}`, `e${n}`, status, 1000 + n, 1000 + n, reason, retryable ?? null);
  } else {
    db.prepare(
      "INSERT INTO content_drafts (id,content_event_id,discord_delivery_status,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?)",
    ).run(`d${n}`, `e${n}`, status, 1000 + n, 1000 + n);
  }
}

test("the census splits suppressions and failures by reason", () => {
  const db = makeDb();
  add(db, "SUPPRESSED", "SUPPRESSED_DUPLICATE", 0);
  add(db, "SUPPRESSED", "SUPPRESSED_DUPLICATE", 0);
  add(db, "SUPPRESSED", "SUPPRESSED_RETRY_EXHAUSTED", 0);
  add(db, "FAILED", "FAILED_NETWORK", 1);
  add(db, "FAILED", "FAILED_DISCORD_REJECTED", 0);
  add(db, "SENT", "SENT", 0);

  const c = buildContentDeliveryCensus(db);
  assert.deepEqual(c.suppressedByReason, { SUPPRESSED_DUPLICATE: 2, SUPPRESSED_RETRY_EXHAUSTED: 1 });
  assert.deepEqual(c.failedByReason, { FAILED_NETWORK: 1, FAILED_DISCORD_REJECTED: 1 });
  assert.equal(c.retryableFailures, 1);
  assert.equal(c.nonRetryableFailures, 1);
});

test("rows written before reasons existed are counted as 'none recorded', not invented", () => {
  const db = makeDb();
  add(db, "SUPPRESSED", null, null);
  add(db, "SENT", "SENT", 0);
  const c = buildContentDeliveryCensus(db);
  assert.equal(c.withoutRecordedReason, 1);
  assert.equal(c.byReason["<none recorded>"], 1);
});

test("a database predating the reason columns reports null, never zero", () => {
  const db = makeDb({ withReasonColumns: false });
  add(db, "SUPPRESSED");
  const c = buildContentDeliveryCensus(db);
  assert.equal(c.state, "DATA_PRESENT");
  assert.equal(c.total, 1, "statuses are still countable");
  assert.equal(c.byReason, null, "but reasons were never recorded — that is null, not 0");
  assert.equal(c.suppressedByReason, null);
  assert.equal(c.retryableFailures, null);
});
