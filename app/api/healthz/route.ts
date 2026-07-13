import { NextResponse } from "next/server";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/healthz — lightweight deployment liveness/readiness probe (Railway).
 *
 * Returns 200 when the web server is up, server boot has been triggered, and the
 * SQLite database can be opened. It deliberately does NOT fail when the market is
 * closed, no graded outcomes exist, the model is inactive, Discord is not
 * configured, Polygon is rate-limited, or nothing is currently actionable — those
 * are normal operating states, reported in detail by /api/runtime/status.
 *
 * It returns 503 ONLY when the database cannot be opened (a genuine failure).
 * It never exposes secrets, webhook URLs, tokens, or database contents.
 */
export async function GET() {
  let bootOk = true;
  try {
    ensureServerBoot();
  } catch {
    bootOk = false; // boot is best-effort; DB openability is the real gate
  }

  let dbOk = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require("@/lib/db");
    dbOk = getDb().prepare("SELECT 1 AS one").get()?.one === 1;
  } catch {
    dbOk = false;
  }

  const body = { ok: dbOk, db: dbOk, boot: bootOk, service: "optiscan", nowMs: Date.now() };
  return NextResponse.json(body, { status: dbOk ? 200 : 503 });
}
