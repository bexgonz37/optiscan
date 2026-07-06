import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/alerts/performance — checkpoint rows joined with their alerts. */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  try {
    const { listPerformance } = await import("@/lib/alert-store");
    const q = new URL(req.url).searchParams;
    const rows = listPerformance({
      date: q.get("date") || undefined,
      ticker: q.get("ticker") || undefined,
      limit: q.get("limit") ? Number(q.get("limit")) : undefined,
    });
    return NextResponse.json({ ok: true, performance: rows });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? "performance unavailable", performance: [] }, { status: 500 });
  }
}
