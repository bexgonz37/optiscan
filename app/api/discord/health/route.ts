import { NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-route-auth";
import { discordDeliverySummary, discordDeliveryWindowMetrics, listDiscordDeliveries } from "@/lib/alert-store";
import { buildSubscriberDiscordReadiness } from "@/lib/discord-readiness";
import { discordWebhookConfigured } from "@/lib/notifications";
import { recapDeliveryDiagnosis } from "@/lib/notifications/recap-health";
import { subscriberDiscordOwnershipSummary } from "@/lib/subscriber-discord-owner";
import { buildDiscordRoutingRows } from "@/lib/discord-routing";
import { nextWatchlistWindowSummary, schedulerState } from "@/lib/scheduler";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireApiToken(req);
  if (denied) return denied;
  const webhooks = {
    options: discordWebhookConfigured("options"),
    watchlist: discordWebhookConfigured("watchlist"),
    recap: discordWebhookConfigured("recap"),
  };
  // `webhooks.recap` is a GATE and stays one. It cannot explain itself: it
  // returns false both for a missing webhook and for DISCORD_RECAP_ENABLED=0,
  // and on 2026-08-03 that ambiguity was read as a missing webhook when the
  // real cause was the kill-switch. The diagnosis carries no secret value.
  const recapDelivery = recapDeliveryDiagnosis();
  const metrics = discordDeliveryWindowMetrics(24);
  const recentDeliveries = listDiscordDeliveries(250);
  const lastFor = (webhookName: string, statuses: string[], field: "sent_at" | "created_at") => {
    const match = recentDeliveries
      .filter((d: any) => d.webhook_name === webhookName && statuses.includes(String(d.status)) && d[field])
      .sort((a: any, b: any) => String(b[field]).localeCompare(String(a[field])))[0] as any;
    return match?.[field] ?? null;
  };
  const routing = buildDiscordRoutingRows({
    webhooks,
    lastOptionsSendAt: lastFor("options", ["SENT"], "sent_at"),
    lastOptionsFailureAt: lastFor("options", ["FAILED", "RETRYING", "SUPPRESSED", "NOT_CONFIGURED"], "created_at"),
    lastWatchlistSendAt: lastFor("watchlist", ["SENT"], "sent_at"),
    lastWatchlistFailureAt: lastFor("watchlist", ["FAILED", "RETRYING", "SUPPRESSED", "NOT_CONFIGURED"], "created_at"),
    lastRecapSendAt: lastFor("recap", ["SENT"], "sent_at"),
    lastRecapFailureAt: lastFor("recap", ["FAILED", "RETRYING", "SUPPRESSED", "NOT_CONFIGURED"], "created_at"),
    nextWatchlistWindow: nextWatchlistWindowSummary(),
    schedulerStatus: schedulerState().note,
  });
  const readiness = buildSubscriberDiscordReadiness({
    webhooks: {
      ...webhooks,
      stocks: discordWebhookConfigured("stocks"),
    },
    metrics,
    optionsRequired: true,
    stocksRequired: process.env.STOCK_CALLOUTS === "1",
  });
  return NextResponse.json({
    ok: true,
    subscriberSurface: "discord_only",
    ownership: subscriberDiscordOwnershipSummary(),
    webhooks,
    recapDelivery,
    metrics,
    routing,
    readiness,
    summary: discordDeliverySummary(),
    recentFailures: listDiscordDeliveries(10).filter((d) => ["FAILED", "RETRYING", "SUPPRESSED", "NOT_CONFIGURED"].includes(d.status)),
  });
}
