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

    const { readDeliveryMetricsOnDb } = await import("@/lib/research/options/delivery");

    const { deliveryDecisionMetricsOnDb } = await import("@/lib/research/options/delivery-decision");

    const deliveryMetrics = readDeliveryMetricsOnDb(db as any);

    const decisionMetrics = deliveryDecisionMetricsOnDb(db as any);

    return NextResponse.json(

      {

        ok: true,

        generatedAtMs: Date.now(),

        tradingSessionDate: tradingDay(),

        killSwitch: process.env.OPTIONS_CALLOUTS_KILL === "1",

        gates: {

          marketSessionGuard: process.env.MARKET_SESSION_GUARD ?? "shadow",

          entryQualityGate: process.env.ENTRY_QUALITY_GATE ?? "shadow",

          subscriberShadowMode: process.env.SUBSCRIBER_SHADOW_MODE === "1",

          subscriberOwner: process.env.SUBSCRIBER_OPTIONS_DISCORD_OWNER ?? "legacy",

          billingEnabled: process.env.BILLING_ENABLED === "1",

        },

        days,

        aggregate,

        daily,

        deliveryMetrics,

        decisionMetrics,

      },

      { status: 200, headers: { "content-type": "application/json" } },

    );

  } catch (err) {

    return jsonFromRouteError(err);

  }

}


