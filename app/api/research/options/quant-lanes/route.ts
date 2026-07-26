import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const { getDb } = await import("@/lib/db");
    const { buildQuantLaneReport } = await import("@/lib/research/options/quant-lanes");
    const report = buildQuantLaneReport(getDb() as any, process.env);
    return NextResponse.json({ ok: true, report }, { status: 200 });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
