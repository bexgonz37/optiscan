import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/popup-events — log popup interactions (shown/watch/snooze/...). */
export async function POST(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  try {
    const body = await req.json();
    const { logPopupEvent } = await import("@/lib/alert-store");
    logPopupEvent(body?.alertId ?? null, body?.ticker ?? null, String(body?.action ?? "unknown"));
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message }, { status: 500 });
  }
}
