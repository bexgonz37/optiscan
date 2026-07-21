import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { fetchHistoricalStockBars, replayDateWindows, REPLAY_PER_CALL_LIMIT } from "../lib/research/replay-provider.ts";
import { runReplaySeed } from "../lib/research/episode/seed.ts";

const KEYED = { POLYGON_API_KEY: "test-key" }; // makes stockReplayAvailable true; fetchCandles is injected

// A window's bars carry timestamps unique to their call index so cross-chunk merge is observable.
function fakeCandles(perCall, { failCall = -1, capCall = -1, dupPrevCall = false } = {}) {
  let call = -1;
  return async (_sym, opts) => {
    call += 1;
    assert.ok(opts.limit === REPLAY_PER_CALL_LIMIT, "replay requests the 50k per-call limit");
    if (call === failCall) return { available: false, bars: [], note: "polygon 403: NOT_AUTHORIZED" };
    const baseT = (call + 1) * 1_000_000_000;
    const bars = [];
    for (let i = 0; i < perCall; i++) bars.push({ t: baseT + i * 60_000, o: 100, h: 100, l: 100, c: 100, v: 1000 });
    if (dupPrevCall && call > 0) bars.push({ t: call * 1_000_000_000, o: 1, h: 1, l: 1, c: 1, v: 1 }); // dup of prior call's baseT
    return { available: true, bars, source: "polygon", resolution: "1", resultCap: call === capCall };
  };
}

// ── replayDateWindows (deterministic chunk boundaries) ───────────────────────
test("replayDateWindows splits a range into contiguous, non-overlapping windows", () => {
  const w = replayDateWindows("2024-01-02", "2024-03-15", 30);
  assert.ok(w.length >= 3, "≥3 windows for a ~73-day range at 30-day chunks");
  assert.equal(w[0].from, "2024-01-02");
  assert.equal(w[w.length - 1].to, "2024-03-15");
  for (let i = 1; i < w.length; i++) assert.ok(w[i].from > w[i - 1].to, "windows do not overlap and advance");
});
test("replayDateWindows returns a single window for a one-day range", () => {
  const w = replayDateWindows("2024-01-02", "2024-01-02", 30);
  assert.equal(w.length, 1);
});

// ── the 5,000-cap bug: full coverage via chunking ────────────────────────────
test("MORE THAN 5,000 bars: chunking covers the whole range, no truncation", async () => {
  const r = await fetchHistoricalStockBars("AAPL", { from: "2024-01-02", to: "2024-01-04", chunkDays: 1 }, KEYED, { fetchCandles: fakeCandles(2500) });
  assert.equal(r.chunks, 3, "3 one-day windows");
  assert.equal(r.providerCalls, 3);
  assert.equal(r.bars.length, 7500, "2500 × 3 chunks — far above the old 5000 cap");
  assert.equal(r.rangeComplete, true);
  assert.equal(r.truncated, false);
  assert.ok(r.succeeded);
});

test("bars are deduplicated by timestamp across chunk boundaries and sorted ascending", async () => {
  const r = await fetchHistoricalStockBars("AAPL", { from: "2024-01-02", to: "2024-01-04", chunkDays: 1 }, KEYED, { fetchCandles: fakeCandles(1000, { dupPrevCall: true }) });
  const ts = r.bars.map((b) => b.t);
  assert.equal(new Set(ts).size, ts.length, "no duplicate timestamps survive the merge");
  for (let i = 1; i < ts.length; i++) assert.ok(ts[i] > ts[i - 1], "strictly ascending");
});

test("MISSING MIDDLE CHUNK: a failed window makes the range visibly incomplete", async () => {
  const r = await fetchHistoricalStockBars("AAPL", { from: "2024-01-02", to: "2024-01-04", chunkDays: 1 }, KEYED, { fetchCandles: fakeCandles(1000, { failCall: 1 }) });
  assert.equal(r.chunks, 3);
  assert.equal(r.succeeded, false, "a failed chunk means the fetch did not fully succeed");
  assert.equal(r.rangeComplete, false);
  assert.ok(r.bars.length > 0, "the chunks that did return are still kept");
  const mid = r.chunkDetail[1];
  assert.equal(mid.succeeded, false);
  assert.match(mid.note, /403/);
});

test("RESULT-CAP hit on any chunk is reported as truncated / not complete", async () => {
  const r = await fetchHistoricalStockBars("AAPL", { from: "2024-01-02", to: "2024-01-03", chunkDays: 1 }, KEYED, { fetchCandles: fakeCandles(10, { capCall: 0 }) });
  assert.equal(r.truncated, true);
  assert.equal(r.rangeComplete, false);
  assert.match(r.note, /truncated/i);
});

test("no provider key → no request issued (unchanged safety)", async () => {
  const r = await fetchHistoricalStockBars("AAPL", { from: "2024-01-02", to: "2024-01-04" }, {}, { fetchCandles: fakeCandles(10) });
  assert.equal(r.providerCalls, 0);
  assert.equal(r.succeeded, false);
  assert.equal(r.bars.length, 0);
});

