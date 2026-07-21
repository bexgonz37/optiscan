import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-run seed-job control (Analog Engine, Phase E.4). Token-gated.
 *   GET  /api/research/seed/:runId          — progress ONLY (a cheap DB read; never runs replay).
 *   POST /api/research/seed/:runId {action}  — action = cancel | pause | resume (DB flags only).
 * Replay work runs exclusively in the separate worker process. This handler must stay fast so the
 * API loop is never blocked; stale-run recovery is done by the worker's lease poll, NOT here.
 */
export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  const { runId } = await params;
  const t0 = Date.now();
  const { getDb } = await import("@/lib/db");
  const { getSeedRunProgress } = await import("@/lib/research/episode/seed-jobs");
  const { ensureSeedWorker } = await import("@/lib/research/episode/seed-worker-manager");
  const { slog } = await import("@/lib/research/episode/seed-log");
  slog("api_request_start", { route: "seed/:runId", method: "GET", runId });
  ensureSeedWorker(process.env); // make sure a worker exists (spawns a process; does NOT run work here)
  const progress = getSeedRunProgress(getDb(), runId); // pure read of persisted state
  slog("api_request_end", { route: "seed/:runId", method: "GET", runId, ms: Date.now() - t0 });
  if (!progress.found) return NextResponse.json({ ok: false, error: "run not found" }, { status: 404 });
  return NextResponse.json({ ok: true, progress });
}

export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  const { runId } = await params;
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const action = String(body.action ?? "").toLowerCase();
  const { getDb } = await import("@/lib/db");
  const jobs = await import("@/lib/research/episode/seed-jobs");
  const db = getDb();
  // All actions are DB-flag writes; the worker process observes them on its next step / poll.
  if (action === "cancel") return NextResponse.json({ ok: true, result: jobs.cancelSeedRun(db, runId) });
  if (action === "pause") return NextResponse.json({ ok: true, result: jobs.pauseSeedRun(db, runId) });
  if (action === "resume") {
    const result = jobs.resumeSeedRun(db, runId); // flips PAUSED → QUEUED; the worker claims it
    const { ensureSeedWorker } = await import("@/lib/research/episode/seed-worker-manager");
    if (result.changed) ensureSeedWorker(process.env);
    return NextResponse.json({ ok: true, result });
  }
  return NextResponse.json({ ok: false, error: "action must be one of: cancel | pause | resume" }, { status: 400 });
}
