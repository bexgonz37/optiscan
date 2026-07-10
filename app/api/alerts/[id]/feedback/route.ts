import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED = new Set([
  "not_fresh",
  "wrong_direction",
  "late",
  "too_extended",
  "bad_liquidity",
  "no_momentum",
  "confusing",
  "other",
]);

/** POST /api/alerts/:id/feedback - structured incorrect-alert feedback. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!checkApiToken(req)) return unauthorized();
  const { id: rawId } = await params;
  const alertId = Number(rawId);
  if (!Number.isFinite(alertId) || alertId <= 0) {
    return NextResponse.json({ ok: false, error: "invalid alert id" }, { status: 400 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const reason = String(body?.reason ?? body?.feedbackReason ?? "other").trim() || "other";
    const userFeedback = String(body?.feedback ?? body?.userFeedback ?? "incorrect_alert").trim() || "incorrect_alert";
    if (!ALLOWED.has(reason)) {
      return NextResponse.json({ ok: false, error: "invalid feedback reason" }, { status: 400 });
    }
    const { getAlertDetail, insertAlertFeedback } = await import("@/lib/alert-store");
    if (!getAlertDetail(alertId)) {
      return NextResponse.json({ ok: false, error: "alert not found" }, { status: 404 });
    }
    const feedbackId = insertAlertFeedback({
      alertId,
      userFeedback,
      feedbackReason: reason,
      notes: body?.notes != null ? String(body.notes).slice(0, 1000) : null,
    });
    return NextResponse.json({ ok: true, feedbackId });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? "feedback unavailable" }, { status: 500 });
  }
}
