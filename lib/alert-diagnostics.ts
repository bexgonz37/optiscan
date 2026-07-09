import { getDb } from "@/lib/db";
import { discordWebhookConfigured, extendedStockNotifyEnabled } from "@/lib/notifications";
import { loopState } from "@/lib/scanner-loop";
import { marketSession } from "@/lib/trading-session";

export function alertDiagnostics(nowMs = Date.now()) {
  const db = getDb();
  const sinceIso = new Date(nowMs - 6 * 3600_000).toISOString();
  const dayIso = new Date(nowMs - 24 * 3600_000).toISOString();
  const alerts = db.prepare(
    `SELECT asset_class, session, capture_action, COUNT(*) AS count
     FROM alerts WHERE alert_time >= ?
     GROUP BY asset_class, session, capture_action
     ORDER BY count DESC`,
  ).all(sinceIso) as any[];
  const notifications = db.prepare(
    `SELECT status, COALESCE(error,'') AS error, COUNT(*) AS count
     FROM notification_events
     WHERE channel='discord_webhook' AND created_at >= ?
     GROUP BY status, error
     ORDER BY count DESC LIMIT 12`,
  ).all(dayIso) as any[];
  const recentSkipped = db.prepare(
    `SELECT n.status, n.error, n.created_at, a.ticker, a.asset_class, a.session, a.capture_action
     FROM notification_events n
     LEFT JOIN alerts a ON a.id=n.alert_id
     WHERE n.channel='discord_webhook' AND n.status IN ('failed','skipped','pending_confirm')
     ORDER BY n.id DESC LIMIT 8`,
  ).all() as any[];
  const loop = loopState();
  return {
    session: marketSession(nowMs),
    webhooks: {
      options: discordWebhookConfigured("options"),
      stocks: discordWebhookConfigured("stocks"),
      recap: discordWebhookConfigured("recap"),
    },
    extendedStockNotify: extendedStockNotifyEnabled(),
    loop: {
      running: loop.running,
      intervalMs: loop.intervalMs,
      lastTickAt: loop.lastTickAt,
      triggers: loop.triggers,
      alerts: loop.alerts,
      errors: loop.errors,
      note: loop.note,
      nearMisses: loop.nearMisses?.slice(0, 8) ?? [],
    },
    alerts,
    notifications,
    recentSkipped,
  };
}
