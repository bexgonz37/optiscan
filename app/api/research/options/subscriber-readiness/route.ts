import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Owner-only: current subscriber-readiness state + a fresh (read-only) evaluation. */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const { getDb } = await import("@/lib/db");
    const { evaluateSubscriberReadiness } = await import("@/lib/research/subscriber-readiness");
    const { readReadinessStateOnDb } = await import("@/lib/research/subscriber-readiness-notifier");
    const db = getDb();
    const report = evaluateSubscriberReadiness(db, process.env);
    const state = readReadinessStateOnDb(db);
    return NextResponse.json(
      { ok: true, report, state },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
