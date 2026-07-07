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
    const { getNotificationSettings, getSetting, getSettingNum } = await import("@/lib/alert-store");
    const { enforceDiscordAutoSend } = await import("@/lib/notifications");
    enforceDiscordAutoSend();
    return NextResponse.json({
      ok: true,
      settings: getNotificationSettings(),
      languageMode: getSetting("language_mode") ?? "private",
      discordWebhookConfigured: discordConfigured(),
      scannerThresholds: {
        alertMinMomentumScore: getSettingNum("alert_min_momentum_score", Number(process.env.ALERT_MIN_MOMENTUM_SCORE ?? 62)),
        alertMinUnusualScore: getSettingNum("alert_min_unusual_score", Number(process.env.ALERT_MIN_UNUSUAL_SCORE ?? 80)),
        scannerMinRatePctMin: getSettingNum("scanner_min_rate_pct_min", Number(process.env.SCANNER_MIN_RATE_PCT_MIN ?? 0.18)),
        scannerMinVolSurge: getSettingNum("scanner_min_vol_surge", Number(process.env.SCANNER_MIN_VOL_SURGE ?? 1.4)),
        scannerMinAccel: getSettingNum("scanner_min_accel", Number(process.env.SCANNER_MIN_ACCEL ?? 0)),
        scannerMinEfficiency: getSettingNum("scanner_min_efficiency", Number(process.env.SCANNER_MIN_EFFICIENCY ?? 0.35)),
        scannerMinLevelSurge: getSettingNum("scanner_min_level_surge", Number(process.env.SCANNER_MIN_LEVEL_SURGE ?? 1.2)),
        stockMinScore: getSettingNum("stock_min_score", Number(process.env.STOCK_MIN_SCORE ?? 66)),
      },
      extendedStockNotify: getSetting("extended_stock_notify") === "1",
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  try {
    const body = await req.json();
    const { updateNotificationSettings, setSetting, getSetting, getSettingNum } = await import("@/lib/alert-store");
    if (typeof body.languageMode === "string" && ["private", "public"].includes(body.languageMode)) {
      setSetting("language_mode", body.languageMode);
    }
    if (body.alertMinMomentumScore != null) setSetting("alert_min_momentum_score", String(Number(body.alertMinMomentumScore)));
    if (body.alertMinUnusualScore != null) setSetting("alert_min_unusual_score", String(Number(body.alertMinUnusualScore)));
    if (body.scannerMinRatePctMin != null) setSetting("scanner_min_rate_pct_min", String(Number(body.scannerMinRatePctMin)));
    if (body.scannerMinVolSurge != null) setSetting("scanner_min_vol_surge", String(Number(body.scannerMinVolSurge)));
    if (body.scannerMinAccel != null) setSetting("scanner_min_accel", String(Number(body.scannerMinAccel)));
    if (body.scannerMinEfficiency != null) setSetting("scanner_min_efficiency", String(Number(body.scannerMinEfficiency)));
    if (body.scannerMinLevelSurge != null) setSetting("scanner_min_level_surge", String(Number(body.scannerMinLevelSurge)));
    if (body.stockMinScore != null) setSetting("stock_min_score", String(Number(body.stockMinScore)));
    if (typeof body.extendedStockNotify === "boolean") {
      setSetting("extended_stock_notify", body.extendedStockNotify ? "1" : "0");
    }
    const settings = updateNotificationSettings(body);
    if (body.discordRequiresManualConfirm === false || body.discordRequiresManualConfirm === 0) {
      const { enforceDiscordAutoSend } = await import("@/lib/notifications");
      enforceDiscordAutoSend();
    }
    return NextResponse.json({ ok: true, settings, languageMode: getSetting("language_mode") ?? "private", discordWebhookConfigured: discordConfigured(), scannerThresholds: {
        alertMinMomentumScore: getSettingNum("alert_min_momentum_score", Number(process.env.ALERT_MIN_MOMENTUM_SCORE ?? 62)),
        alertMinUnusualScore: getSettingNum("alert_min_unusual_score", Number(process.env.ALERT_MIN_UNUSUAL_SCORE ?? 80)),
        scannerMinRatePctMin: getSettingNum("scanner_min_rate_pct_min", Number(process.env.SCANNER_MIN_RATE_PCT_MIN ?? 0.18)),
        scannerMinVolSurge: getSettingNum("scanner_min_vol_surge", Number(process.env.SCANNER_MIN_VOL_SURGE ?? 1.4)),
        scannerMinAccel: getSettingNum("scanner_min_accel", Number(process.env.SCANNER_MIN_ACCEL ?? 0)),
        scannerMinEfficiency: getSettingNum("scanner_min_efficiency", Number(process.env.SCANNER_MIN_EFFICIENCY ?? 0.35)),
        scannerMinLevelSurge: getSettingNum("scanner_min_level_surge", Number(process.env.SCANNER_MIN_LEVEL_SURGE ?? 1.2)),
        stockMinScore: getSettingNum("stock_min_score", Number(process.env.STOCK_MIN_SCORE ?? 66)),
      },
      extendedStockNotify: getSetting("extended_stock_notify") === "1",
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message }, { status: 500 });
  }
}
