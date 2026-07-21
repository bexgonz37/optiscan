import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import {
  createSeedRun, advanceSeedRun, getSeedRunProgress, cancelSeedRun,
  claimNextSeedRun, reconcileStaleSeedRuns,
} from "../lib/research/episode/seed-jobs.ts";

const SCHEMA = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/seed-schema.sql"), "utf8");
const ENABLED = { HISTORICAL_REPLAY_ENABLED: "1", EPISODE_CAPTURE_ENABLED: "1" };
const OPTS = { symbols: ["AAA", "BBB", "CCC"], from: "2024-01-02", to: "2024-03-31", rateLimitMs: 0, universeSource: "x", survivorshipBias: true };

function db() { const d = new Database(":memory:"); d.exec(SCHEMA); d.exec(SCHEMA); return d; }
function spikeBars() {
  const base = Date.UTC(2024, 0, 2, 14, 30, 0), out = [];
  for (let i = 0; i < 180; i++) { let c = 100, v = 1000; if (i >= 95 && i <= 115) { c = 100 + (i - 94) * 0.25; v = 6000; } out.push({ t: base + i * 60_000, o: c, h: c, l: c, c, v }); }
  return out;
}
const okFetch = ({ spy } = {}) => async (symbol, opts) => {
  if (spy) spy.calls.push(symbol);
  for (let i = 0; i < 3; i++) { if (opts.checkAbort?.()) return { bars: [], providerCalls: i, succeeded: false, note: "aborted", chunks: 3, rangeComplete: false, truncated: false, firstBarMs: null, lastBarMs: null, chunkDetail: [], aborted: true }; opts.onChunk?.({ index: i, total: 3, from: "", to: "", bars: 10, succeeded: true, truncated: false }); }
  const bars = spikeBars();
  return { bars, providerCalls: 3, succeeded: true, note: "ok", chunks: 3, rangeComplete: true, truncated: false, firstBarMs: bars[0].t, lastBarMs: bars[bars.length - 1].t, chunkDetail: [{ succeeded: true }, { succeeded: true }, { succeeded: true }], aborted: false };
};
// aborts after `cancelAfterChunk` by persisting cancel mid-fetch; checkAbort then stops the rest
const cancelMidFetch = (d, runId, cancelAfterChunk = 0) => async (symbol, opts) => {
  let done = 0, aborted = false;
  for (let i = 0; i < 3; i++) {
    if (opts.checkAbort?.()) { aborted = true; break; }
    opts.onChunk?.({ index: i, total: 3, from: "", to: "", bars: 10, succeeded: true, truncated: false });
    done++;
    if (i === cancelAfterChunk) d.prepare("UPDATE replay_runs SET cancel_requested=1 WHERE run_id=?").run(runId);
  }
  return { bars: aborted ? [] : spikeBars(), providerCalls: done, succeeded: !aborted, note: aborted ? "aborted" : "ok", chunks: 3, rangeComplete: !aborted, truncated: false, firstBarMs: null, lastBarMs: null, chunkDetail: Array.from({ length: done }, () => ({ succeeded: true })), aborted };
};

test("1. cancel BEFORE any worker claim → CANCELED, and it is never claimed", () => {
  const d = db();
  const { runId } = createSeedRun(d, OPTS, ENABLED);
  const r = cancelSeedRun(d, runId);
  assert.equal(r.status, "CANCELED");
  assert.equal(getSeedRunProgress(d, runId).status, "CANCELED");
  assert.equal(claimNextSeedRun(d, "w1", 60_000), null, "a canceled run is never claimed");
});

test("2. cancel DURING the provider call aborts at the chunk boundary → CANCELED, no seeding", async () => {
  const d = db();
  const { runId } = createSeedRun(d, OPTS, ENABLED);
  const res = await advanceSeedRun(d, runId, ENABLED, { fetchBars: cancelMidFetch(d, runId, 0) });
  assert.equal(res.status, "CANCELED");
  assert.equal(getSeedRunProgress(d, runId).status, "CANCELED");
  assert.equal(d.prepare("SELECT COUNT(*) n FROM setup_episodes").get().n, 0, "aborted symbol is not seeded");
});

test("3. cancel during the inter-symbol (rate-limit) gap stops the next symbol", async () => {
  const d = db();
  const { runId } = createSeedRun(d, OPTS, ENABLED);
  await advanceSeedRun(d, runId, ENABLED, { fetchBars: okFetch() });     // AAA done
  assert.equal(getSeedRunProgress(d, runId).symbolsDone, 1);
  cancelSeedRun(d, runId);                                                // canceled during the "sleep"
  const res = await advanceSeedRun(d, runId, ENABLED, { fetchBars: okFetch() });
  assert.equal(res.status, "CANCELED");
  assert.equal(getSeedRunProgress(d, runId).symbolsDone, 1, "BBB was not processed");
});

