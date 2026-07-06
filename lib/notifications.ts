/**
 * notifications.ts — channel abstraction for alert delivery.
 *
 * Channels: browser_popup, browser_desktop_notification, sound_alert
 * (all three are CLIENT-side — the AlertPopup component polls for new alerts
 * and renders/plays them per notification_settings), discord_webhook
 * (server-side, below), email_later / sms_later (placeholders, not wired).
 *
 * Discord rules (enforced here, not just documented):
 *   - ON by default (discord_enabled=1); requires DISCORD_WEBHOOK_URL in env
 *   - Auto-send TRADE alerts (no manual confirm by default)
 *   - webhook URL lives ONLY in env — never sent to the frontend
 *   - private mode uses direct BUY CALL/PUT wording; public mode is education-safe
 */

import { formatDiscordAlert } from "@/lib/alert-format";
import { containsBannedPublicLanguage } from "@/lib/language-modes";
import {
  getNotificationSettings,
  insertNotificationEvent,
  getNotificationEvent,
  markNotificationEvent,
  getSetting,
} from "@/lib/alert-store";

export function discordConfigured(): boolean {
  return Boolean(process.env.DISCORD_WEBHOOK_URL);
}

async function postToDiscord(content: string, { skipPublicCheck = false } = {}): Promise<void> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) throw new Error("DISCORD_WEBHOOK_URL not set");
  if (!skipPublicCheck && containsBannedPublicLanguage(content)) {
    throw new Error("blocked: payload failed public-language safety check");
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`discord ${res.status}: ${(await res.text().catch(() => "")).slice(0, 150)}`);
}

/** Called after a new alert is persisted. Handles the server-side channel
 * (Discord); browser channels pick the alert up via polling. Never throws. */
export async function notifyNewAlert(alertId: number, alertLike: any): Promise<void> {
  try {
    const s = getNotificationSettings();
    if (!s?.discord_enabled) {
      insertNotificationEvent({ alertId, channel: "discord_webhook", status: "skipped", error: "discord disabled" });
      return;
    }
    const languageMode = getSetting("language_mode") === "public" ? "public" : "private";
    const { content, safe } = formatDiscordAlert(alertLike, { languageMode });
    if (!safe) {
      insertNotificationEvent({ alertId, channel: "discord_webhook", status: "failed", error: "unsafe wording blocked", payloadJson: JSON.stringify({ content }) });
      return;
    }
    if (s.discord_requires_manual_confirm) {
      insertNotificationEvent({
        alertId,
        channel: "discord_webhook",
        status: "pending_confirm",
        payloadJson: JSON.stringify({ content, skipPublicCheck: languageMode === "private" }),
      });
      return;
    }
    if (!discordConfigured()) {
      insertNotificationEvent({ alertId, channel: "discord_webhook", status: "failed", error: "DISCORD_WEBHOOK_URL not set" });
      return;
    }
    await postToDiscord(content, { skipPublicCheck: languageMode === "private" });
    insertNotificationEvent({ alertId, channel: "discord_webhook", status: "sent", payloadJson: JSON.stringify({ content }), sentAt: new Date().toISOString() });
  } catch (err: any) {
    try {
      insertNotificationEvent({ alertId, channel: "discord_webhook", status: "failed", error: err?.message ?? String(err) });
    } catch { /* never break the scanner over notification bookkeeping */ }
  }
}

/** Send a queued pending_confirm event (manual confirmation flow). */
export async function confirmAndSendPending(eventId: number): Promise<{ ok: boolean; error?: string }> {
  const e = getNotificationEvent(eventId);
  if (!e) return { ok: false, error: "event not found" };
  if (e.status !== "pending_confirm") return { ok: false, error: `event is '${e.status}', not pending_confirm` };
  const s = getNotificationSettings();
  if (!s?.discord_enabled) return { ok: false, error: "discord disabled in settings" };
  const content = (() => { try { return JSON.parse(e.payload_json ?? "{}").content ?? ""; } catch { return ""; } })();
  const skipPublicCheck = (() => { try { return Boolean(JSON.parse(e.payload_json ?? "{}").skipPublicCheck); } catch { return false; } })();
  if (!content) return { ok: false, error: "empty payload" };
  try {
    await postToDiscord(content, { skipPublicCheck });
    markNotificationEvent(eventId, "sent");
    return { ok: true };
  } catch (err: any) {
    markNotificationEvent(eventId, "failed", err?.message);
    return { ok: false, error: err?.message };
  }
}

/** Test helper for POST /api/notifications/discord/test. */
export async function sendDiscordTest(): Promise<{ ok: boolean; error?: string }> {
  const s = getNotificationSettings();
  if (!s?.discord_enabled) return { ok: false, error: "Enable Discord in settings first (it is off by default)." };
  if (!discordConfigured()) return { ok: false, error: "DISCORD_WEBHOOK_URL is not set in .env.local." };
  try {
    await postToDiscord("OptiScan test: educational scanner alert channel is connected. Not financial advice.");
    insertNotificationEvent({ alertId: null, channel: "discord_webhook", status: "sent", payloadJson: JSON.stringify({ test: true }), sentAt: new Date().toISOString() });
    return { ok: true };
  } catch (err: any) {
    insertNotificationEvent({ alertId: null, channel: "discord_webhook", status: "failed", error: err?.message });
    return { ok: false, error: err?.message };
  }
}
