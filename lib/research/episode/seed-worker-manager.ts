/**
 * lib/research/episode/seed-worker-manager.ts — spawns & supervises the out-of-process seed
 * worker from the WEB process (Analog Engine, Phase E.4).
 *
 * The web process NEVER runs replay itself; it only ensures the worker child is alive and reads
 * persisted state. The child is a separate OS process (own event loop) so its synchronous seeding
 * cannot block the API event loop. Idempotent per Node process. Also starts an event-loop-lag
 * sampler on the web thread so a regression (something blocking the API loop) is observable.
 */
import { researchFlags } from "../flags.ts";
import { slog, startEventLoopLagSampler } from "./seed-log.ts";

type G = typeof globalThis & { __optiscanSeedWorker?: { child: any; stopSampler: () => void }; __optiscanSeedWorkerStarting?: boolean };

/** Ensure the background seed worker process is running (idempotent). Safe to call on every
 *  request. No-op unless replay + capture flags are enabled (nothing to seed otherwise). */
export function ensureSeedWorker(env: NodeJS.ProcessEnv = process.env): void {
  const g = globalThis as G;
  if (g.__optiscanSeedWorker || g.__optiscanSeedWorkerStarting) return;
  const f = researchFlags(env);
  if (!f.historicalReplay || !f.episodeCapture) return; // no jobs will ever be created
  g.__optiscanSeedWorkerStarting = true;
  try {
    // Migrate the schema in the web process first so the worker's connection sees the tables.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require("node:child_process");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("@/lib/db").getDb();

    const workerPath = path.join(process.cwd(), "worker", "seed-worker.ts");
    const stopSampler = startEventLoopLagSampler(1000, 200);

    const launch = () => {
      const child = spawn(process.execPath, ["--experimental-strip-types", workerPath], {
        env: process.env,
        stdio: "inherit",
        detached: false, // dies with the web process; a fresh web boot reclaims stale leases
      });
      slog("worker_spawn", { pid: child.pid, workerPath });
      child.on("exit", (code: number | null) => {
        slog("worker_exit", { pid: child.pid, code });
        if (g.__optiscanSeedWorker) {
          // Unexpected exit while we still want a worker → respawn with a small backoff.
          slog("worker_respawn", { after: code });
          setTimeout(() => { if (g.__optiscanSeedWorker) g.__optiscanSeedWorker.child = launch(); }, 2000);
        }
      });
      return child;
    };

    const child = launch();
    g.__optiscanSeedWorker = { child, stopSampler };
    // Best-effort: stop the child when the web process exits.
    const kill = () => { try { child.kill("SIGTERM"); } catch { /* ignore */ } };
    process.once("exit", kill);
    process.once("SIGTERM", kill);
    process.once("SIGINT", kill);
  } catch (err: any) {
    slog("error", { where: "ensureSeedWorker", err: String(err?.message ?? err).slice(0, 160) });
  } finally {
    g.__optiscanSeedWorkerStarting = false;
  }
}
