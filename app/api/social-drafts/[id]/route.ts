import { NextRequest, NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-route-auth";
import { ensureServerBoot } from "@/lib/server-boot";
import { draftCopyText, updateDraftStatus } from "@/lib/social-drafts";
import { listPendingSocialDrafts } from "@/lib/social-drafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireApiToken(req);
  if (denied) return denied;
  ensureServerBoot();
  const { id } = await ctx.params;
  let body: { action?: string; editedText?: string } = {};
  try {
    body = await req.json();
  } catch { /* empty */ }
  const action = String(body.action ?? "").toLowerCase();
  const { getDb } = await import("@/lib/db");
  const db = getDb();
  if (action === "approve") {
    updateDraftStatus(db, id, "APPROVED", body.editedText ?? null);
  } else if (action === "reject") {
    updateDraftStatus(db, id, "REJECTED");
  } else if (action === "edit") {
    updateDraftStatus(db, id, "DRAFTED", body.editedText ?? null);
  } else {
    return NextResponse.json({ ok: false, error: "action must be approve|reject|edit" }, { status: 400 });
  }
  const row = listPendingSocialDrafts(db, 50).find((d) => d.id === id);
  return NextResponse.json({ ok: true, draft: row, copyText: row ? draftCopyText(row) : null });
}
