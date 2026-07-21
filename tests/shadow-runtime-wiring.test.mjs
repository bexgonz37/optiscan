import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { ShadowQueue, shadowQueue } from "../lib/research/shadow/queue.ts";
import { enqueueShadowCycle } from "../lib/research/shadow/cycle.ts";

const SHADOW_DDL = `
CREATE TABLE IF NOT EXISTS discovery_shadow (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, sources_json TEXT, price REAL, change_pct REAL, rel_volume REAL, dollar_volume REAL, eligible INTEGER NOT NULL, exclusions_json TEXT, options_checked INTEGER NOT NULL DEFAULT 0, observed_at_ms INTEGER NOT NULL, created_at_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS analog_shadow (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, t0_ms INTEGER NOT NULL, tag TEXT NOT NULL DEFAULT 'ANALOG_SHADOW_ONLY', abstain INTEGER NOT NULL, abstain_reason TEXT, comparable_count INTEGER, effective_sample INTEGER, confidence REAL, win_rate REAL, dispersion REAL, contradiction REAL, fwd_p10 REAL, fwd_p50 REAL, fwd_p90 REAL, nearest_distance REAL, agrees_with_live INTEGER, agreement TEXT, lookup_ms INTEGER, created_at_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS market_context_shadow (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT, as_of_ms INTEGER NOT NULL, regime TEXT, vol_regime TEXT, spy_trend TEXT, qqq_trend TEXT, iwm_trend TEXT, sector TEXT, industry TEXT, sector_rel_strength REAL, breadth REAL, catalyst_category TEXT, earnings_in_days INTEGER, session TEXT, missing_json TEXT, context_json TEXT, created_at_ms INTEGER NOT NULL);`;
function db() { const d = new Database(":memory:"); d.exec(SHADOW_DDL); return d; }
const ON = { BROAD_DISCOVERY_SHADOW_ENABLED: "1", ANALOG_LIVE_SHADOW_ENABLED: "1", MARKET_CONTEXT_CAPTURE_ENABLED: "1" };
const quotes = [{ symbol: "ASTS", price: 20, changePercent: 12, volume: 3_000_000, observedAtMs: 1000 }, { symbol: "IREN", price: 12, changePercent: 9, volume: 5_000_000, observedAtMs: 1000 }];
const explain = { abstain: false, reason: null, p: 0.6, nAnalogs: 40, effectiveSample: 30, winRate: 0.6, expectancy: 0.1, dispersion: 0.4, contradiction: 0.4, p10: -0.5, p50: 0.3, p90: 1.1, nearest: [{ id: "n", distance: 0.2, win: true, outcome: 0.5 }], nearestWin: null, nearestLoss: null };

// ── bounded queue mechanics ──
test("queue dedups identical keys and drops on saturation — no throw", () => {
  const q = new ShadowQueue({ concurrency: 1, maxDepth: 2 });
  assert.equal(q.submit("k1", async () => {}), true);
  assert.equal(q.submit("k1", async () => {}), false, "dedup");
  q.submit("k2", async () => {}); q.submit("k3", async () => {});
  const beyond = q.submit("k4", async () => {}); // depth cap
  assert.equal(beyond, false, "backpressure drop");
  const m = q.metrics();
  assert.ok(m.deduped >= 1 && m.dropped >= 1);
});

test("a task NEVER runs during submit (fire-and-forget); slow sync work does not block the caller", () => {
  const q = new ShadowQueue({ concurrency: 1 });
  let ran = false;
  const t0 = Date.now();
  q.submit("slow", async () => { const end = Date.now() + 40; while (Date.now() < end) {} ran = true; });
  assert.equal(ran, false, "task deferred — submit returned before it ran");
  assert.ok(Date.now() - t0 < 10, "submit returned immediately");
});

test("a hanging task times out and is isolated (counted, never thrown)", async () => {
  const q = new ShadowQueue({ concurrency: 1, taskTimeoutMs: 20 });
  q.submit("hang", () => new Promise(() => {})); // never resolves
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(q.metrics().timeouts, 1);
});

