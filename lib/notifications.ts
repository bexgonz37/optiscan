/**
 * notifications.ts — channel abstraction for alert delivery.
 *
 * Discord product (DISCORD.md):
 *   - DISCORD_WEBHOOK_OPTIONS / STOCKS / RECAP (fallback DISCORD_WEBHOOK_URL)
 *   - BUY embeds with ?wait=true → store message id in notification_events.payload_json
 *   - PATCH same message at 5m/10m checkpoints (fire-and-forget from alert-tracker)
 *   - Quiet WATCH posts (no role mention), one per ticker per 30 min
 */

import {
  buildOptionsBuyEmbed,
  buildStockBuyEmbed,
  buildWatchEmbed,
  buildScoreboardEmbed,
  formatDiscordAlert,
} from "@/lib/alert-format";
import { containsBannedPublicLanguage } from "@/lib/language-modes";
import { isOptionsSession } from "@/lib/trading-session";
import {
  getNotificationSettings,
  insertNotificationEvent,
  getNotificationEvent,
  markNotificationEvent,
  discardAllPendingDiscord,
  updateNotificationSettings,
  getSetting,
  getSentDiscordForAlert,
  recentWatchDiscordForTicker,
  createDiscordDelivery,
  updateDiscordDelivery,
  getDiscordDelivery,
  retryableDiscordDeliveries,
} from "@/lib/alert-store";
import { actionableFreshness, type DataKind } from "@/lib/data-freshness";

export type DiscordWebhookKind = "options" | "stocks" | "recap" | "default";

const WATCH_DEDUP_MS = 30 * 60_000;
const LIVE_OPTIONS_MAX_AGE_MS = Number(process.env.DISCORD_OPTIONS_MAX_ALERT_AGE_MS ?? 90_000);

/** True when extended-hours stock notify is disabled (default). */
export function extendedStockNotifyEnabled(): boolean {
  return getSetting("extended_stock_notify") === "1";
}

function webhookEnv(kind: DiscordWebhookKind): string | undefined {
  if (kind === "options") return process.env.DISCORD_WEBHOOK_OPTIONS ?? process.env.DISCORD_WEBHOOK_URL;
  if (kind === "stocks") return process.env.DISCORD_WEBHOOK_STOCKS;
  if (kind === "recap") return process.env.DISCORD_WEBHOOK_RECAP;
  return process.env.DISCORD_WEBHOOK_URL;
}

export function discordWebhookConfigured(kind: DiscordWebhookKind): boolean {
  return Boolean(String(webhookEnv(kind) ?? "").trim());
}

/** True when any Discord webhook URL is set in env. */
export function discordConfigured(): boolean {
  return Boolean(
    String(process.env.DISCORD_WEBHOOK_URL ?? "").trim()
    || String(process.env.DISCORD_WEBHOOK_OPTIONS ?? "").trim()
    || String(process.env.DISCORD_WEBHOOK_STOCKS ?? "").trim()
    || String(process.env.DISCORD_WEBHOOK_RECAP ?? "").trim(),
  );
}

function dashboardUrl(): string {
  const base = String(process.env.PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "");
  return base ? `${base}/alerts` : "/alerts";
}

function isExtendedStockAlert(alertLike: any): boolean {
  const isStock = alertLike?.assetClass === "stock" || alertLike?.asset_class === "stock";
  if (!isStock) return false;
  const session = alertLike?.session;
  return session === "premarket" || session === "afterhours";
}

/** Clear stale manual-confirm queue when auto-send is on. */
export function ensureDiscordPendingCleared(): number {
  const s = getNotificationSettings();
  if (!s || s.discord_requires_manual_confirm) return 0;
  return discardAllPendingDiscord("superseded: auto-send enabled");
}

export function enforceDiscordAutoSend(): number {
  const s = getNotificationSettings();
  if (!s) return 0;
  if (s.discord_requires_manual_confirm) {
    updateNotificationSettings({ discordRequiresManualConfirm: false });
  }
  return discardAllPendingDiscord("superseded: auto-send enforced");
}

function webhookMessageUrl(webhookUrl: string, messageId: string): string {
  const base = webhookUrl.replace(/\?.*$/, "");
  return `${base}/messages/${messageId}`;
}

