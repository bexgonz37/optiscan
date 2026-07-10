import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Persistence spec tests. lib/opportunity-store.ts uses the "@/lib/db" alias so
 * it cannot be imported by the node test runner directly (same convention as
 * the quant layer). These lock the persistence guarantees at the source level;
 * the transition/hysteresis math is runtime-tested in
 * tests/opportunity-lifecycle.test.mjs.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("opportunities table exists with all persisted lifecycle fields", () => {
  const db = read("lib/db.ts");
  assert.ok(/CREATE TABLE IF NOT EXISTS opportunities/.test(db), "opportunities table missing");
  for (const col of [
    "opportunity_id", "ticker", "setup_type", "trading_day", "first_detected_at",
    "last_updated_at", "highest_score", "current_score", "previous_status",
    "current_status", "trigger_level", "entry_zone", "invalidation_level",
    "expiration_time", "demote_streak", "status_since",
  ]) {
    assert.ok(new RegExp(`\\b${col}\\b`).test(db), `opportunities.${col} missing from schema`);
  }
});

test("opportunities are keyed uniquely per (ticker, setup_type, trading_day)", () => {
  const db = read("lib/db.ts");
  assert.ok(
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_opportunities_key ON opportunities\(ticker, setup_type, trading_day\)/.test(db),
    "unique per-day key index missing — repeated scans could duplicate opportunities",
  );
});

test("store upserts ONE record per key (ON CONFLICT), never inserts duplicates", () => {
  const store = read("lib/opportunity-store.ts");
  assert.ok(/ON CONFLICT\(opportunity_id\) DO UPDATE/.test(store), "upsert must be ON CONFLICT DO UPDATE");
  assert.ok(/tradingDay/.test(store), "records must be day-scoped");
  assert.ok(/reconcile\(/.test(store), "store must fold via the pure reconcile()");
});

test("store loads the prior record before reconciling (evolves, not replaces)", () => {
  const store = read("lib/opportunity-store.ts");
  assert.ok(/SELECT \* FROM opportunities WHERE opportunity_id=\?/.test(store), "must load prev record");
  assert.ok(/const prev = prevRow \? rowToRecord\(prevRow\) : null/.test(store), "prev passed to reconcile");
});

test("scanner loop ingests opportunities, throttled and guarded", () => {
  const loop = read("lib/scanner-loop.ts");
  assert.ok(/upsertOpportunities/.test(loop), "loop must upsert opportunities");
  assert.ok(/signalsFromTape/.test(loop), "loop must map tape to signals");
  assert.ok(/OPP_INGEST_MS/.test(loop), "ingest must be throttled");
  assert.ok(/OPPORTUNITY_TRACKING/.test(loop), "ingest must be disableable");
  assert.ok(/bearishActionable\(\)/.test(loop), "bearish gate state must flow into the map");
});

test("GET /api/opportunities is read-only and groups by bucket", () => {
  const route = read("app/api/opportunities/route.ts");
  assert.ok(/groupedOpportunities/.test(route), "route must return grouped buckets");
  assert.ok(!/export async function (POST|PUT|DELETE|PATCH)/.test(route), "route must be read-only (GET only)");
  assert.ok(!/polyFetch|fetchBulkQuotes|fetchOptionChain/.test(route), "route must not call providers");
});
