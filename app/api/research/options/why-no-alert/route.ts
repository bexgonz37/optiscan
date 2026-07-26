import { NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-route-auth";
import { ensureServerBoot } from "@/lib/server-boot";
import { explainTickerAlertDecision } from "@/lib/research/options/why-no-alert";
import { isDiscoveryPaused, quotaPolicySnapshot } from "@/lib/quota-policy";
import { subscriberDiscordOwnershipSummary } from "@/lib/subscriber-discord-owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Auth-gated: why a ticker did or did not alert on the independent options path. */
export async function GET(req: Request) {
  const denied = requireApiToken(req);
  if (denied) return denied;
  ensureServerBoot();
  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") ?? "").trim().toUpperCase();
  if (!symbol) {
    return NextResponse.json({ ok: false, error: "symbol query param required" }, { status: 400 });
  }
  try {
    const { getDb } = await import("@/lib/db");
    const db = getDb();
    const explanation = explainTickerAlertDecision(db, symbol);
    return NextResponse.json({
      ok: true,
      symbol,
      explanation,
      context: {
        ownership: subscriberDiscordOwnershipSummary(),
        quota: quotaPolicySnapshot(),
        discoveryPaused: isDiscoveryPaused(),
        killSwitch: process.env.OPTIONS_CALLOUTS_KILL === "1",
      },
    });
  } catch (err: unknown) {
    return NextResponse.json({ ok: false, error: String((err as Error)?.message ?? err) }, { status: 500 });
  }
}
