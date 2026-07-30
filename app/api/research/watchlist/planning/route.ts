import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET — read-only Watchlist planning status (persisted context + last job result).
 * Never writes; mirrors the read-only contract of GET /api/now.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const { getDb } = await import("@/lib/db");
    const { loadNextSessionContextOnDb } = await import("@/lib/research/watchlist/market-context-snapshot");
    const { loadOvernightPlan } = await import("@/lib/research/overnight/next-session-plan");
    const { schedulerState } = await import("@/lib/scheduler");
    const db = getDb();
    const plan = loadOvernightPlan(db as any);
    const sched = schedulerState();
    return NextResponse.json({
      ok: true,
      readOnly: true,
      marketContext: loadNextSessionContextOnDb(db as any),
      planVersion: plan?.planVersion ?? null,
      publishedCount: plan?.recommendations?.length ?? 0,
      needsMoreDataCount: plan?.needsMoreData?.length ?? 0,
      evidenceCompleteness: plan?.evidenceCompleteness ?? null,
      scheduler: {
        lastRunAtMs: sched.lastRun.watchlistPlanning ?? null,
        runs: sched.runs.watchlistPlanning ?? 0,
        lastResult: sched.lastWatchlistPlanning ?? null,
        lastError: sched.lastError,
      },
    }, { status: 200 });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}

/**
 * POST — explicit maintenance action: record market context, clear stale plans, and
 * rebuild the persisted plan. This is the deliberate counterpart to the scheduled
 * job; it never sends Discord and never changes scanner or delivery behaviour.
 */
export async function POST(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const { getDb } = await import("@/lib/db");
    const { runWatchlistPlanningJobOnDb, liveWatchlistPlanningDeps } = await import("@/lib/research/watchlist/market-context-job");
    const { buildNextSessionPlan, persistOvernightPlan } = await import("@/lib/research/overnight/next-session-plan");
    const result = await runWatchlistPlanningJobOnDb(
      getDb() as any,
      liveWatchlistPlanningDeps(),
      { buildNextSessionPlan: buildNextSessionPlan as any, persistOvernightPlan: persistOvernightPlan as any },
    );
    return NextResponse.json({ ok: result.errors.length === 0, result }, { status: 200 });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