test("4. cancel of an EXPIRED-lease run finalizes immediately", () => {
  const d = db();
  const { runId } = createSeedRun(d, OPTS, ENABLED);
  claimNextSeedRun(d, "w1", 60_000);                                      // RUNNING, live lease
  d.prepare("UPDATE replay_runs SET lease_until_ms=? WHERE run_id=?").run(Date.now() - 1, runId); // expire
  const r = cancelSeedRun(d, runId);
  assert.equal(r.status, "CANCELED");
  const row = d.prepare("SELECT status, lease_owner, lease_until_ms FROM replay_runs WHERE run_id=?").get(runId);
  assert.equal(row.status, "CANCELED");
  assert.equal(row.lease_owner, null, "lease ownership cleared on cancel");
  assert.equal(row.lease_until_ms, null);
});

test("5. cancel / reconcile of a MALFORMED legacy RUNNING row (the stuck-run shape)", () => {
  const d = db();
  // mirrors episode_seed_1784662810251: RUNNING, cancel_requested, symbols_total=0, started_at=null, empty plan
  d.prepare(`INSERT INTO replay_runs (run_id, experiment_id, asset_class, symbols_json, date_from, date_to, timespan, strategy_version, status, provider_calls_attempted, symbols_total, cancel_requested, created_at_ms, updated_at_ms)
             VALUES ('legacy1','legacy1','stock','[]','2024-01-01','2024-01-31','minute',1,'RUNNING',7,0,1,1,1)`).run();
  const r = cancelSeedRun(d, "legacy1");
  assert.equal(r.status, "CANCELED", "a malformed canceled run finalizes deterministically");
  // an unresumable RUNNING row that is NOT canceled → FAILED via reconciliation
  d.prepare(`INSERT INTO replay_runs (run_id, experiment_id, asset_class, symbols_json, date_from, date_to, timespan, strategy_version, status, symbols_total, cancel_requested, created_at_ms, updated_at_ms)
             VALUES ('legacy2','legacy2','stock','[]','2024-01-01','2024-01-31','minute',1,'RUNNING',0,0,2,2)`).run();
  const recon = reconcileStaleSeedRuns(d);
  const l2 = recon.find((x) => x.runId === "legacy2");
  assert.ok(l2 && l2.to === "FAILED", "unresumable, un-canceled legacy row → FAILED");
  assert.match(l2.reason, /symbol plan/);
});

test("6. repeated cancel is idempotent", () => {
  const d = db();
  const { runId } = createSeedRun(d, OPTS, ENABLED);
  assert.equal(cancelSeedRun(d, runId).status, "CANCELED");
  const again = cancelSeedRun(d, runId);
  assert.equal(again.status, "CANCELED");
  assert.equal(again.changed, false);
  assert.equal(getSeedRunProgress(d, runId).status, "CANCELED");
});

test("7. worker restart after cancel: reconcile finalizes, claim never revives it", () => {
  const d = db();
  const { runId } = createSeedRun(d, OPTS, ENABLED);
  // a worker set the flag then died: RUNNING, cancel_requested, expired lease
  claimNextSeedRun(d, "dead", 60_000);
  d.prepare("UPDATE replay_runs SET cancel_requested=1, lease_until_ms=? WHERE run_id=?").run(Date.now() - 1, runId);
  const recon = reconcileStaleSeedRuns(d);
  assert.ok(recon.some((x) => x.runId === runId && x.to === "CANCELED"));
  assert.equal(claimNextSeedRun(d, "fresh", 60_000), null, "a fresh worker never reclaims a canceled run");
  assert.equal(getSeedRunProgress(d, runId).status, "CANCELED");
  reconcileStaleSeedRuns(d); // still terminal, idempotent
  assert.equal(getSeedRunProgress(d, runId).status, "CANCELED");
});

test("8. NO provider calls happen once cancel_requested is persisted", async () => {
  const d = db();
  const { runId } = createSeedRun(d, OPTS, ENABLED);
  d.prepare("UPDATE replay_runs SET cancel_requested=1 WHERE run_id=?").run(runId);
  const spy = { calls: [] };
  const res = await advanceSeedRun(d, runId, ENABLED, { fetchBars: okFetch({ spy }) });
  assert.equal(res.status, "CANCELED");
  assert.equal(spy.calls.length, 0, "the provider was never called");
});

test("reconcile leaves an actively-leased run untouched", () => {
  const d = db();
  const { runId } = createSeedRun(d, OPTS, ENABLED);
  claimNextSeedRun(d, "live", 60_000); // fresh lease
  const recon = reconcileStaleSeedRuns(d);
  assert.equal(recon.length, 0);
  assert.equal(getSeedRunProgress(d, runId).status, "RUNNING");
});
