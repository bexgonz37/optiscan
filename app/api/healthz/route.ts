import { NextResponse } from "next/server";
import { deployInfo } from "@/lib/build-info";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/healthz — lightweight deployment liveness/readiness probe (Railway).
 *
 * Returns 200 when the web server is up and the SQLite database can be opened.
 * The probe response NEVER waits on background boot and does NOT fail when the
 * market is closed, no graded outcomes exist, the model is inactive, Discord is
 * not configured, Polygon is rate-limited, or nothing is currently actionable —
 * those are normal operating states, reported in detail by /api/runtime/status.
 *
 * It returns 503 ONLY when the database cannot be opened (a genuine failure).
 * It never exposes secrets, webhook URLs, tokens, or database contents.
 *
 * Autonomous-boot note: the standalone build cannot import the .ts boot module from
 * instrumentation, so the background runtime (scanner/scheduler/paper/options
 * monitor/grader/AI worker) is started here — but DEFERRED via setImmediate so it
 * runs AFTER this response is sent and can never slow or fail the probe. Idempotent
 * (a `started` guard) and fully isolated, so repeated Railway probes cost nothing.
 */
export async function GET() {
  let dbOk = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require("@/lib/db");
    dbOk = getDb().prepare("SELECT 1 AS one").get()?.one === 1;
  } catch {
    dbOk = false;
  }

  // Kickstart the autonomous runtime off the probe path (deferred; never blocks the response).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ensureServerBoot } = require("@/lib/server-boot");
    setImmediate(() => { try { ensureServerBoot(); } catch { /* boot is best-effort; DB openability is the real gate */ } });
  } catch { /* server-boot unavailable — the probe still reports DB health honestly */ }

  // Deployed commit (Railway injects the SHA at runtime) — the only reliable way to
  // confirm which commit is live vs origin/main. Read via the build-info helper so this
  // route reads no env directly. Not a secret; safe to expose.
  const { commit, commitShort, branch } = deployInfo();
  const body = { ok: dbOk, db: dbOk, service: "optiscan", commit, commitShort, branch, nowMs: Date.now() };
  return NextResponse.json(body, { status: dbOk ? 200 : 503 });
}
