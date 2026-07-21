/**
 * worker/seed-worker.ts — standalone background worker PROCESS for historical-replay seeding
 * (Analog Engine, Phase E.4). Run via: `node --experimental-strip-types worker/seed-worker.ts`.
 *
 * WHY A SEPARATE PROCESS: better-sqlite3 is synchronous and seeding a symbol (candidate detection
 * + hundreds of inserts over tens of thousands of bars) is CPU-bound. Running it inside the Next
 * web process froze the single event loop, so /api/health and status GET timed out while a seed
 * ran. This worker owns ALL replay work in its own process/event loop; the web process only reads
 * persisted state. They share the same SQLite file (same container) and WAL lets the web process
 * read while this worker writes — so the API stays responsive.
 *
 * It claims jobs via a lease (createSeedRun leaves them QUEUED); a crashed/restarted worker's
 * expired lease is reclaimed on the next poll, so runs resume from their persisted checkpoint.
 * All flag / kill-switch / provenance / quota rules live in the shared job engine.
 */
import path from "node:path";
import Database from "better-sqlite3";
import { fetchHistoricalStockBars } from "../lib/research/replay-provider.ts";
import { claimNextSeedRun, runSeedWorker, DEFAULT_LEASE_MS, type FetchBarsFn } from "../lib/research/episode/seed-jobs.ts";
import { slog } from "../lib/research/episode/seed-log.ts";

const POLL_MS = Number(process.env.SEED_WORKER_POLL_MS ?? 1000);
const RATE_MS = process.env.SEED_WORKER_RATE_MS != null ? Number(process.env.SEED_WORKER_RATE_MS) : undefined;
const LEASE_MS = Number(process.env.SEED_WORKER_LEASE_MS ?? DEFAULT_LEASE_MS);
const WORKER_ID = `w_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

function dbFile(): string {
  if (process.env.SEED_WORKER_DB) return process.env.SEED_WORKER_DB;
  const dir = process.env.ALERT_DB_DIR || path.join(process.cwd(), "data");
  return path.join(dir, "optiscan.db");
}

function openDb(): Database.Database {
  const db = new Database(dbFile());
  db.pragma("journal_mode = WAL");     // read concurrently with the web process
  db.pragma("busy_timeout = 5000");    // wait, do not throw, on a colliding write
  db.pragma("synchronous = NORMAL");
  return db;
}

/** Real provider fetch: inject fetchCandles so no "@/" alias is needed in this bare process.
 *  Tests override the whole fetch via SEED_WORKER_PROVIDER_MODULE (a module exporting `fetchBars`). */
async function resolveFetchBars(): Promise<FetchBarsFn> {
  if (process.env.SEED_WORKER_PROVIDER_MODULE) {
    const mod: any = await import(process.env.SEED_WORKER_PROVIDER_MODULE);
    return (mod.fetchBars ?? mod.default) as FetchBarsFn;
  }
  const provider: any = await import("../lib/polygon-provider.js");
  return (symbol, opts, env) => fetchHistoricalStockBars(symbol, opts, env, { fetchCandles: provider.fetchCandles });
}

let shuttingDown = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const db = openDb();
  const journalMode = String((db.pragma("journal_mode", { simple: true })) ?? "");
  const busyTimeout = Number(db.pragma("busy_timeout", { simple: true }) ?? 0);
  const fetchBars = await resolveFetchBars();
  slog("worker_start", {
    workerId: WORKER_ID, role: process.env.OPTISCAN_PROCESS_ROLE ?? "seed-worker",
    pid: process.pid, ppid: process.ppid, node: process.versions.node,
    pollMs: POLL_MS, leaseMs: LEASE_MS, dbFile: dbFile(), journalMode, busyTimeout,
  });

  const stop = () => { shuttingDown = true; };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("message", (m) => { if (m === "shutdown") stop(); });

  while (!shuttingDown) {
    let runId: string | null = null;
    try {
      runId = claimNextSeedRun(db, WORKER_ID, LEASE_MS);
    } catch (err: any) {
      // e.g. schema not migrated yet — back off and retry (the web process owns migration).
      slog("error", { where: "claim", err: String(err?.message ?? err).slice(0, 120) });
    }
    if (!runId) { slog("worker_poll", { workerId: WORKER_ID, idle: true }); await sleep(POLL_MS); continue; }
    await runSeedWorker(db, runId, process.env, { fetchBars }, { workerId: WORKER_ID, leaseMs: LEASE_MS, rateLimitMs: RATE_MS });
  }
  slog("worker_exit", { workerId: WORKER_ID });
  db.close();
  process.exit(0);
}

main().catch((err) => { slog("error", { where: "main", err: String(err?.message ?? err).slice(0, 200) }); process.exit(1); });
