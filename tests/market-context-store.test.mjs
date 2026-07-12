import test from "node:test";
import assert from "node:assert/strict";
import { persistMarketContextOnDb } from "../lib/market-context-store.ts";
import { buildMarketContext } from "../lib/market-context.ts";

let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch {
  Database = null;
}

const DDL = `
CREATE TABLE IF NOT EXISTS market_context_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, context_version INTEGER NOT NULL, session TEXT,
  risk_state TEXT NOT NULL, structure TEXT NOT NULL, volatility TEXT NOT NULL, freshness TEXT NOT NULL,
  spy_trend TEXT, qqq_trend TEXT, vwap_state TEXT, conflict_flags TEXT, context_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);`;

const NOW = Date.parse("2026-07-09T15:00:00Z");

test("gather uses the existing scanner tape, never a direct provider call (source-spec)", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(join(root, "lib/market-context-store.ts"), "utf8");
  assert.ok(/loopState/.test(src), "reads the existing scanner tape");
  // No provider CALLS in the gather path (a prose mention of polyFetch is fine).
  assert.ok(!/polyFetch\(|fetchOptionChain\(|fetch\(|require\(["']@\/lib\/polygon-provider["']\)/.test(src), "no direct provider bypass");
  const dbsrc = readFileSync(join(root, "lib/db.ts"), "utf8");
  assert.ok(/CREATE TABLE IF NOT EXISTS market_context_snapshots/.test(dbsrc));
});

if (Database) {
  test("persist writes a snapshot and never mutates prior rows", () => {
    const db = new Database(":memory:");
    db.exec(DDL);
    const ctx = buildMarketContext({ session: "regular", spy: { symbol: "SPY", changePercent: 0.8, aboveVwap: true, freshnessOk: true }, qqq: { symbol: "QQQ", changePercent: 0.9, aboveVwap: true, freshnessOk: true }, vix: null, nowMs: NOW });
    const id1 = persistMarketContextOnDb(db, ctx, NOW);
    const id2 = persistMarketContextOnDb(db, ctx, NOW + 1000);
    assert.notEqual(id1, id2); // append-only
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM market_context_snapshots").get().n, 2);
    const row = db.prepare("SELECT * FROM market_context_snapshots WHERE id=?").get(id1);
    assert.equal(row.risk_state, "RISK_ON");
    assert.equal(row.context_version, ctx.contextVersion);
    assert.deepEqual(JSON.parse(row.context_json).spyTrend, "UP");
  });

  test("UNKNOWN context persists honestly (no fabricated regime)", () => {
    const db = new Database(":memory:");
    db.exec(DDL);
    const ctx = buildMarketContext({ session: "premarket", spy: null, qqq: null, vix: null, nowMs: NOW });
    persistMarketContextOnDb(db, ctx, NOW);
    const row = db.prepare("SELECT * FROM market_context_snapshots ORDER BY id DESC LIMIT 1").get();
    assert.equal(row.risk_state, "UNKNOWN");
    assert.equal(row.freshness, "UNKNOWN");
  });
}
