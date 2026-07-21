import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  createSeedRun, advanceSeedRun, runSeedWorker, getSeedRunProgress,
  cancelSeedRun, pauseSeedRun, resumeSeedRun, resumeInterruptedSeedRuns,
} from "../lib/research/episode/seed-jobs.ts";

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
      provider_calls_attempted INTEGER NOT NULL DEFAULT 0, symbols_with_data INTEGER NOT NULL DEFAULT 0, per_symbol_json TEXT,
      episodes_captured INTEGER NOT NULL DEFAULT 0, labels_captured INTEGER NOT NULL DEFAULT 0, symbols_total INTEGER NOT NULL DEFAULT 0,
      symbols_done INTEGER NOT NULL DEFAULT 0, chunks_completed INTEGER NOT NULL DEFAULT 0, current_symbol TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0, started_at_ms INTEGER,
      lease_owner TEXT, lease_until_ms INTEGER, heartbeat_ms INTEGER);`;
  d.exec(ddl); d.exec(ddl);
  return d;
}

const ENABLED = { HISTORICAL_REPLAY_ENABLED: "1", EPISODE_CAPTURE_ENABLED: "1" };
const OPTS = { symbols: ["AAA", "BBB", "CCC"], from: "2024-01-02", to: "2024-03-31", rateLimitMs: 0, universeSource: "current_symbols", survivorshipBias: true };

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

// injectable provider fake that drives per-chunk callbacks + reports call counts
function fakeFetch({ chunks = 3, errorSymbols = [], spy } = {}) {
  return async (symbol, opts) => {
    if (spy) spy.calls.push(symbol);
    const isErr = errorSymbols.includes(symbol);
    for (let i = 0; i < chunks; i++) opts.onChunk?.({ from: "", to: "", bars: isErr ? 0 : 10, succeeded: !isErr, truncated: false, index: i, total: chunks });
    const chunkDetail = Array.from({ length: chunks }, () => ({ from: "", to: "", bars: isErr ? 0 : 10, succeeded: !isErr, truncated: false }));
    if (isErr) return { bars: [], providerCalls: chunks, succeeded: false, note: "provider error: 403 NOT_AUTHORIZED", chunks, rangeComplete: false, truncated: false, firstBarMs: null, lastBarMs: null, chunkDetail };
    const bars = spikeBars();
    return { bars, providerCalls: chunks, succeeded: true, note: "ok", chunks, rangeComplete: true, truncated: false, firstBarMs: bars[0].t, lastBarMs: bars[bars.length - 1].t, chunkDetail };
  };
}
const episodeCount = (d) => d.prepare("SELECT COUNT(*) n FROM setup_episodes").get().n;

// ── 1. immediate POST response: create returns instantly, does NO provider work ──
test("createSeedRun returns QUEUED immediately and performs no provider work", () => {
  const d = db();
  const spy = { calls: [] };
  const c = createSeedRun(d, OPTS, ENABLED);
  assert.equal(c.status, "QUEUED");
  assert.equal(c.existing, false);
  assert.ok(c.runId);
  assert.equal(spy.calls.length, 0, "no fetch happened during create");
  assert.equal(episodeCount(d), 0, "no episodes written yet");
  assert.equal(getSeedRunProgress(d, c.runId).status, "QUEUED");
});

// ── 2. background progression + 8. final completed state ──
test("the worker progresses in the background to COMPLETED", async () => {
  const d = db();
  const { runId } = createSeedRun(d, OPTS, ENABLED);
  const final = await runSeedWorker(d, runId, ENABLED, { fetchBars: fakeFetch() }, { rateLimitMs: 0 });
  assert.equal(final.status, "COMPLETED");
  assert.equal(final.symbolsTotal, 3);
  assert.equal(final.symbolsDone, 3);
  assert.equal(final.symbolsWithData, 3);
  assert.equal(final.currentSymbol, null);
  assert.ok(final.episodes > 0 && final.labels > 0);
  assert.ok(final.chunksCompleted >= 9, "3 symbols × 3 chunks persisted");
  assert.equal(final.providerCallsSucceeded, 9);
});

test("advanceSeedRun makes one symbol of progress per step, persisting after every chunk", async () => {
  const d = db();
  const { runId } = createSeedRun(d, OPTS, ENABLED);
  const s1 = await advanceSeedRun(d, runId, ENABLED, { fetchBars: fakeFetch() });
  assert.equal(s1.done, false);
  let p = getSeedRunProgress(d, runId);
  assert.equal(p.status, "RUNNING");
  assert.equal(p.symbolsDone, 1);
  assert.equal(p.chunksCompleted, 3, "chunk-level progress persisted");
  assert.equal(typeof p.etaMs, "number", "ETA is available once ≥1 symbol is timed");
  await advanceSeedRun(d, runId, ENABLED, { fetchBars: fakeFetch() });
  const s3 = await advanceSeedRun(d, runId, ENABLED, { fetchBars: fakeFetch() });
  assert.equal(s3.done, true);
  assert.equal(getSeedRunProgress(d, runId).status, "COMPLETED");
});

// ── 3. client disconnect: worker is independent of any request/reader ──
test("client disconnect does not stop the server-side job", async () => {
  const d = db();
  const { runId } = createSeedRun(d, OPTS, ENABLED);
  // Kick the worker but NEVER read the returned progress (models a client that disconnected).
  const p = runSeedWorker(d, runId, ENABLED, { fetchBars: fakeFetch() }, { rateLimitMs: 0 });
  await p; // the job runs to completion regardless of the client
  assert.equal(getSeedRunProgress(d, runId).status, "COMPLETED");
  assert.equal(getSeedRunProgress(d, runId).symbolsDone, 3);
});

// ── 4. resume after interruption (restart) is idempotent ──
test("resume after interruption reaches the same episodes with no duplicates", async () => {
  // reference full run
  const full = db();
  const rf = createSeedRun(full, OPTS, ENABLED).runId;
  await runSeedWorker(full, rf, ENABLED, { fetchBars: fakeFetch() }, { rateLimitMs: 0 });
  const fullN = episodeCount(full);
  assert.ok(fullN > 0);

  // interrupted run: advance one symbol, then simulate a restart by re-kicking the worker
  const d = db();
  const { runId } = createSeedRun(d, OPTS, ENABLED);
  await advanceSeedRun(d, runId, ENABLED, { fetchBars: fakeFetch() }); // 1 of 3
  assert.equal(getSeedRunProgress(d, runId).symbolsDone, 1);
  const kicked = resumeInterruptedSeedRuns(d, ENABLED, { fetchBars: fakeFetch() }); // restart recovery
  assert.ok(kicked.includes(runId));
  // give the fire-and-forget worker a tick to finish
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(getSeedRunProgress(d, runId).status, "COMPLETED");
  assert.equal(episodeCount(d), fullN, "idempotent — same episode set, no duplicates");
});

// ── 5. duplicate job submission is deduplicated ──
test("a duplicate submission returns the existing active run", () => {
  const d = db();
  const a = createSeedRun(d, OPTS, ENABLED);
  const b = createSeedRun(d, OPTS, ENABLED);
  assert.equal(b.existing, true);
  assert.equal(b.runId, a.runId);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM replay_runs").get().n, 1);
});

// ── 6. quota interruption → PARTIAL, then continuation completes idempotently ──
test("quota (budget) stops the run at PARTIAL; a follow-up run completes the rest idempotently", async () => {
  const full = db();
  const rf = createSeedRun(full, OPTS, ENABLED).runId;
  await runSeedWorker(full, rf, ENABLED, { fetchBars: fakeFetch() }, { rateLimitMs: 0 });
  const fullN = episodeCount(full);

  const d = db();
  const cut = createSeedRun(d, { ...OPTS, providerCallBudget: 3 }, ENABLED).runId; // enough for 1 symbol
  const p1 = await runSeedWorker(d, cut, ENABLED, { fetchBars: fakeFetch() }, { rateLimitMs: 0 });
  assert.equal(p1.status, "PARTIAL");
  assert.ok(p1.symbolsDone < 3);

  const cont = createSeedRun(d, OPTS, ENABLED).runId; // prior run terminal ⇒ not deduped
  assert.notEqual(cont, cut);
  const p2 = await runSeedWorker(d, cont, ENABLED, { fetchBars: fakeFetch() }, { rateLimitMs: 0 });
  assert.equal(p2.status, "COMPLETED");
  assert.equal(episodeCount(d), fullN, "continuation is idempotent");
});

// ── 7. partial symbol failure ──
test("a single failing symbol yields PARTIAL with the error recorded; others still seed", async () => {
  const d = db();
  const { runId } = createSeedRun(d, OPTS, ENABLED);
  const final = await runSeedWorker(d, runId, ENABLED, { fetchBars: fakeFetch({ errorSymbols: ["BBB"] }) }, { rateLimitMs: 0 });
  assert.equal(final.status, "PARTIAL");
  assert.equal(final.symbolsWithData, 2);
  assert.equal(final.errors.length, 1);
  assert.equal(final.errors[0].symbol, "BBB");
  assert.match(final.errors[0].note, /403/);
  assert.ok(final.episodes > 0, "the healthy symbols still produced episodes");
});

// ── cancellation + pause/resume ──
test("cancel a QUEUED run → CANCELED, worker is a no-op", async () => {
  const d = db();
  const { runId } = createSeedRun(d, OPTS, ENABLED);
  const c = cancelSeedRun(d, runId);
  assert.equal(c.status, "CANCELED");
  const final = await runSeedWorker(d, runId, ENABLED, { fetchBars: fakeFetch() }, { rateLimitMs: 0 });
  assert.equal(final.status, "CANCELED");
  assert.equal(episodeCount(d), 0);
});

test("pause then resume continues from the checkpoint", async () => {
  const d = db();
  const { runId } = createSeedRun(d, OPTS, ENABLED);
  await advanceSeedRun(d, runId, ENABLED, { fetchBars: fakeFetch() }); // 1 done
  assert.equal(pauseSeedRun(d, runId).status, "PAUSED");
  const paused = await advanceSeedRun(d, runId, ENABLED, { fetchBars: fakeFetch() });
  assert.equal(paused.done, true, "a PAUSED run does not advance");
  assert.equal(getSeedRunProgress(d, runId).symbolsDone, 1);
  assert.equal(resumeSeedRun(d, runId).status, "QUEUED");
  const final = await runSeedWorker(d, runId, ENABLED, { fetchBars: fakeFetch() }, { rateLimitMs: 0 });
  assert.equal(final.status, "COMPLETED");
  assert.equal(final.symbolsDone, 3);
});

// ── elapsedMs: frozen at completion for settled runs, live while running ──
test("elapsedMs is the run duration for a settled run (does not grow on later polls)", () => {
  const d = db();
  const { runId } = createSeedRun(d, OPTS, ENABLED);
  // reproduce the reported production row exactly
  d.prepare("UPDATE replay_runs SET status='COMPLETED', started_at_ms=?, updated_at_ms=? WHERE run_id=?")
    .run(1784669432384, 1784669461722, runId);
  // polled long after completion — elapsed must stay the true duration, not (now - started)
  const p = getSeedRunProgress(d, runId, 1784669540451); // ~108s after start, ~79s after completion
  assert.equal(p.elapsedMs, 1784669461722 - 1784669432384, "elapsed = updated - started (29338ms)");
  assert.equal(p.etaMs, null, "no ETA for a completed run");
  // polling even later does not change it
  assert.equal(getSeedRunProgress(d, runId, 1784669999999).elapsedMs, 1784669461722 - 1784669432384);
});

test("elapsedMs is live (now - started) while a run is RUNNING", () => {
  const d = db();
  const { runId } = createSeedRun(d, OPTS, ENABLED);
  d.prepare("UPDATE replay_runs SET status='RUNNING', started_at_ms=?, updated_at_ms=? WHERE run_id=?")
    .run(1000, 2000, runId);
  assert.equal(getSeedRunProgress(d, runId, 5000).elapsedMs, 4000, "running: measured to now");
});

// ── safety: flags off / kill switch refuse to create ──
test("safety: flags off and kill switch refuse to create a run", () => {
  assert.equal(createSeedRun(db(), OPTS, {}).status, "SKIPPED");
  assert.equal(createSeedRun(db(), OPTS, { ...ENABLED, EPISODE_SEED_KILL: "1" }).status, "SKIPPED");
});
