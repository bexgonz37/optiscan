import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeIdempotencyKey, isPaperEventType, PAPER_EVENT_TYPES } from "../lib/paper-events.ts";
import {
  deriveOrderState, derivePositionState, ORDER_STATES, POSITION_STATES,
} from "../lib/paper-trading.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

// ── idempotency keys (pure, deterministic) ───────────────────────────────────

test("idempotency key is deterministic for identical inputs", () => {
  const a = makeIdempotencyKey(7, "fill", "entry");
  const b = makeIdempotencyKey(7, "fill", "entry");
  assert.equal(a, b);
});

test("idempotency key varies by trade / event / discriminator", () => {
  assert.notEqual(makeIdempotencyKey(7, "fill", "entry"), makeIdempotencyKey(8, "fill", "entry"));
  assert.notEqual(makeIdempotencyKey(7, "fill", "entry"), makeIdempotencyKey(7, "no_fill", "entry"));
  assert.notEqual(makeIdempotencyKey(7, "mark_updated", "t1"), makeIdempotencyKey(7, "mark_updated", "t2"));
});

test("event-type guard accepts the known set and rejects strangers", () => {
  for (const t of PAPER_EVENT_TYPES) assert.equal(isPaperEventType(t), true);
  assert.equal(isPaperEventType("not_a_real_event"), false);
});

test("the required lifecycle events all exist", () => {
  for (const t of [
    "candidate_created", "validation_started", "validation_passed", "validation_failed",
    "order_submitted", "fill", "no_fill", "position_opened", "mark_updated", "mark_stale",
    "mark_missing", "stop_triggered", "target_triggered", "timeout", "expiration",
    "manual_close", "system_close", "invalidated", "final_outcome", "rejected", "error",
  ]) {
    assert.ok(isPaperEventType(t), `missing event: ${t}`);
  }
});

// ── order / position state derivation (legacy → explicit) ────────────────────

test("legacy status maps to explicit order/position states", () => {
  assert.equal(deriveOrderState("WATCHING"), "CANDIDATE");
  assert.equal(deriveOrderState("READY"), "PENDING");
  assert.equal(deriveOrderState("ENTERED"), "FILLED");
  assert.equal(deriveOrderState("CANCELLED"), "CANCELLED");
  assert.equal(deriveOrderState("EXPIRED"), "EXPIRED");

  assert.equal(derivePositionState("ENTERED"), "OPEN");
  assert.equal(derivePositionState("EXITED"), "CLOSED");
  assert.equal(derivePositionState("STOPPED_OUT"), "CLOSED");
  assert.equal(derivePositionState("TAKE_PROFIT"), "CLOSED");
  assert.equal(derivePositionState("EXPIRED"), "EXPIRED");
  assert.equal(derivePositionState("READY"), null, "not yet a position");
  assert.equal(derivePositionState("CANCELLED"), null);
});

test("state vocabularies contain the rebuild states", () => {
  for (const s of ["CANDIDATE", "VALIDATING", "REJECTED", "PENDING", "FILLED", "PARTIALLY_FILLED", "CANCELLED", "EXPIRED"]) {
    assert.ok(ORDER_STATES.includes(s), `order state ${s}`);
  }
  for (const s of ["OPEN", "EXIT_PENDING", "CLOSED", "EXPIRED", "INVALIDATED", "ERROR"]) {
    assert.ok(POSITION_STATES.includes(s), `position state ${s}`);
  }
});

// ── schema + write contract (source-spec; DB uses the @/ alias) ──────────────

test("paper_events table + unique idempotency index exist in the schema", () => {
  const db = read("lib/db.ts");
  assert.ok(/CREATE TABLE IF NOT EXISTS paper_events/.test(db), "paper_events table");
  assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_events_idem ON paper_events\(idempotency_key\)/.test(db), "unique idempotency index");
});

test("recordPaperEvent writes idempotently (INSERT OR IGNORE on idempotency_key)", () => {
  const src = read("lib/paper-events.ts");
  assert.ok(/INSERT OR IGNORE INTO paper_events/.test(src), "duplicate cycles are no-ops");
  assert.ok(/res\.changes > 0/.test(src), "returns whether a NEW row was written");
});

test("new paper_trades rebuild columns are additive migrations", () => {
  const db = read("lib/db.ts");
  for (const col of [
    "order_state", "position_state", "alert_time_contract_json", "preentry_snapshot_json",
    "preentry_drift_json", "entry_slippage", "entry_fees", "exit_slippage", "exit_fees", "snapshot_version",
  ]) {
    assert.ok(new RegExp(`ALTER TABLE paper_trades ADD COLUMN ${col}`).test(db), `missing additive column: ${col}`);
  }
});

test("option paper entry creation does not require process freshness cache before revalidation", () => {
  const src = read("lib/paper-engine.ts");
  const createBody = src.slice(src.indexOf("export function createPaperTrade"), src.indexOf("/** Manual cancel/close"));
  assert.ok(/alert-time contract snapshot/.test(createBody), "paper order freezes the alert-time contract");
  assert.ok(!/actionableFreshness\(base\.ticker/.test(createBody), "creation must not be blocked by NOT_REQUESTED_YET cache state");
  const sweepBody = src.slice(src.indexOf("export async function sweepPaperTrades"), src.indexOf("// ── Background engine"));
  assert.ok(/fetchOptionChain\(ticker/.test(sweepBody), "the sweep revalidates live chain data before fill");
  assert.ok(/advanceOpenTrade/.test(sweepBody), "fills still go through pre-entry revalidation");
});

test("temporary paper auto-entry refusals are retried instead of permanently cancelling", () => {
  const src = read("lib/paper-engine.ts");
  const helper = src.slice(src.indexOf("function isPermanentAutoEntryRefusal"), src.indexOf("function currentTapeRow"));
  assert.ok(/cooldown/.test(read("lib/paper-risk.ts")), "risk engine has temporary cooldown failures");
  assert.ok(!/cooldown/.test(helper), "cooldown remains retryable, not permanent");
  assert.ok(/auto-entry permanently refused/.test(helper), "permanent markers are explicit");
});

test("daily paper summary is honest and does not synthesize trades", () => {
  const src = read("lib/paper-engine.ts");
  const body = src.slice(src.indexOf("export function dailyPaperSummary"), src.indexOf("function logDecision"));
  assert.ok(/0 high-confidence actionable setups passed all gates/.test(body), "zero-fill day explains no qualifying setups");
  assert.ok(/fills === 0/.test(body), "zero-fill reason is explicit");
  assert.ok(!/INSERT INTO paper_trades/.test(body), "summary is read-only and creates no synthetic daily trade");
});
