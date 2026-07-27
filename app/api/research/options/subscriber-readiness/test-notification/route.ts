import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Owner action: send a clearly-labeled TEST notification to the recap channel. This NEVER reads or
 * writes readiness state and is NOT a launch signal — it only proves the webhook + message format.
 */
export async function POST(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const { getDb } = await import("@/lib/db");
    const { sendReadinessTestNotificationOnDb } = await import("@/lib/research/subscriber-readiness-notifier");
    const res = await sendReadinessTestNotificationOnDb(getDb(), {}, process.env);
    return NextResponse.json(
      { ok: res.ok, configured: res.configured, messageId: res.messageId, error: res.error, stateChanged: false },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