// ── driver-level: incomplete coverage surfaces as PARTIAL, and reseed is idempotent ──
function db() {
  const d = new Database(":memory:");
  const ddl = `
    CREATE TABLE IF NOT EXISTS setup_episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, episode_key TEXT NOT NULL UNIQUE, source TEXT NOT NULL, symbol TEXT NOT NULL,
      t0_ms INTEGER NOT NULL, trading_day TEXT NOT NULL, session TEXT NOT NULL, tod_bucket TEXT, asset_class TEXT NOT NULL DEFAULT 'stock',
      direction TEXT, regime_label TEXT, regime_model_version INTEGER, liquidity_tier TEXT, validity_tier TEXT,
      price_structure_json TEXT, momentum_json TEXT, volume_json TEXT, volatility_json TEXT, regime_json TEXT, sector_json TEXT,
      breadth_json TEXT, options_context_json TEXT, catalyst_json TEXT, liquidity_json TEXT, data_quality_json TEXT, missing_json TEXT,
      gate_results_json TEXT, feature_schema_version INTEGER NOT NULL, max_feature_as_of_ms INTEGER NOT NULL, provenance_json TEXT, created_at_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS episode_labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT, episode_key TEXT NOT NULL, horizon TEXT NOT NULL, target_kind TEXT NOT NULL, outcome_kind TEXT NOT NULL,
      return_pct REAL, mfe_pct REAL, mae_pct REAL, target_before_stop TEXT, time_to_target_ms INTEGER, time_to_invalidation_ms INTEGER,
      realized_vol REAL, gap_pct REAL, gap_filled INTEGER, model_assumptions_json TEXT, label_as_of_ms INTEGER NOT NULL, computed_at_ms INTEGER NOT NULL,
      UNIQUE(episode_key, horizon, target_kind));
    CREATE TABLE IF NOT EXISTS replay_runs (
      run_id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, asset_class TEXT NOT NULL, symbols_json TEXT NOT NULL,
      date_from TEXT NOT NULL, date_to TEXT NOT NULL, timespan TEXT NOT NULL, strategy_version INTEGER NOT NULL, config_json TEXT,
      status TEXT NOT NULL, checkpoint_json TEXT, provider_calls INTEGER NOT NULL DEFAULT 0, provider_call_budget INTEGER NOT NULL DEFAULT 0,
      provider_limitations TEXT, error TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      provider_calls_attempted INTEGER NOT NULL DEFAULT 0, symbols_with_data INTEGER NOT NULL DEFAULT 0, per_symbol_json TEXT);`;
  d.exec(ddl); d.exec(ddl);
  return d;
}
const ENABLED = { HISTORICAL_REPLAY_ENABLED: "1", EPISODE_CAPTURE_ENABLED: "1" };
// ~89-day range ⇒ 3 date-window chunks at 30-day chunking (matches the fakes' 3 calls/symbol).
const BASE = { symbols: ["AAA", "BBB", "CCC"], from: "2024-01-02", to: "2024-03-31", dryRun: false, rateLimitMs: 0, universeSource: "current_symbols", survivorshipBias: true };

function spikeBars() {
  const base = Date.UTC(2024, 0, 2, 14, 30, 0), out = [];
  for (let i = 0; i < 180; i++) {
    let c = 100, v = 1000;
    if (i >= 95 && i <= 115) { c = 100 + (i - 94) * 0.25; v = 6000; }
    else if (i > 115) { c = 100 + (115 - 94) * 0.25; }
    out.push({ t: base + i * 60_000, o: c, h: c, l: c, c, v });
  }
  return out;
}
const complete = (bars) => async () => ({ bars, providerCalls: 3, succeeded: true, note: "ok", chunks: 3, rangeComplete: true, truncated: false, firstBarMs: bars[0]?.t ?? null, lastBarMs: bars[bars.length - 1]?.t ?? null });
const incomplete = (bars) => async () => ({ bars, providerCalls: 3, succeeded: false, note: "middle chunk failed", chunks: 3, rangeComplete: false, truncated: false, firstBarMs: bars[0]?.t ?? null, lastBarMs: bars[bars.length - 1]?.t ?? null });

test("driver: an INCOMPLETE symbol range makes the whole run PARTIAL (not COMPLETED)", async () => {
  const d = db();
  const res = await runReplaySeed({ ...BASE, symbols: ["AAA"] }, ENABLED, { db: d, fetchBars: incomplete(spikeBars()) });
  assert.equal(res.status, "PARTIAL");
  assert.equal(res.perSymbol[0].status, "INCOMPLETE");
  assert.equal(res.perSymbol[0].rangeComplete, false);
  assert.ok(res.episodes > 0, "the bars that did arrive are still seeded");
  assert.match(res.error, /incomplete|partial/i);
});

test("driver: QUOTA INTERRUPTION (budget) is PARTIAL, and a re-run completes idempotently", async () => {
  // full reference run
  const full = db();
  const fr = await runReplaySeed({ ...BASE }, ENABLED, { db: full, fetchBars: complete(spikeBars()) });
  assert.equal(fr.status, "COMPLETED");
  const fullN = full.prepare("SELECT COUNT(*) n FROM setup_episodes").get().n;
  assert.ok(fullN > 0);

  // interrupted run: budget stops after the first symbol
  const d = db();
  const cut = await runReplaySeed({ ...BASE, providerCallBudget: 1 }, ENABLED, { db: d, fetchBars: complete(spikeBars()) });
  assert.equal(cut.status, "PARTIAL", "requested symbols not all processed → PARTIAL");
  assert.ok(cut.symbolsProcessed < BASE.symbols.length);

  // resume: re-run the full request; already-seeded episodes are ignored, the rest are added
  const resume = await runReplaySeed({ ...BASE }, ENABLED, { db: d, fetchBars: complete(spikeBars()) });
  assert.equal(resume.status, "COMPLETED");
  const resumedN = d.prepare("SELECT COUNT(*) n FROM setup_episodes").get().n;
  assert.equal(resumedN, fullN, "resume reaches the same episode set — idempotent, no duplicates");

  // reseeding again changes nothing
  await runReplaySeed({ ...BASE }, ENABLED, { db: d, fetchBars: complete(spikeBars()) });
  assert.equal(d.prepare("SELECT COUNT(*) n FROM setup_episodes").get().n, resumedN, "idempotent reseed");
});
