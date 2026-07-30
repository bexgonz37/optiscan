import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET — one conversation with its full message history. */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ conversationId: string }> },
) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const { conversationId } = await ctx.params;
    const { getDb } = await import("@/lib/db");
    const { getConversationOnDb } = await import("@/lib/ai/advisory-chat-store");
    const found = getConversationOnDb(getDb() as any, conversationId);
    if (!found) return NextResponse.json({ ok: false, error: "conversation_not_found" }, { status: 404 });
    return NextResponse.json({
      ok: true,
      conversation: found.conversation,
      messages: found.messages,
      safety: { aiAuthority: "ADVISORY_ONLY", productionBehaviorChanged: false },
    }, { status: 200 });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}

/** PATCH — rename a conversation. Title only; never message content. */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ conversationId: string }> },
) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const { conversationId } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const title = String((body as any)?.title ?? "").trim();
    if (!title) return NextResponse.json({ ok: false, error: "title_required" }, { status: 400 });
    const { getDb } = await import("@/lib/db");
    const { renameConversationOnDb } = await import("@/lib/ai/advisory-chat-store");
    const renamed = renameConversationOnDb(getDb() as any, conversationId, title, Date.now());
    if (!renamed) return NextResponse.json({ ok: false, error: "conversation_not_found" }, { status: 404 });
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}

/** DELETE — soft-delete a conversation (audit trail is retained). */
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ conversationId: string }> },
) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const { conversationId } = await ctx.params;
    const { getDb } = await import("@/lib/db");
    const { deleteConversationOnDb } = await import("@/lib/ai/advisory-chat-store");
    const deleted = deleteConversationOnDb(getDb() as any, conversationId, Date.now());
    if (!deleted) return NextResponse.json({ ok: false, error: "conversation_not_found" }, { status: 404 });
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