export async function postToDiscord(
  payload: Record<string, unknown>,
  { webhook = "default", skipPublicCheck = false }: { webhook?: DiscordWebhookKind; skipPublicCheck?: boolean } = {},
): Promise<{ messageId: string | null; webhookUrl: string; httpStatus: number; responseBodySafe: string | null }> {
  const url = webhookEnv(webhook);
  if (!url) throw new Error(`Discord webhook not set (${webhook})`);
  const serialized = JSON.stringify(payload);
  if (!skipPublicCheck && containsBannedPublicLanguage(serialized)) {
    throw new Error("blocked: payload failed public-language safety check");
  }
  const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}wait=true`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: serialized,
    signal: AbortSignal.timeout(12_000),
  });
  const bodyText = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`discord ${res.status}: ${bodyText.slice(0, 150)}`);
  let messageId: string | null = null;
  try {
    const body = bodyText ? JSON.parse(bodyText) : null;
    messageId = body?.id != null ? String(body.id) : null;
  } catch { /* some webhooks return empty with wait=true */ }
  return { messageId, webhookUrl: url, httpStatus: res.status, responseBodySafe: bodyText.slice(0, 500) || null };
}

function nextRetryIso(retryCount: number): string {
  const delayMs = Math.min(15 * 60_000, 30_000 * (2 ** Math.max(0, retryCount)));
  return new Date(Date.now() + delayMs).toISOString();
}

async function sendTrackedDiscord(input: {
  alertId?: number | null;
  payload: any;
  webhook: DiscordWebhookKind;
  payloadType: string;
  idempotencyKey?: string | null;
}) {
  const deliveryId = createDiscordDelivery({
    alertId: input.alertId ?? null,
    channelType: "discord_webhook",
    webhookName: input.webhook,
    payloadType: input.payloadType,
    payload: input.payload,
    idempotencyKey: input.idempotencyKey ?? null,
  });
  updateDiscordDelivery(deliveryId, { status: "SENDING", attempted: true });
  try {
    const res = await postToDiscord(input.payload, { webhook: input.webhook, skipPublicCheck: true });
    updateDiscordDelivery(deliveryId, {
      status: "SENT",
      httpStatus: res.httpStatus,
      responseBodySafe: res.responseBodySafe,
      sent: true,
      nextRetryAt: null,
    });
    return { ...res, deliveryId };
  } catch (err: any) {
    const current = getDiscordDelivery(deliveryId);
    const retryCount = Number(current?.retry_count ?? 0) + 1;
    updateDiscordDelivery(deliveryId, {
      status: retryCount < 3 ? "RETRYING" : "FAILED",
      failureReason: err?.message ?? String(err),
      retryCountDelta: 1,
      nextRetryAt: retryCount < 3 ? nextRetryIso(retryCount) : null,
    });
    throw err;
  }
}

export async function editDiscordMessage(
  webhookUrl: string,
  messageId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(webhookMessageUrl(webhookUrl, messageId), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`discord patch ${res.status}: ${(await res.text().catch(() => "")).slice(0, 150)}`);
}

function buildBuyPayload(alertLike: any, languageMode: string) {
  const isStock = alertLike?.assetClass === "stock" || alertLike?.asset_class === "stock";
  if (isStock) return buildStockBuyEmbed(alertLike);
  if (languageMode === "private" || alertLike?.captureAction === "TRADE" || alertLike?.capture_action === "TRADE") {
    return buildOptionsBuyEmbed(alertLike);
  }
  return formatDiscordAlert(alertLike, { languageMode });
}

/** Fire-and-forget result edit for a sent BUY message. */
export function scheduleDiscordResultEdit(
  alertId: number,
  checkpoint: "5m" | "10m",
  data: { mid?: number | null; returnPct?: number | null; paid?: boolean; paidInMin?: number | null },
): void {
  void patchDiscordResultForAlert(alertId, checkpoint, data).catch(() => {});
}

async function patchDiscordResultForAlert(
  alertId: number,
  checkpoint: "5m" | "10m",
  data: { mid?: number | null; returnPct?: number | null; paid?: boolean; paidInMin?: number | null },
): Promise<void> {
  const sent = getSentDiscordForAlert(alertId);
  if (!sent?.payload_json) return;
  let stored: any;
  try { stored = JSON.parse(sent.payload_json); } catch { return; }
  const webhookUrl = stored.webhookUrl ?? stored.webhook;
  const messageId = stored.messageId ?? stored.message_id;
  const basePayload = stored.payload ?? stored.embedPayload;
  if (!webhookUrl || !messageId || !basePayload) return;

  const fmt: any = await import("@/lib/alert-format");
  let patchPayload = basePayload;
  if (checkpoint === "5m") {
    patchPayload = fmt.patchDiscordResultEmbed(basePayload, {
      fieldName: "5 min",
      fieldValue: fmt.formatResultField5m({ mid: data.mid, returnPct: data.returnPct, running: true }),
    });
  } else {
    patchPayload = fmt.patchDiscordResultEmbed(basePayload, {
      fieldName: "Result",
      fieldValue: fmt.formatResultFieldFinal({
        returnPct: data.returnPct,
        paid: Boolean(data.paid),
        paidInMin: data.paidInMin,
        neverPaid: !data.paid,
      }),
      final: true,
      paid: Boolean(data.paid),
    });
  }
  await editDiscordMessage(webhookUrl, messageId, patchPayload);
}

/** Post daily or weekly scoreboard to recap webhook. */
export async function postScoreboardEmbed(
  stats: Record<string, unknown>,
  rows: { emoji?: string; label: string; value: string }[],
  { weekly = false }: { weekly?: boolean } = {},
): Promise<{ ok: boolean; error?: string }> {
  if (!discordConfigured()) return { ok: false, error: "no webhook configured" };
  const { payload, safe } = buildScoreboardEmbed(stats, rows, { weekly, dashboardUrl: dashboardUrl() });
  if (!safe) return { ok: false, error: "scoreboard failed language guard" };
  try {
    await postToDiscord(payload, { webhook: "recap", skipPublicCheck: true });
    insertNotificationEvent({
      alertId: null,
      channel: "discord_webhook",
      status: "sent",
      payloadJson: JSON.stringify({ kind: weekly ? "weekly_scoreboard" : "daily_scoreboard" }),
      sentAt: new Date().toISOString(),
    });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/** Quiet WATCH post — no role mention, 30 min dedup per ticker. */
export async function notifyWatchAlert(alertId: number, alertLike: any): Promise<void> {
  try {
    const s = getNotificationSettings();
    if (!s?.discord_enabled) return;
    if (!isOptionsSession()) return;
    const ticker = alertLike?.ticker;
    if (ticker && recentWatchDiscordForTicker(ticker, WATCH_DEDUP_MS)) return;
    if (!discordConfigured()) return;
    const { payload, safe } = buildWatchEmbed(alertLike);
    if (!safe) return;
    const { messageId, webhookUrl } = await postToDiscord(payload, { webhook: "options", skipPublicCheck: true });
    insertNotificationEvent({
      alertId,
      channel: "discord_webhook",
      status: "sent",
      payloadJson: JSON.stringify({ kind: "watch", payload, messageId, webhookUrl, ticker }),
      sentAt: new Date().toISOString(),
    });
  } catch { /* never throw into capture path */ }
}

/** Called after a new alert is persisted. Never throws. */
export async function notifyNewAlert(alertId: number, alertLike: any): Promise<void> {
  try {
    const s = getNotificationSettings();
    if (!s?.discord_enabled) {
      insertNotificationEvent({ alertId, channel: "discord_webhook", status: "skipped", error: "discord disabled" });
      return;
    }
    const isStock = alertLike?.assetClass === "stock" || alertLike?.asset_class === "stock";
    if (isStock) {
      if (!extendedStockNotifyEnabled() && isExtendedStockAlert(alertLike)) {
        insertNotificationEvent({
          alertId, channel: "discord_webhook", status: "skipped",
          error: "extended stock notify disabled in settings",
        });
        return;
      }
      if (process.env.STOCK_CALLOUTS !== "1") {
        insertNotificationEvent({
          alertId, channel: "discord_webhook", status: "skipped", error: "STOCK_CALLOUTS not enabled",
        });
        return;
      }
    } else if (!isOptionsSession()) {
      insertNotificationEvent({
        alertId, channel: "discord_webhook", status: "skipped",
        error: "0DTE options notifications only fire during regular hours (9:30–16:00 ET)",
      });
      return;
    } else if (LIVE_OPTIONS_MAX_AGE_MS > 0) {
      const rawAlertTime = alertLike?.alertTime ?? alertLike?.alert_time;
      const alertMs = rawAlertTime ? Date.parse(String(rawAlertTime)) : Date.now();
      if (Number.isFinite(alertMs) && Date.now() - alertMs > LIVE_OPTIONS_MAX_AGE_MS) {
        insertNotificationEvent({
          alertId,
          channel: "discord_webhook",
          status: "skipped",
          error: `options alert too old for live Discord (${Math.round((Date.now() - alertMs) / 1000)}s)`,
        });
        return;
      }
    }

    const languageMode = getSetting("language_mode") === "public" ? "public" : "private";
    const built = buildBuyPayload(alertLike, languageMode);
    const payload: any = "payload" in built ? built.payload : { content: built.content };
    // Quant enrichment (2026-07-09): compact historical-edge line on every BUY
    // payload — statistics only, never directives (passes the public-language
    // guard); a quant failure must never block the send.
    try {
      if (alertId != null) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { scoreAlert } = require("@/lib/quant");
        const q = scoreAlert(Number(alertId));
        if (q?.grade) {
          const wr = q.historicalWinRate != null ? `${Math.round(q.historicalWinRate)}% win` : "win n/a";
          const ex = q.expectancy != null ? `${q.expectancy > 0 ? "+" : ""}${Number(q.expectancy).toFixed(1)}% expectancy` : "expectancy n/a";
          const line = `\ud83d\udcca Setup ${q.grade} \u00b7 ${wr} \u00b7 ${ex} \u00b7 conf ${q.confidenceScore != null ? q.confidenceScore : "?"}/100 \u2014 historical stats, not advice`;
          if (typeof payload.content === "string" && payload.content) payload.content += `\n${line}`;
          else if (Array.isArray(payload.embeds) && payload.embeds[0]) {
            payload.embeds[0].description = `${payload.embeds[0].description ?? ""}\n${line}`.trim();
          }
        }
      }
    } catch { /* quant enrichment is optional */ }
    const safe = built.safe !== false;
    if (!safe) {
      createDiscordDelivery({
        alertId,
        channelType: "discord_webhook",
        webhookName: isStock ? "stocks" : "options",
        payloadType: isStock ? "stock_buy" : "options_buy",
        payload,
        status: "SUPPRESSED",
        failureReason: "unsafe wording blocked",
      });
      insertNotificationEvent({
        alertId, channel: "discord_webhook", status: "failed", error: "unsafe wording blocked",
        payloadJson: JSON.stringify(payload),
      });
      return;
    }
    if (s.discord_requires_manual_confirm) {
      insertNotificationEvent({
        alertId, channel: "discord_webhook", status: "pending_confirm",
        payloadJson: JSON.stringify({ payload, skipPublicCheck: true, webhook: isStock ? "stocks" : "options" }),
      });
      return;
    }
    const webhook: DiscordWebhookKind = isStock ? "stocks" : "options";
    if (!discordWebhookConfigured(webhook)) {
      createDiscordDelivery({
        alertId,
        channelType: "discord_webhook",
        webhookName: webhook,
        payloadType: isStock ? "stock_buy" : "options_buy",
        payload,
        status: "NOT_CONFIGURED",
        failureReason: `Discord ${webhook} webhook not set`,
      });
      insertNotificationEvent({
        alertId,
        channel: "discord_webhook",
        status: "failed",
        error: `Discord ${webhook} webhook not set`,
      });
      return;
    }
    const requiredKinds: DataKind[] = isStock
      ? ["stock_quote"]
      : ["stock_quote", "options_chain", "options_quote", "greeks"];
    const freshness = actionableFreshness(String(alertLike?.ticker ?? ""), requiredKinds);
    if (!freshness.ok) {
      createDiscordDelivery({
        alertId,
        channelType: "discord_webhook",
        webhookName: webhook,
        payloadType: isStock ? "stock_buy" : "options_buy",
        payload,
        status: "SUPPRESSED",
        failureReason: `data freshness blocked actionable alert: ${freshness.reason}`,
      });
      insertNotificationEvent({
        alertId,
        channel: "discord_webhook",
        status: "skipped",
        error: `data freshness blocked actionable alert: ${freshness.reason}`,
        payloadJson: JSON.stringify({ payload, freshness }),
      });
      return;
    }
    const { messageId, webhookUrl } = await sendTrackedDiscord({
      alertId,
      payload,
      webhook,
      payloadType: isStock ? "stock_buy" : "options_buy",
      idempotencyKey: `${alertId}:${webhook}:buy`,
    });
    insertNotificationEvent({
      alertId,
      channel: "discord_webhook",
      status: "sent",
      payloadJson: JSON.stringify({ payload, messageId, webhookUrl, kind: isStock ? "stock_buy" : "options_buy" }),
      sentAt: new Date().toISOString(),
    });
  } catch (err: any) {
    try {
      insertNotificationEvent({ alertId, channel: "discord_webhook", status: "failed", error: err?.message ?? String(err) });
    } catch { /* never break the scanner */ }
  }
}

export async function confirmAndSendPending(eventId: number): Promise<{ ok: boolean; error?: string }> {
  const e = getNotificationEvent(eventId);
  if (!e) return { ok: false, error: "event not found" };
  if (e.status !== "pending_confirm") return { ok: false, error: `event is '${e.status}', not pending_confirm` };
  const s = getNotificationSettings();
  if (!s?.discord_enabled) return { ok: false, error: "discord disabled in settings" };
  let parsed: any = {};
  try { parsed = JSON.parse(e.payload_json ?? "{}"); } catch { /* */ }
  const payload = parsed.payload ?? { content: parsed.content ?? "" };
  const webhook = (parsed.webhook ?? "default") as DiscordWebhookKind;
  if (!payload || (!payload.content && !payload.embeds)) return { ok: false, error: "empty payload" };
  try {
    const { messageId, webhookUrl } = await sendTrackedDiscord({
      alertId: e.alert_id,
      payload,
      webhook,
      payloadType: "manual_confirm",
      idempotencyKey: `event:${eventId}:${webhook}`,
    });
    markNotificationEvent(eventId, "sent");
    insertNotificationEvent({
      alertId: e.alert_id,
      channel: "discord_webhook",
      status: "sent",
      payloadJson: JSON.stringify({ ...parsed, messageId, webhookUrl }),
      sentAt: new Date().toISOString(),
    });
    return { ok: true };
  } catch (err: any) {
    markNotificationEvent(eventId, "failed", err?.message);
    return { ok: false, error: err?.message };
  }
}

export async function sendDiscordTest(kind: "options" | "stocks" = "options"): Promise<{ ok: boolean; error?: string }> {
  const s = getNotificationSettings();
  if (!s?.discord_enabled) return { ok: false, error: "Enable Discord in settings first." };
  if (!discordWebhookConfigured(kind)) return { ok: false, error: `Discord ${kind} webhook is not set in .env.local.` };
  try {
    const payload = {
      content: `OptiScan ${kind} test: research scanner alert channel is connected. Not financial advice.`,
    };
    await sendTrackedDiscord({
      alertId: null,
      payload,
      webhook: kind,
      payloadType: "test",
      idempotencyKey: `test:${kind}:${new Date().toISOString().slice(0, 13)}`,
    });
    insertNotificationEvent({
      alertId: null, channel: "discord_webhook", status: "sent",
      payloadJson: JSON.stringify({ test: true, kind }), sentAt: new Date().toISOString(),
    });
    return { ok: true };
  } catch (err: any) {
    insertNotificationEvent({ alertId: null, channel: "discord_webhook", status: "failed", error: err?.message });
    return { ok: false, error: err?.message };
  }
}

export async function retryDiscordDelivery(deliveryId: string): Promise<{ ok: boolean; error?: string }> {
  const d = getDiscordDelivery(deliveryId);
  if (!d) return { ok: false, error: "delivery not found" };
  if (!d.payload_json) return { ok: false, error: "delivery has no stored payload" };
  let payload: any;
  try { payload = JSON.parse(d.payload_json); } catch { return { ok: false, error: "stored payload is invalid JSON" }; }
  updateDiscordDelivery(deliveryId, { status: "SENDING", attempted: true });
  try {
    const res = await postToDiscord(payload, { webhook: d.webhook_name as DiscordWebhookKind, skipPublicCheck: true });
    updateDiscordDelivery(deliveryId, {
      status: "SENT",
      httpStatus: res.httpStatus,
      responseBodySafe: res.responseBodySafe,
      sent: true,
      nextRetryAt: null,
    });
    return { ok: true };
  } catch (err: any) {
    const retryCount = Number(d.retry_count ?? 0) + 1;
    updateDiscordDelivery(deliveryId, {
      status: retryCount < 3 ? "RETRYING" : "FAILED",
      failureReason: err?.message ?? String(err),
      retryCountDelta: 1,
      nextRetryAt: retryCount < 3 ? nextRetryIso(retryCount) : null,
    });
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export async function retryFailedDiscordDeliveries(limit = 25) {
  const rows = retryableDiscordDeliveries(limit);
  const results = [];
  for (const row of rows) results.push({ deliveryId: row.delivery_id, ...(await retryDiscordDelivery(row.delivery_id)) });
  return { attempted: results.length, results };
}
