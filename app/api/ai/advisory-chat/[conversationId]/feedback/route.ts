import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST — thumbs up/down on one assistant message.
 *
 * Feedback is recorded for human review only. It never tunes a model, changes a
 * threshold, or influences any live behaviour.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ conversationId: string }> },
) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const { conversationId } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const feedback = String((body as any)?.feedback ?? "").toLowerCase();
    const messageId = Number((body as any)?.messageId);
    if (feedback !== "up" && feedback !== "down") {
      return NextResponse.json({ ok: false, error: "feedback_must_be_up_or_down" }, { status: 400 });
    }
    if (!Number.isFinite(messageId) || messageId <= 0) {
      return NextResponse.json({ ok: false, error: "messageId_required" }, { status: 400 });
    }
    const { getDb } = await import("@/lib/db");
    const { recordFeedbackOnDb } = await import("@/lib/ai/advisory-chat-store");
    const saved = recordFeedbackOnDb(getDb() as any, {
      conversationId,
      messageId,
      feedback: feedback as "up" | "down",
      note: (body as any)?.note ? String((body as any).note) : null,
    });
    if (!saved) return NextResponse.json({ ok: false, error: "message_not_found" }, { status: 404 });
    return NextResponse.json({
      ok: true,
      note: "Feedback recorded for human review. It does not tune any model or change production behaviour.",
    }, { status: 200 });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
