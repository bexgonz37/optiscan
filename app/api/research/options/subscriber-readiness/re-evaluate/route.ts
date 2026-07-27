import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Owner action: re-evaluate readiness NOW (trigger="manual"). A manual run may transition state and
 * send the one-time READY/REVOKED notification if a real edge is crossed — that is the point of the
 * action. It does NOT enable billing, invite subscribers, change roles, or deploy anything.
 */
export async function POST(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const { getDb } = await import("@/lib/db");
    const { runReadinessTransition } = await import("@/lib/research/subscriber-readiness-notifier");
    const result = await runReadinessTransition(getDb(), {}, process.env, { trigger: "manual" });
    return NextResponse.json(
      {
        ok: true,
        transitioned: result.transitioned,
        notificationSent: result.notificationSent,
        notificationKind: result.notificationKind,
        report: result.report,
        state: result.state,
      },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
