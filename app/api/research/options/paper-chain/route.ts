import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Owner diagnostic: independent SENT → paper → case → grader chain. */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const alertId = url.searchParams.get("alertId");
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 40) || 40));
    const { getDb } = await import("@/lib/db");
    const { buildPaperChainDiagnostic, getPaperChainDetail } = await import("@/lib/research/options/paper-chain");
    const db = getDb();
    if (alertId) {
      const detail = getPaperChainDetail(db as any, alertId);
      if (!detail) return NextResponse.json({ ok: false, error: "alert_not_found" }, { status: 404 });
      return NextResponse.json({ ok: true, detail }, { status: 200 });
    }
    const diagnostic = buildPaperChainDiagnostic(db as any, process.env, limit);
    return NextResponse.json({ ok: true, diagnostic }, { status: 200 });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
