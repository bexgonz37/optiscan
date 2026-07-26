import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Auth-gated shadow-mode daily comparison summaries. */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days") ?? 7)));
    const { getDb } = await import("@/lib/db");
    const { shadowSummaryRecentDays } = await import("@/lib/research/options/shadow-report");
    const { tradingDay } = await import("@/lib/trading-session");
    const db = getDb();
    const daysSummary = shadowSummaryRecentDays(db as any, days);
    return NextResponse.json(
      {
        ok: true,
        generatedAtMs: Date.now(),
        tradingSessionDate: tradingDay(),
        days,
        summaries: daysSummary,
      },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
