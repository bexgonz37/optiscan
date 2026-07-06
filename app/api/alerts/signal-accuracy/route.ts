import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/alerts/signal-accuracy?days=14 — BUY signal hit rate and recent outcomes. */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  try {
    const url = new URL(req.url);
    const days = Number(url.searchParams.get("days") ?? 14);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const { tradeSignalAccuracy } = await import("@/lib/alert-store");
    return NextResponse.json({ ok: true, ...tradeSignalAccuracy({ days, limit }) });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message }, { status: 500 });
  }
}
