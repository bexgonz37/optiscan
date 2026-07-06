import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/alerts — filterable alert list (research log, not trade advice). */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  try {
    const { listAlerts } = await import("@/lib/alert-store");
    const q = new URL(req.url).searchParams;
    const bool = (v: string | null) => (v == null || v === "" ? undefined : v === "1" || v === "true");
    const num = (v: string | null) => (v == null || v === "" ? undefined : Number(v));
    const alerts = listAlerts({
      ticker: q.get("ticker") || undefined,
      date: q.get("date") || undefined,
      catalystType: q.get("catalyst") || undefined,
      minSignal: num(q.get("minSignal")),
      maxRisk: num(q.get("maxRisk")),
      minLiquidity: num(q.get("minLiquidity")),
      falsePositive: bool(q.get("falsePositive")),
      tradeTaken: bool(q.get("tradeTaken")),
      status: q.get("status") || undefined,
      limit: num(q.get("limit")),
      offset: num(q.get("offset")),
    });
    return NextResponse.json({ ok: true, alerts });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? "alerts unavailable", alerts: [] }, { status: 500 });
  }
}
