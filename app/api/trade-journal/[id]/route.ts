import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PATCH /api/trade-journal/:id — update fields on a journal entry. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!checkApiToken(req)) return unauthorized();
  const { id } = await params;
  try {
    const body = await req.json();
    const { updateJournal } = await import("@/lib/alert-store");
    const entry = updateJournal(Number(id), body ?? {});
    if (!entry) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true, entry });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? "journal update failed" }, { status: 500 });
  }
}
