import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/trade-journal — list entries. POST — add an entry (personal log,
 * not advice). Body: { alertId?, ticker, side?, entryPrice?, exitPrice?,
 * quantity?, openedAt?, closedAt?, outcomePct?, notes? } */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  try {
    const { listJournal } = await import("@/lib/alert-store");
    const limit = Number(new URL(req.url).searchParams.get("limit") ?? 100);
    return NextResponse.json({ ok: true, journal: listJournal(limit) });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? "journal unavailable", journal: [] }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  try {
    const body = await req.json();
    if (!body?.ticker) return NextResponse.json({ ok: false, error: "ticker required" }, { status: 400 });
    const { insertJournal } = await import("@/lib/alert-store");
    const entry = insertJournal(body);
    return NextResponse.json({ ok: true, entry }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? "journal write failed" }, { status: 500 });
  }
}
