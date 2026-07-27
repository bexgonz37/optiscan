import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/research/owner-research/test-notification
 * Owner-only recap webhook TEST. Never touches subscriber delivery or readiness metrics.
 */
export async function POST(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const { sendOwnerResearchTestNotification } = await import("@/lib/notifications/owner-research-notify");
    const res = await sendOwnerResearchTestNotification(process.env);
    return NextResponse.json(
      {
        ok: res.ok,
        configured: res.configured,
        sent: res.sent,
        reason: res.reason,
        messageId: res.messageId,
        operatingMode: res.operatingMode,
        operatingLabel: res.operatingLabel,
        stateChanged: false,
      },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
