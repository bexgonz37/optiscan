import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { confirmAndSendPending } from "@/lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET — list Discord alerts waiting for manual confirmation.
 * POST {id} — confirm and send one. POST {id, action:"discard"} — drop it. */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  try {
    const { pendingDiscordEvents } = await import("@/lib/alert-store");
    return NextResponse.json({ ok: true, pending: pendingDiscordEvents() });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  try {
    const body = await req.json();
    const id = Number(body?.id);
    if (!Number.isFinite(id)) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
    if (body?.action === "discard") {
      const { markNotificationEvent } = await import("@/lib/alert-store");
      markNotificationEvent(id, "skipped", "discarded manually");
      return NextResponse.json({ ok: true, discarded: id });
    }
    const result = await confirmAndSendPending(id);
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message }, { status: 500 });
  }
}
