import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/diagnostics/loop-health — is the scanner loop actually ticking?
 *
 * `/api/health` reports `loopRunning: true` whenever the loop was ever started. That
 * stayed true through a ~5.5 hour wedge in which no tick ran at all, because the flag
 * describes a startup event and not liveness. This endpoint reports the distinction:
 *
 *   HEALTHY     ticks are completing
 *   DEGRADED    completing, but failing or overdue
 *   RECOVERING  a tick was abandoned and fresh ticks are being launched again
 *   WEDGED      no tick can make progress; the loop is refusing to launch more work
 *
 * Zero provider calls, zero quota spend, no send authority.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const { scannerLoopHealth } = await import("@/lib/scanner-loop");
    const { marketSession } = await import("@/lib/trading-session");
    const health = scannerLoopHealth();
    const nowMs = Date.now();

    let schedulerOwner: {
      pid: number | null; hostname: string | null; heartbeatAt: string | null; isThisProcess: boolean;
    } | null = null;
    try {
      const { getDb } = await import("@/lib/db");
      const row = (getDb() as any)
        .prepare("SELECT pid, hostname, heartbeat_at FROM scanner_lock WHERE id = 1")
        .get() as { pid?: number; hostname?: string; heartbeat_at?: string } | undefined;
      if (row) {
        schedulerOwner = {
          pid: row.pid == null ? null : Number(row.pid),
          hostname: row.hostname == null ? null : String(row.hostname),
          heartbeatAt: row.heartbeat_at == null ? null : String(row.heartbeat_at),
          isThisProcess: Number(row.pid) === process.pid,
        };
      }
    } catch { /* the lock table is advisory; its absence is not a health claim */ }

    return NextResponse.json({
      ok: true,
      at: new Date(nowMs).toISOString(),
      loop: health,
      session: marketSession(nowMs),
      schedulerOwner,
      pid: process.pid,
      note:
        "State is derived from tick completion, not from process aliveness. WEDGED means "
        + "abandoned ticks never settled and the loop is deliberately not stacking more work.",
    });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
