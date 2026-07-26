import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Auth-gated shadow soak dashboard data. */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days") ?? 7)));
    const detailId = url.searchParams.get("id");
    const { getDb } = await import("@/lib/db");
    const { buildShadowSoakAggregate, getShadowOutcomeDetail } = await import("@/lib/research/options/shadow-outcomes");
    const { shadowSummaryRecentDays } = await import("@/lib/research/options/shadow-report");
    const { tradingDay } = await import("@/lib/trading-session");
    const db = getDb();

    if (detailId) {
      const detail = getShadowOutcomeDetail(db as any, Number(detailId));
      if (!detail) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
      return NextResponse.json({ ok: true, detail }, { status: 200 });
    }

    const aggregate = buildShadowSoakAggregate(db as any, process.env, days);
    const daily = shadowSummaryRecentDays(db as any, days);
    return NextResponse.json(
      {
        ok: true,
        generatedAtMs: Date.now(),
        tradingSessionDate: tradingDay(),
        killSwitch: process.env.OPTIONS_CALLOUTS_KILL === "1",
        days,
        aggregate,
        daily,
      },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
