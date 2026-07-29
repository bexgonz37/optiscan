import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  claimRecapDelivery,
  completeRecapDelivery,
  recapDeliveryEnabled,
} from "../lib/notifications/recap-delivery-guard.ts";

test("recap kill switch is recap-specific and defaults enabled", () => {
  assert.equal(recapDeliveryEnabled({}), true);
  assert.equal(recapDeliveryEnabled({ DISCORD_RECAP_ENABLED: "0" }), false);
  assert.equal(recapDeliveryEnabled({ DISCORD_RECAP_ENABLED: "1" }), true);
});

test("atomic recap claims suppress duplicates and cap posts at two per ten minutes", () => {
  const db = new Database(":memory:");
  const now = Date.parse("2026-07-29T14:00:00.000Z");
  const first = claimRecapDelivery(db, { payload: { content: "DAILY RECAP A" }, nowMs: now });
  assert.equal(first.allowed, true);
  completeRecapDelivery(db, first.idempotencyKey, { ok: true, messageId: "m1", nowMs: now + 1 });

  const duplicate = claimRecapDelivery(db, { payload: { content: "DAILY RECAP A" }, nowMs: now + 2 });
  assert.equal(duplicate.allowed, false);
  assert.equal(duplicate.reason, "duplicate");

  const second = claimRecapDelivery(db, { payload: { content: "CONTENT DRAFT B" }, nowMs: now + 3 });
  assert.equal(second.allowed, true);
  completeRecapDelivery(db, second.idempotencyKey, { ok: true, messageId: "m2", nowMs: now + 4 });

  const third = claimRecapDelivery(db, { payload: { content: "MISSED OPPORTUNITY C" }, nowMs: now + 5 });
  assert.equal(third.allowed, false);
  assert.equal(third.reason, "rate_limited");
  const row = db.prepare("SELECT status, suppression_reason FROM recap_delivery_claims WHERE idempotency_key=?").get(third.idempotencyKey);
  assert.deepEqual(row, { status: "SUPPRESSED", suppression_reason: "rate_limited" });
});

test("failed recap delivery uses bounded exponential retry backoff", () => {
  const db = new Database(":memory:");
  const now = Date.parse("2026-07-29T15:00:00.000Z");
  const first = claimRecapDelivery(db, { payload: { content: "WEEKLY RECAP" }, nowMs: now });
  completeRecapDelivery(db, first.idempotencyKey, { ok: false, error: "timeout", nowMs: now });
  const tooSoon = claimRecapDelivery(db, {
    payload: { content: "WEEKLY RECAP" },
    nowMs: now + 10_000,
  });
  assert.equal(tooSoon.reason, "retry_backoff");
  const retry = claimRecapDelivery(db, {
    payload: { content: "WEEKLY RECAP" },
    nowMs: now + 31_000,
  });
  assert.equal(retry.allowed, true);
  completeRecapDelivery(db, retry.idempotencyKey, { ok: false, error: "timeout", nowMs: now + 31_000 });
  const row = db.prepare("SELECT attempt_count, status, next_retry_at_ms FROM recap_delivery_claims WHERE idempotency_key=?").get(first.idempotencyKey);
  assert.equal(row.attempt_count, 2);
  assert.equal(row.status, "FAILED");
  assert.ok(row.next_retry_at_ms > now + 31_000);
});
