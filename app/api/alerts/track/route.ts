import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/alerts/track — run one checkpoint sweep now. The in-process
 * scheduler calls the same sweep every 60s; this route exists for manual
 * catch-up and for external cron (e.g. Vercel Cron) on serverless deploys
 * where no resident process exists. */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  try {
    const { runTrackerSweep } = await import("@/lib/alert-tracker");
    const result = await runTrackerSweep();
    return NextResponse.json({ ok: true, ...result });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? "sweep failed" }, { status: 500 });
  }
}
