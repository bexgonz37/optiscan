import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/alerts/stats?date=YYYY-MM-DD — dashboard aggregates. */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  try {
    const { statsSummary } = await import("@/lib/alert-store");
    const date = new URL(req.url).searchParams.get("date") || undefined;
    return NextResponse.json({ ok: true, ...statsSummary(date) });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? "stats unavailable" }, { status: 500 });
  }
}
