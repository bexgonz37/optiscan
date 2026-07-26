import { NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-route-auth";
import { discordDeliverySummary, discordDeliveryWindowMetrics, listDiscordDeliveries } from "@/lib/alert-store";
import { buildSubscriberDiscordReadiness } from "@/lib/discord-readiness";
import { discordWebhookConfigured } from "@/lib/notifications";
import { subscriberDiscordOwnershipSummary } from "@/lib/subscriber-discord-owner";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireApiToken(req);
  if (denied) return denied;
  const webhooks = {
    options: discordWebhookConfigured("options"),
    stocks: discordWebhookConfigured("stocks"),
    recap: discordWebhookConfigured("recap"),
    default: discordWebhookConfigured("default"),
  };
  const metrics = discordDeliveryWindowMetrics(24);
  const readiness = buildSubscriberDiscordReadiness({
    webhooks,
    metrics,
    optionsRequired: true,
    stocksRequired: process.env.STOCK_CALLOUTS === "1",
  });
  return NextResponse.json({
    ok: true,
    subscriberSurface: "discord_only",
    ownership: subscriberDiscordOwnershipSummary(),
    webhooks,
    metrics,
    readiness,
    summary: discordDeliverySummary(),
    recentFailures: listDiscordDeliveries(10).filter((d) => ["FAILED", "RETRYING", "SUPPRESSED", "NOT_CONFIGURED"].includes(d.status)),
  });
}
