import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  createSeedRun, getSeedRunProgress, cancelSeedRun, claimNextSeedRun,
} from "../lib/research/episode/seed-jobs.ts";

const REPO = process.cwd();
const SCHEMA = fs.readFileSync(path.join(REPO, "tests/fixtures/seed-schema.sql"), "utf8");
const FAKE = pathToFileURL(path.join(REPO, "tests/fixtures/fake-seed-provider.mjs")).href;
const ENABLED = { HISTORICAL_REPLAY_ENABLED: "1", EPISODE_CAPTURE_ENABLED: "1" };

function tempDb() {
  const dbFile = path.join(os.tmpdir(), `seedjob_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
  const db = new Database(dbFile);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return {
    db, dbFile,
    cleanup() { try { db.close(); } catch { /* */ } for (const s of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + s); } catch { /* */ } } },
  };
}
function spawnWorker(dbFile, extra = {}) {
  return spawn(process.execPath, ["--experimental-strip-types", path.join(REPO, "worker/seed-worker.ts")], {
    cwd: REPO, stdio: "ignore",
    env: { ...process.env, ...ENABLED, SEED_WORKER_DB: dbFile, SEED_WORKER_POLL_MS: "80", SEED_WORKER_RATE_MS: "0", SEED_WORKER_PROVIDER_MODULE: FAKE, FAKE_BURN_MS: "150", SEED_LEASE_MS: "60000", ...extra },
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(db, runId, statuses, timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    const p = getSeedRunProgress(db, runId);
    if (statuses.includes(p.status)) return p;
    if (Date.now() - t0 > timeoutMs) return p;
    await sleep(60);
  }
}
const pct = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))] : 0; };

// ── claim / lease unit tests (no child process) ──
test("claimNextSeedRun claims a QUEUED run and leases it; a fresh lease blocks a second claim", () => {
  const { db, cleanup } = tempDb();
  try {
    const { runId } = createSeedRun(db, { symbols: ["AAA"], from: "2024-01-02", to: "2024-01-31", universeSource: "x", survivorshipBias: true }, ENABLED);
    const first = claimNextSeedRun(db, "w1", 60_000);
    assert.equal(first, runId);
    assert.equal(getSeedRunProgress(db, runId).status, "RUNNING");
    assert.equal(claimNextSeedRun(db, "w2", 60_000), null, "a fresh lease is not stealable");
  } finally { cleanup(); }
});

test("an EXPIRED lease (crashed worker) is reclaimable", () => {
  const { db, cleanup } = tempDb();
  try {
    const { runId } = createSeedRun(db, { symbols: ["AAA"], from: "2024-01-02", to: "2024-01-31", universeSource: "x", survivorshipBias: true }, ENABLED);
    claimNextSeedRun(db, "w1", 60_000);
    db.prepare("UPDATE replay_runs SET lease_until_ms=? WHERE run_id=?").run(Date.now() - 1, runId); // expire
    assert.equal(claimNextSeedRun(db, "w2", 60_000), runId, "expired lease reclaimed by another worker");
  } finally { cleanup(); }
});

// ── THE PROOF: API loop stays responsive while a separate-process seed runs ──
test("API stays responsive (low event-loop lag + fast status reads) during an active worker seed", async () => {
  const { db, dbFile, cleanup } = tempDb();
  const reader = new Database(dbFile); reader.pragma("journal_mode = WAL"); // a second connection, like the web process
  let child;
  try {
    const { runId } = createSeedRun(db, { symbols: ["S1", "S2", "S3", "S4", "S5", "S6"], from: "2024-01-02", to: "2024-03-31", rateLimitMs: 0, universeSource: "x", survivorshipBias: true }, ENABLED);
    child = spawnWorker(dbFile);

    // Sample this (parent = "API") thread's event-loop lag and status-read latency WHILE the
    // worker burns CPU + writes. A separate process cannot block this loop, so both stay low.
    const lags = [], readMs = [];
    let last = Date.now();
    const lagTimer = setInterval(() => { const n = Date.now(); lags.push(n - last - 20); last = n; }, 20);
    const t0 = Date.now();
    while (Date.now() - t0 < 1800) {
      const r0 = Date.now();
      // 10 concurrent-style status reads (better-sqlite3 is sync; measure a burst)
      for (let i = 0; i < 10; i++) getSeedRunProgress(reader, runId);
      readMs.push(Date.now() - r0);
      await sleep(25);
    }
    clearInterval(lagTimer);

    const maxLag = Math.max(0, ...lags);
    const p95Read = pct(readMs, 0.95);
    assert.ok(maxLag < 250, `event-loop lag stayed low (max ${maxLag}ms) — worker CPU is off this thread`);
    assert.ok(p95Read < 50, `status-read p95 fast (${p95Read}ms for a 10-read burst)`);

    const final = await waitFor(db, runId, ["COMPLETED", "FAILED", "PARTIAL"], 20000);
    assert.equal(final.status, "COMPLETED", "the seed finished in the worker process");
    assert.equal(final.symbolsDone, 6);
    assert.ok(final.episodes > 0);
  } finally { child?.kill("SIGTERM"); reader.close(); cleanup(); }
});

// ── worker restart resumes from the persisted checkpoint (idempotent) ──
test("a fresh worker reclaims a stale RUNNING run and resumes from its checkpoint", async () => {
  const { db, dbFile, cleanup } = tempDb();
  let child;
  try {
    const { runId } = createSeedRun(db, { symbols: ["AAA", "BBB", "CCC"], from: "2024-01-02", to: "2024-03-31", rateLimitMs: 0, universeSource: "x", survivorshipBias: true }, ENABLED);
    // Simulate a crashed worker that already finished AAA: RUNNING, expired lease, checkpoint has AAA.
    const cp = { doneSymbols: ["AAA"], perSymbol: [{ symbol: "AAA", status: "OK", bars: 10, episodes: 5, labels: 5, chunks: 3, succeededChunks: 3, rangeComplete: true, truncated: false, firstBarMs: 1, lastBarMs: 2, note: "prior" }], errors: [] };
    db.prepare("UPDATE replay_runs SET status='RUNNING', lease_owner='dead', lease_until_ms=?, checkpoint_json=?, symbols_done=1, episodes_captured=5 WHERE run_id=?").run(Date.now() - 1, JSON.stringify(cp), runId);

    child = spawnWorker(dbFile);
    const final = await waitFor(db, runId, ["COMPLETED", "FAILED", "PARTIAL"], 20000);
    assert.equal(final.status, "COMPLETED");
    assert.equal(final.symbolsDone, 3, "resumed and finished BBB + CCC on top of the AAA checkpoint");
    const doneSymbols = JSON.parse(db.prepare("SELECT checkpoint_json c FROM replay_runs WHERE run_id=?").get(runId).c).doneSymbols;
    assert.deepEqual(doneSymbols.sort(), ["AAA", "BBB", "CCC"]);
  } finally { child?.kill("SIGTERM"); cleanup(); }
});

// ── client disconnect: the worker completes even if nobody polls ──
test("client disconnect (no poller) does not stop the worker", async () => {
  const { db, dbFile, cleanup } = tempDb();
  let child;
  try {
    const { runId } = createSeedRun(db, { symbols: ["AAA", "BBB"], from: "2024-01-02", to: "2024-03-31", rateLimitMs: 0, universeSource: "x", survivorshipBias: true }, ENABLED);
    child = spawnWorker(dbFile);
    await sleep(3000); // never poll — model a disconnected client
    assert.equal(getSeedRunProgress(db, runId).status, "COMPLETED");
  } finally { child?.kill("SIGTERM"); cleanup(); }
});

// ── cancel crosses the process boundary ──
test("cancel requested by the API process stops the worker (CANCELED)", async () => {
  const { db, dbFile, cleanup } = tempDb();
  let child;
  try {
    const { runId } = createSeedRun(db, { symbols: ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"], from: "2024-01-02", to: "2024-03-31", rateLimitMs: 0, universeSource: "x", survivorshipBias: true }, ENABLED);
    child = spawnWorker(dbFile, { FAKE_BURN_MS: "250" });
    // wait until it has started working, then cancel from this (API) process
    for (let i = 0; i < 100 && getSeedRunProgress(db, runId).symbolsDone < 1; i++) await sleep(50);
    cancelSeedRun(db, runId);
    const final = await waitFor(db, runId, ["CANCELED"], 15000);
    assert.equal(final.status, "CANCELED");
    assert.ok(final.symbolsDone < 8, "stopped before finishing all symbols");
  } finally { child?.kill("SIGTERM"); cleanup(); }
});
