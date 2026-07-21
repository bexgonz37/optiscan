import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-run seed-job control (Analog Engine, Phase E.3). Token-gated.
 *   GET  /api/research/seed/:runId          — progress (symbols, chunks, calls, episodes, ETA…).
 *   POST /api/research/seed/:runId {action}  — action = cancel | pause | resume.
 * A GET on a QUEUED/RUNNING run whose in-process worker was lost (server restart) re-kicks it,
 * so a job is never permanently orphaned. No secrets in any response.
 */
export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  const { runId } = await params;
  const { getDb } = await import("@/lib/db");
  const { getSeedRunProgress, isSeedRunActive, runSeedWorker } = await import("@/lib/research/episode/seed-jobs");
  const db = getDb();
  const progress = getSeedRunProgress(db, runId);
  if (!progress.found) return NextResponse.json({ ok: false, error: "run not found" }, { status: 404 });
  // Restart recovery: a run still QUEUED/RUNNING with no active worker means the process was
  // restarted — re-kick the background worker (idempotent; resumes from the checkpoint).
  if ((progress.status === "QUEUED" || progress.status === "RUNNING") && !progress.cancelRequested && !isSeedRunActive(runId)) {
    void runSeedWorker(db, runId, process.env).catch(() => { /* isolated */ });
  }
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
  if (action === "cancel") return NextResponse.json({ ok: true, result: jobs.cancelSeedRun(db, runId) });
  if (action === "pause") return NextResponse.json({ ok: true, result: jobs.pauseSeedRun(db, runId) });
  if (action === "resume") {
    const result = jobs.resumeSeedRun(db, runId);
    if (result.changed) void jobs.runSeedWorker(db, runId, process.env).catch(() => { /* isolated */ });
    return NextResponse.json({ ok: true, result });
  }
  return NextResponse.json({ ok: false, error: "action must be one of: cancel | pause | resume" }, { status: 400 });
}
