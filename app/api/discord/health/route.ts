import { NextResponse } from "next/server";
import { discordDeliverySummary, listDiscordDeliveries } from "@/lib/alert-store";
import { discordWebhookConfigured } from "@/lib/notifications";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    webhooks: {
      options: discordWebhookConfigured("options"),
      stocks: discordWebhookConfigured("stocks"),
      recap: discordWebhookConfigured("recap"),
      default: discordWebhookConfigured("default"),
    },
    summary: discordDeliverySummary(),
    recentFailures: listDiscordDeliveries(10).filter((d) => ["FAILED", "RETRYING", "SUPPRESSED", "NOT_CONFIGURED"].includes(d.status)),
  });
}
