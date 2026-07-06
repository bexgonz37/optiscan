import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { discordConfigured } from "@/lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET/PATCH notification settings. The Discord webhook URL itself is NEVER
 * returned — only a boolean saying whether the env var is configured. */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  try {
    const { getNotificationSettings, getSetting } = await import("@/lib/alert-store");
    return NextResponse.json({
      ok: true,
      settings: getNotificationSettings(),
      languageMode: getSetting("language_mode") ?? "private",
      discordWebhookConfigured: discordConfigured(),
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  try {
    const body = await req.json();
    const { updateNotificationSettings, setSetting, getSetting } = await import("@/lib/alert-store");
    if (typeof body.languageMode === "string" && ["private", "public"].includes(body.languageMode)) {
      setSetting("language_mode", body.languageMode);
    }
    if (body.alertMinMomentumScore != null) setSetting("alert_min_momentum_score", String(Number(body.alertMinMomentumScore)));
    if (body.alertMinUnusualScore != null) setSetting("alert_min_unusual_score", String(Number(body.alertMinUnusualScore)));
    const settings = updateNotificationSettings(body);
    if (body.discordRequiresManualConfirm === false || body.discordRequiresManualConfirm === 0) {
      const { ensureDiscordPendingCleared } = await import("@/lib/notifications");
      ensureDiscordPendingCleared();
    }
    return NextResponse.json({ ok: true, settings, languageMode: getSetting("language_mode") ?? "private", discordWebhookConfigured: discordConfigured() });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message }, { status: 500 });
  }
}
