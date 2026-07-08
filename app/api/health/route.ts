import { NextResponse } from "next/server";
import { providerStatus } from "@/lib/scan-core";
import { ensureServerBoot } from "@/lib/server-boot";
import { checkApiToken } from "@/lib/auth";
import { buildHealth } from "@/lib/health";
import { loopState } from "@/lib/scanner-loop";
import { getCallStats } from "@/lib/polygon-provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Deep health endpoint (audit T4/P1-1).
 * - 503 when the scanner loop is stalled during a non-closed session, so
 *   Docker healthchecks / uptime monitors react.
 * - Unauthenticated (when SCAN_API_TOKEN is set): shallow liveness-only body.
 *   Authorized (token header, or no token configured): full loop/quota/db
 *   stats. See README "Health & monitoring".
 */
export async function GET(req: Request) {
  ensureServerBoot();
  const status = providerStatus();
  const nowMs = Date.now();

  let dbWritable: boolean | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require("@/lib/db");
    dbWritable = getDb().prepare("SELECT 1 AS one").get()?.one === 1;
  } catch {
    dbWritable = false;
  }

  const loop = loopState();
  const { status: httpStatus, body } = buildHealth({
    loop: {
      running: loop.running,
      intervalMs: loop.intervalMs,
      lastTickAt: loop.lastTickAt,
      ticks: loop.ticks,
      triggers: loop.triggers,
      alerts: loop.alerts,
      errors: loop.errors,
      note: loop.note,
      session: loop.session ?? null,
    },
    callStats: getCallStats(nowMs),
    dbWritable,
    provider: status.provider,
    keyPresent: status.keyPresent,
    nowMs,
    authorized: checkApiToken(req),
  });
  return NextResponse.json(body, { status: httpStatus });
}
