import { NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-route-auth";
import { ensureServerBoot } from "@/lib/server-boot";
import { generateDraftFromContentEvent, listPendingSocialDrafts } from "@/lib/social-drafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireApiToken(req);
  if (denied) return denied;
  ensureServerBoot();
  const { getDb } = await import("@/lib/db");
  const drafts = listPendingSocialDrafts(getDb(), 50);
  return NextResponse.json({ ok: true, drafts, note: "Drafts only — never auto-posted to X/Twitter." });
}

export async function POST(req: Request) {
  const denied = requireApiToken(req);
  if (denied) return denied;
  ensureServerBoot();
  let body: { contentEventId?: string } = {};
  try {
    body = await req.json();
  } catch { /* empty */ }
  const id = String(body.contentEventId ?? "").trim();
  if (!id) return NextResponse.json({ ok: false, error: "contentEventId required" }, { status: 400 });
  const { getDb } = await import("@/lib/db");
  const draft = generateDraftFromContentEvent(getDb(), id);
  if (!draft) return NextResponse.json({ ok: false, error: "not claimable or not found" }, { status: 404 });
  return NextResponse.json({ ok: true, draft });
}
