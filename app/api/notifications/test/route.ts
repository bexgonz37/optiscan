import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { formatPrivatePopup, formatPublicAlert, formatDiscordAlert } from "@/lib/alert-format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAMPLE = {
  ticker: "TEST", direction: "bullish", optionSide: "call",
  setupScore: 87, riskScore: 42, liquidityScore: 81,
  catalystType: "earnings", catalystQuality: "strong",
  movePct: 7.8, relVol: 4.2, strike: 100, expiration: "2026-08-21", delta: 0.42,
  optionSymbol: "O:TEST260821C00100000",
  explanation: "Sample explanation for a popup test.",
  publicExplanation: "Sample educational scanner note. Not financial advice.",
};

/** POST /api/notifications/test — render all channel payloads for a sample
 * alert and log a popup event; the UI uses this to preview/test channels. */
export async function POST(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  try {
    const { logPopupEvent, insertNotificationEvent } = await import("@/lib/alert-store");
    logPopupEvent(null, "TEST", "shown");
    insertNotificationEvent({ alertId: null, channel: "browser_popup", status: "sent", payloadJson: JSON.stringify({ test: true }), sentAt: new Date().toISOString() });
    return NextResponse.json({
      ok: true,
      privatePopup: formatPrivatePopup(SAMPLE),
      publicAlert: formatPublicAlert(SAMPLE),
      discordPreview: formatDiscordAlert(SAMPLE),
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message }, { status: 500 });
  }
}
