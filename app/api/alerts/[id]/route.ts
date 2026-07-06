import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/alerts/:id — one alert with checkpoints, snapshots, catalysts, journal. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!checkApiToken(req)) return unauthorized();
  const { id } = await params;
  try {
    const { getAlertDetail } = await import("@/lib/alert-store");
    const detail = getAlertDetail(Number(id));
    if (!detail) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true, ...detail });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? "alert unavailable" }, { status: 500 });
  }
}
