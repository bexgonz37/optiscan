import { NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-route-auth";
import { ensureServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/content-drafts — owner-only list of Content Event Engine drafts.
 * Query: symbol, category, status, eventType, sinceMs, limit, id (detail)
 * Never auto-posts. Token-gated.
 */
export async function GET(req: Request) {
  const denied = requireApiToken(req);
  if (denied) return denied;
  ensureServerBoot();
  try {
    const { getDb } = await import("@/lib/db");
    const {
      listContentDraftsOnDb,
      getContentDraftOnDb,
    } = await import("@/lib/content/content-drafts-runtime");
    const { buildSubscriberClaimPacket } = await import("@/lib/research/options/subscriber-claims");
    const url = new URL(req.url);
    const id = String(url.searchParams.get("id") ?? "").trim();
    const db = getDb();

    if (id) {
      const draft = getContentDraftOnDb(db as any, id);
      if (!draft) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
      let claim = null;
      if (draft.alert_id) {
        try { claim = buildSubscriberClaimPacket(db as any, String(draft.alert_id)); } catch { claim = null; }
      }
      return NextResponse.json({
        ok: true,
        draft,
        claim,
        note: "Owner-only draft — never auto-posted to X/Twitter.",
      });
    }

    const drafts = listContentDraftsOnDb(db as any, {
      limit: Number(url.searchParams.get("limit") ?? 50),
      symbol: url.searchParams.get("symbol") ?? undefined,
      category: url.searchParams.get("category") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      eventType: url.searchParams.get("eventType") ?? undefined,
      sinceMs: url.searchParams.get("sinceMs") ? Number(url.searchParams.get("sinceMs")) : undefined,
    });
    return NextResponse.json({
      ok: true,
      drafts,
      note: "Owner-only drafts — never auto-posted to X/Twitter. Discord copies route to DISCORD_WEBHOOK_RECAP.",
    });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}

/**
 * POST /api/content-drafts — owner actions: approve | reject | edit | mark_posted | save_final | regenerate
 */
export async function POST(req: Request) {
  const denied = requireApiToken(req);
  if (denied) return denied;
  ensureServerBoot();
  try {
    const body = await req.json().catch(() => ({}));
    const id = String(body?.id ?? "").trim();
    const action = String(body?.action ?? "").trim();
    if (!id || !action) {
      return NextResponse.json({ ok: false, error: "id and action required" }, { status: 400 });
    }
    const { getDb } = await import("@/lib/db");
    const {
      updateContentDraftOnDb,
      regenerateContentDraftOnDb,
      getContentDraftOnDb,
    } = await import("@/lib/content/content-drafts-runtime");
    const db = getDb();

    if (action === "regenerate") {
      const draft = regenerateContentDraftOnDb(db as any, id);
      if (!draft) return NextResponse.json({ ok: false, error: "regenerate_failed" }, { status: 400 });
      return NextResponse.json({ ok: true, draft });
    }

    const allowed = ["approve", "reject", "edit", "mark_posted", "save_final"] as const;
    if (!(allowed as readonly string[]).includes(action)) {
      return NextResponse.json({ ok: false, error: `unknown action '${action}'` }, { status: 400 });
    }
    const ok = updateContentDraftOnDb(db as any, id, {
      action: action as typeof allowed[number],
      editedText: body?.editedText,
      finalCopy: body?.finalCopy,
    });
    if (!ok) return NextResponse.json({ ok: false, error: "update_failed" }, { status: 400 });
    return NextResponse.json({ ok: true, draft: getContentDraftOnDb(db as any, id) });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
