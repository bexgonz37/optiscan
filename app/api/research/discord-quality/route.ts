import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Auth-gated Discord quality before/after report. */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const { getDb } = await import("@/lib/db");
    const { buildDiscordQualityReport } = await import("@/lib/research/options/delivery-quality-report");
    const report = buildDiscordQualityReport(getDb() as never, process.env);
    return NextResponse.json({ ok: true, report });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
