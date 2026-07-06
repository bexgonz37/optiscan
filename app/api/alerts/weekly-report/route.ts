import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/alerts/weekly-report — 7-day research summary of scanner output. */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  try {
    const { weeklyReport } = await import("@/lib/alert-store");
    return NextResponse.json({ ok: true, report: weeklyReport() });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? "report unavailable" }, { status: 500 });
  }
}
