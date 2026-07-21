/**
 * lib/research/episode/seed-worker-manager.ts — spawns & supervises the out-of-process seed
 * worker from the WEB process (Analog Engine, Phase E.5 — crash-safe rewrite).
 *
 * HISTORY: E.4 spawned the worker unconditionally with no 'error' handler. Under Next's
 * `output: "standalone"` the worker/*.ts source is pruned from the image, so spawn failed with
 * ENOENT; the unhandled 'error' event crashed the WEB process, and re-spawn on the next request
 * turned it into a web-level crash loop — every route (incl. /api/health) returned 0 bytes.
 *
 * This rewrite makes worker spawning:
 *   • OPT-IN — off unless OPTISCAN_ENABLE_SEED_WORKER=1 (so the default deploy is always healthy);
 *   • NON-FATAL — every failure path is caught; a spawn error NEVER propagates to the web loop;
 *   • SELF-DISABLING — a crash-loop ceiling stops re-spawning after repeated failures;
 *   • NON-RECURSIVE — the child runs with OPTISCAN_PROCESS_ROLE=seed-worker and never spawns again;
 *   • PRE-FLIGHT CHECKED — the worker file must exist and Node must support --experimental-strip-types;
 *   • DEFERRED — spawn is scheduled off the request path (setImmediate), never at module import.
 */
import path from "node:path";
import fs from "node:fs";
import { researchFlags } from "../flags.ts";
import { slog } from "./seed-log.ts";

const MAX_FAILURES = 5;              // stop re-spawning after this many failures
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 60_000;

type WorkerState = { child: any | null; failures: number; disabled: boolean; disabledReason: string | null };
type G = typeof globalThis & { __optiscanSeedWorker?: WorkerState };

/** Node supports `--experimental-strip-types` from v22.6.0. */
export function nodeSupportsStripTypes(version: string = process.versions.node): boolean {
  const [maj, min] = version.split(".").map((n) => parseInt(n, 10));
  if (!Number.isFinite(maj)) return false;
  return maj > 22 || (maj === 22 && (min ?? 0) >= 6);
}

export interface SpawnDecision { spawn: boolean; reason: string }

/** PURE decision: should this process spawn a seed worker? Testable without side effects. */
export function seedWorkerSpawnDecision(
  env: NodeJS.ProcessEnv,
  probe: { workerFileExists: boolean; nodeVersion?: string } ,
): SpawnDecision {
  if (env.OPTISCAN_PROCESS_ROLE === "seed-worker") return { spawn: false, reason: "this process IS the seed worker (no recursion)" };
  if (env.OPTISCAN_ENABLE_SEED_WORKER !== "1") return { spawn: false, reason: "worker disabled (set OPTISCAN_ENABLE_SEED_WORKER=1 to enable)" };
  const f = researchFlags(env);
  if (!f.historicalReplay || !f.episodeCapture) return { spawn: false, reason: "replay flags off — nothing to seed" };
  if (!probe.workerFileExists) return { spawn: false, reason: "worker entry file not found in this deployment (standalone build pruned it)" };
  if (!nodeSupportsStripTypes(probe.nodeVersion)) return { spawn: false, reason: `Node ${probe.nodeVersion} lacks --experimental-strip-types (need >=22.6)` };
  return { spawn: true, reason: "ok" };
}

function workerFilePath(): string { return path.join(process.cwd(), "worker", "seed-worker.ts"); }

/**
 * Ensure the background seed worker process is running. Idempotent, opt-in, and crash-safe: it
 * can be called on every request and will NEVER throw into the request path or block the loop.
 */
export function ensureSeedWorker(env: NodeJS.ProcessEnv = process.env): { spawned: boolean; reason: string } {
  const g = globalThis as G;
  try {
    const state: WorkerState = g.__optiscanSeedWorker ?? (g.__optiscanSeedWorker = { child: null, failures: 0, disabled: false, disabledReason: null });
    if (state.disabled) return { spawned: false, reason: state.disabledReason ?? "disabled" };
    if (state.child && state.child.exitCode === null) return { spawned: true, reason: "already running" };

    const workerPath = workerFilePath();
    const decision = seedWorkerSpawnDecision(env, { workerFileExists: safeExists(workerPath), nodeVersion: process.versions.node });
    if (!decision.spawn) return { spawned: false, reason: decision.reason };

    // Defer the actual spawn off the request path; spawn() is non-blocking but this guarantees the
    // current HTTP response is never delayed by worker startup.
    setImmediate(() => launch(env, state, workerPath));
    return { spawned: true, reason: "spawning" };
  } catch (err: any) {
    slog("error", { where: "ensureSeedWorker", err: String(err?.message ?? err).slice(0, 160) });
    return { spawned: false, reason: "ensureSeedWorker error (isolated)" };
  }
}

function safeExists(p: string): boolean { try { return fs.existsSync(p); } catch { return false; } }

function launch(env: NodeJS.ProcessEnv, state: WorkerState, workerPath: string): void {
  if (state.disabled || (state.child && state.child.exitCode === null)) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require("node:child_process");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    try { require("@/lib/db").getDb(); } catch { /* schema is migrated on first web getDb; worker retries */ }

    const child = spawn(process.execPath, ["--experimental-strip-types", workerPath], {
      // OPTISCAN_PROCESS_ROLE stops the child from ever spawning its own worker (no recursion).
      env: { ...env, OPTISCAN_PROCESS_ROLE: "seed-worker" },
      stdio: "inherit",     // inherit parent fds → no unread pipe to back-pressure the parent
      detached: false,      // dies with the web process; a fresh boot reclaims the stale lease
    });
    state.child = child;
    slog("worker_spawn", { pid: child.pid, ppid: process.pid, role: "web", node: process.versions.node, failures: state.failures, workerPath });

    const fail = (why: string, extra: Record<string, unknown>) => {
      state.failures += 1;
      slog("error", { where: "seed-worker", why, failures: state.failures, ...extra });
      if (state.failures >= MAX_FAILURES) {
        state.disabled = true;
        state.disabledReason = `seed worker disabled after ${state.failures} failures (${why})`;
        slog("worker_exit", { disabled: true, reason: state.disabledReason });
        return;
      }
      const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (state.failures - 1));
      slog("worker_respawn", { afterMs: backoff, failures: state.failures });
      const t = setTimeout(() => launch(env, state, workerPath), backoff);
      if (typeof t.unref === "function") t.unref();
    };

    // A spawn-level failure (e.g., ENOENT) arrives here — MUST be handled or Node throws it as an
    // uncaught exception and crashes the web process (the E.4 outage).
    child.on("error", (err: any) => { state.child = null; fail("spawn_error", { err: String(err?.message ?? err).slice(0, 160), code: err?.code }); });
    child.on("exit", (code: number | null, signal: string | null) => {
      state.child = null;
      slog("worker_exit", { pid: child.pid, code, signal });
      // Clean shutdown (SIGTERM / code 0) is not a failure; anything else counts toward the ceiling.
      if (signal === "SIGTERM" || signal === "SIGINT" || code === 0) return;
      fail("nonzero_exit", { code, signal });
    });

    const kill = () => { try { child.kill("SIGTERM"); } catch { /* ignore */ } };
    process.once("exit", kill);
  } catch (err: any) {
    state.failures += 1;
    slog("error", { where: "launch", err: String(err?.message ?? err).slice(0, 160), failures: state.failures });
    if (state.failures >= MAX_FAILURES) { state.disabled = true; state.disabledReason = "seed worker disabled after repeated launch errors"; }
  }
}