// ── cycle wiring (the missing runtime link) ──
test("2/10. flags OFF ⇒ no records, and the cycle call returns undefined (no actionable effect)", async () => {
  const d = db();
  const ret = enqueueShadowCycle({ nowMs: 1000, quotes }, { getDb: () => d }, {}); // no flags
  assert.equal(ret, undefined);
  await shadowQueue().drain();
  assert.equal(d.prepare("SELECT COUNT(*) n FROM discovery_shadow").get().n, 0);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM analog_shadow").get().n, 0);
});

test("1. enabling the flags creates records from live candidate events", async () => {
  const d = db();
  enqueueShadowCycle({ nowMs: 2000, quotes }, { getDb: () => d, scorer: { explain: () => explain }, featuresFor: (s) => ({ velPct: 1, accelPct: 0.2, rvol: 4, realizedVol: 0.02, atrPct: 1, posInRange: 0.8, gapPct: 0.5, liquidityTier: "high", direction: "bullish", symbol: s }), liveDecisionFor: () => ({ actionable: true, direction: "bullish" }), contextFor: () => null }, ON);
  await shadowQueue().drain();
  assert.ok(d.prepare("SELECT COUNT(*) n FROM discovery_shadow").get().n >= 1, "discovery recorded");
  assert.ok(d.prepare("SELECT COUNT(*) n FROM analog_shadow").get().n >= 1, "analog recorded");
  assert.equal(d.prepare("SELECT agreement FROM analog_shadow WHERE symbol='ASTS'").get().agreement, "agree_strong");
});

test("analog shadow records an honest ABSTAIN when no fitted corpus is available", async () => {
  const d = db();
  enqueueShadowCycle({ nowMs: 3000, quotes: [quotes[0]] }, { getDb: () => d, scorer: null }, { ANALOG_LIVE_SHADOW_ENABLED: "1" });
  await shadowQueue().drain();
  const row = d.prepare("SELECT abstain, abstain_reason FROM analog_shadow").get();
  assert.equal(row.abstain, 1);
  assert.match(row.abstain_reason, /corpus too small|no decision-time features/);
});

test("9. duplicate candidate events in the same time bucket do not create duplicate records", async () => {
  const d = db();
  enqueueShadowCycle({ nowMs: 4000, quotes }, { getDb: () => d }, { BROAD_DISCOVERY_SHADOW_ENABLED: "1" });
  enqueueShadowCycle({ nowMs: 4000, quotes }, { getDb: () => d }, { BROAD_DISCOVERY_SHADOW_ENABLED: "1" }); // same bucket → deduped
  await shadowQueue().drain();
  // one discovery task ran ⇒ one batch of rows (2 symbols), not two batches
  assert.equal(d.prepare("SELECT COUNT(*) n FROM discovery_shadow").get().n, 2);
});

test("5. only market_snapshot (+ fed extras) are used — no news/sympathy/watchlist discovery source", async () => {
  const d = db();
  enqueueShadowCycle({ nowMs: 5000, quotes }, { getDb: () => d }, { BROAD_DISCOVERY_SHADOW_ENABLED: "1" });
  await shadowQueue().drain();
  const sources = d.prepare("SELECT sources_json FROM discovery_shadow").all().flatMap((r) => JSON.parse(r.sources_json));
  assert.ok(sources.every((s) => s === "market_snapshot"), `only market_snapshot, got ${[...new Set(sources)]}`);
  assert.ok(!sources.includes("news") && !sources.includes("sector_sympathy") && !sources.includes("per_user_watchlist"));
});

test("7. a shadow DB failure is fully isolated from the live path", async () => {
  const ret = enqueueShadowCycle({ nowMs: 6000, quotes }, { getDb: () => { throw new Error("db down"); } }, { BROAD_DISCOVERY_SHADOW_ENABLED: "1" });
  assert.equal(ret, undefined, "the scanner call returns normally despite the DB failure");
  await shadowQueue().drain(); // the task error is caught inside the queue; no throw escapes
  assert.ok(true);
});
