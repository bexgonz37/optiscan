/**
 * Owner-only Discord research notifications.
 * Research, planning, and content summaries route to Recaps; actionable candidates route to Alerts.
 * Gated by OWNER_RESEARCH_DISCORD_ENABLED=1 (default off).
 */
import { tradingDay } from "../trading-session.ts";
import type { OvernightPlan, OvernightRecommendation } from "../research/overnight/next-session-plan.ts";
import { resolveOperatingMode } from "../dashboard/operating-mode.ts";
import type { DiscordWebhookKind } from "../notifications.ts";
import { formatPrivateLiveAlert } from "../research/options/format.ts";

export type OwnerResearchNotifyKind =
  | "next_session_watchlist"
  | "premarket_watchlist_update"
  | "market_open_revalidation"
  | "eod_watchlist"
  | "evening_delta"
  | "premarket_plan"
  | "market_open_confirm"
  | "intraday_actionable"
  | "watchlist_followup"
  | "almost_ready"
  | "blocked_candidate"
  | "research_only_bearish"
  | "missed_opportunity"
  | "shadow_insight";

export interface OwnerNotifyResult {
  sent: boolean;
  skipped: boolean;
  reason: string;
  kind: OwnerResearchNotifyKind;
  content?: string;
  messageId?: string | null;
  deliveryId?: string | null;
}

function enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OWNER_RESEARCH_DISCORD_ENABLED === "1";
}

export function ownerResearchIntradayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OWNER_RESEARCH_DISCORD_ENABLED === "1" && env.OWNER_RESEARCH_INTRADAY_ENABLED === "1";
}

/**
 * Presentation-only: stop OWNER WATCH research observations from reaching the
 * actionable Alerts channel.
 *
 * An owner opening that is NOT subscriber-approved is a research observation, not
 * a trade notification, but it renders into the same channel as a real callout —
 * on 2026-08-19 the owner received five of them ("🔬 … OWNER WATCH … NOT
 * SUBSCRIBER-APPROVED") and no actionable callout at all, which makes the channel
 * useless as a signal.
 *
 * This suppresses the Discord POST ONLY. The delivery is still written to the
 * ledger as SUPPRESSED, the opportunity-case opening claim is still held, the
 * owner-mirror linkage still resolves, and PRE_MOVE_DISCOVERY_V2 still captures —
 * because the send result is still reported as delivered to the caller. No gate,
 * threshold, ranking weight or contract rule is touched, and a subscriber-grade
 * callout never reaches this path.
 *
 * Default OFF, so this is inert until the owner sets it.
 */
export function ownerWatchDiscordSuppressed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OWNER_WATCH_DISCORD_SUPPRESSED === "1";
}

export function ownerNotifyDestinationForKind(kind: OwnerResearchNotifyKind): {
  webhook: DiscordWebhookKind;
  requiredEnv: string;
  label: string;
} {
  if (kind === "intraday_actionable") {
    return { webhook: "options", requiredEnv: "DISCORD_WEBHOOK_OPTIONS", label: "alerts" };
  }
  if (
    kind === "next_session_watchlist"
    || kind === "premarket_watchlist_update"
    || kind === "market_open_revalidation"
    || kind === "eod_watchlist"
    || kind === "evening_delta"
    || kind === "premarket_plan"
    || kind === "market_open_confirm"
    || kind === "watchlist_followup"
  ) {
    return { webhook: "watchlist", requiredEnv: "DISCORD_WEBHOOK_WATCHLIST", label: "watchlist" };
  }
  return { webhook: "recap", requiredEnv: "DISCORD_WEBHOOK_RECAP", label: "recap" };
}

function webhookConfiguredForDestination(kind: OwnerResearchNotifyKind, env: NodeJS.ProcessEnv): boolean {
  const destination = ownerNotifyDestinationForKind(kind);
  if (destination.webhook === "options") return Boolean(String(env.DISCORD_WEBHOOK_OPTIONS ?? env.DISCORD_WEBHOOK_URL ?? "").trim());
  if (destination.webhook === "watchlist") return Boolean(String(env.DISCORD_WEBHOOK_WATCHLIST ?? "").trim());
  if (destination.webhook === "recap") return Boolean(String(env.DISCORD_WEBHOOK_RECAP ?? "").trim());
  return false;
}

function recapClassification(kind: OwnerResearchNotifyKind): string {
  if (kind === "almost_ready") return "ALMOST READY";
  if (kind === "blocked_candidate") return "BLOCKED";
  if (kind === "missed_opportunity") return "MISSED OPPORTUNITY";
  if (kind === "research_only_bearish" || kind === "shadow_insight") return "RESEARCH";
  return "WATCHLIST";
}

function normalizeRecapContent(kind: OwnerResearchNotifyKind, content: string): { ok: true; content: string } | { ok: false; reason: string } {
  if (kind === "intraday_actionable") return { ok: true, content };
  if (/\b(TRADE NOW|BEARISH TRADE CANDIDATE|VERIFIED OPTIONS ALERT)\b|live entry/i.test(content)) {
    return { ok: false, reason: "blocked live-alert language in recap message" };
  }
  const label = recapClassification(kind);
  const head = content.slice(0, 240).toUpperCase();
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hasExplicitHeader = new RegExp(`^(?:\\*\\*${escapedLabel}\\*\\*|${escapedLabel}(?:\\s+—|\\s+-|:))`).test(head);
  if (hasExplicitHeader || head.includes("CONTENT DRAFT") || head.includes("DAILY RECAP")) {
    return { ok: true, content };
  }
  return {
    ok: true,
    content: `**${label}**\n_Not executable. Verify at open before any live options SEND path._\n\n${content}`,
  };
}

function normalizeWatchlistContent(content: string): { ok: true; content: string } | { ok: false; reason: string } {
  if (/\b(TRADE NOW|BEARISH TRADE CANDIDATE|VERIFIED OPTIONS ALERT)\b|live entry/i.test(content)) {
    return { ok: false, reason: "blocked live-alert language in watchlist message" };
  }
  return { ok: true, content };
}

function formatRecLegacy(r: OvernightRecommendation): string {
  const bias = r.bias.toUpperCase();
  const trigger = r.triggerLevel != null ? String(r.triggerLevel) : "TBD at open";
  const inv = r.invalidationLevel != null ? String(r.invalidationLevel) : "TBD";
  return [
    `**#${r.rank} ${r.symbol}** · ${bias} · ${r.setupFamily}`,
    `Trigger: ${trigger} · Invalidation: ${inv}`,
    `DTE ${r.preferredDteRange} · ${r.preferredMoneyness} · conf ${r.confidence}`,
    `Guidance: ${r.contractSelectionGuidance}`,
    `Risk: ${r.mainRisk}`,
    `⚠️ VERIFY CONTRACT AFTER OPTIONS OPEN · quotes STALE · PRIOR SESSION`,
  ].join("\n");
}

function formatEodWatchlistLegacy(plan: OvernightPlan): string {
  const lines = [
    `📋 **WATCHLIST — next session** · ${plan.tradingDay}`,
    `_Research only — not executable. Do not buy after hours._`,
    plan.marketContext.spyNote,
    plan.marketContext.qqqNote,
    "",
    ...plan.recommendations.slice(0, 8).map(formatRec),
    "",
    `Plan ${plan.planVersion}`,
  ];
  return lines.join("\n");
}

function formatEveningDeltaLegacy(plan: OvernightPlan, reasons: string[]): string {
  return [
    `🔄 **WATCHLIST — evening delta** · ${plan.tradingDay}`,
    `_Plan changed: ${reasons.slice(0, 6).join("; ")}_`,
    `_Research only — not a buy signal._`,
    "",
    ...plan.recommendations.slice(0, 6).map(formatRec),
  ].join("\n");
}

function formatPremarketPlanLegacy(plan: OvernightPlan): string {
  return [
    `🌅 **WATCHLIST — premarket plan** · ${plan.tradingDay}`,
    `_Not executable — VERIFY CONTRACT AFTER OPTIONS OPEN_`,
    "",
    ...plan.recommendations.slice(0, 8).map(formatRec),
  ].join("\n");
}

function formatMarketOpenConfirmLegacy(plan: OvernightPlan): string {
  return [
    `🔔 **WATCHLIST — market-open revalidation** · ${plan.tradingDay}`,
    `_Not executable. Do not use prior-session quotes. Confirm fresh bid/ask before any live options SEND path._`,
    "",
    ...plan.recommendations.slice(0, 8).map((r) =>
      `#${r.rank} ${r.symbol} · ${r.bias} · trigger ${r.triggerLevel ?? "TBD"} · ${r.preferredDteRange} ${r.preferredMoneyness}`
    ),
  ].join("\n");
}

/**
 * One watchlist row, structured so today's evidence and tomorrow's requirement
 * are never mixed into the same sentence:
 *
 *   Today       — what the session actually did, signed, plus VWAP position
 *   Why watched — the plain-English thesis
 *   Needs       — what must happen AFTER the open before anything is actionable
 *   Invalid if  — what kills it
 *   Careful     — extension / premium-chase warning
 *   Missing     — catalyst status and absent evidence
 *
 * No internal setup family, no numeric confidence, no raw pipeline vocabulary.
 */
function formatRec(r: OvernightRecommendation): string {
  const direction = r.bias === "bearish" ? "PUT" : "CALL";
  const trigger = r.triggerText ?? (r.triggerLevel != null ? `$${r.triggerLevel.toFixed(2)}` : "Unavailable");
  const invalidation = r.invalidationText ?? (r.invalidationLevel != null ? `$${r.invalidationLevel.toFixed(2)}` : "Unavailable");
  const today = [r.sessionSummary, r.vwapPosition].filter(Boolean).join(" ");
  const lines = [`#${r.rank} ${r.symbol} — ${direction} watch`];
  // Lifecycle status (WATCH / ALMOST READY / INVALIDATED) is reader-facing
  // state, not internal pipeline vocabulary, so it stays.
  lines.push(`Status: ${r.status ?? "WATCH"}`);
  if (today) lines.push(`Today: ${today}`);
  if (r.thesis && r.thesis !== r.sessionSummary) lines.push(`Why watched: ${r.thesis}`);
  lines.push(`Needs after the open: ${trigger}`);
  lines.push(`Invalid if: ${invalidation}`);
  lines.push(`Careful: ${r.mainRisk}`);
  lines.push(`Catalyst: ${r.catalyst ?? "No confirmed catalyst"}`);
  return lines.join("\n");
}

export function formatEodWatchlist(plan: OvernightPlan): string {
  if (plan.recommendations.length === 0) {
    return [
      "**NEXT SESSION WATCHLIST**",
      "",
      "No qualified setups yet.",
      "",
      "Premarket revalidation will run before options open.",
    ].join("\n");
  }
  return [
    "**NEXT SESSION WATCHLIST**",
    "_WATCH ONLY — nothing here is executable after hours._",
    "",
    plan.recommendations.slice(0, 5).map(formatRec).join("\n\n"),
    "",
    "VERIFY CONTRACT AFTER OPTIONS OPEN. Educational research only, not financial advice.",
  ].filter(Boolean).join("\n");
}

export function formatEveningDelta(plan: OvernightPlan, reasons: string[]): string {
  return [
    `**NEXT SESSION WATCHLIST DELTA** - ${plan.tradingDay}`,
    "_WATCH only. Not executable after hours._",
    `Meaningful changes: ${reasons.slice(0, 8).join("; ") || "updated ranking evidence"}`,
    "",
    ...plan.recommendations.slice(0, 8).map(formatRec),
  ].join("\n");
}

export function formatPremarketPlan(plan: OvernightPlan): string {
  return [
    `**PREMARKET WATCHLIST UPDATE** - ${plan.tradingDay}`,
    "_WATCH only. VERIFY EXACT CONTRACT AFTER OPTIONS OPEN. VERIFY CONTRACT AFTER OPTIONS OPEN before any live options SEND path._",
    "",
    `SPY context: ${plan.marketContext.spyNote}`,
    `QQQ context: ${plan.marketContext.qqqNote}`,
    "",
    ...plan.recommendations.slice(0, 8).map(formatRec),
  ].join("\n");
}

export function formatMarketOpenConfirm(plan: OvernightPlan, reasons: string[] = []): string {
  return [
    `**MARKET-OPEN REVALIDATION** - ${plan.tradingDay}`,
    "_WATCHLIST status only. Not executable. Send a live alert only after the canonical options SEND path passes._",
    "_Confirm fresh bid/ask, acceptable spread, liquidity, and exact OCC contract. Do not use prior-session quotes._",
    reasons.length ? `Material changes: ${reasons.slice(0, 8).join("; ")}` : null,
    "",
    ...plan.recommendations.slice(0, 8).map(formatRec),
  ].filter(Boolean).join("\n");
}

export function formatIntradayActionable(input: IntradayActionableInput): string {
  if (!input.expiration || input.strike == null || !Number.isFinite(input.strike)) {
    return [
      `⚠️ ${input.symbol.toUpperCase()} OPTIONS ALERT UNAVAILABLE`,
      "",
      "Required contract details were missing, so no live alert was created.",
      "",
      "Educational purposes only. Options are high risk.",
    ].join("\n");
  }
  const side = String(input.side).toLowerCase() === "put" ? "put" : "call";
  const entryMid = input.bid != null && input.ask != null
    ? (input.bid + input.ask) / 2
    : Number(String(input.entryZone ?? "").match(/\d+(?:\.\d+)?/)?.[0] ?? 0);
  return formatPrivateLiveAlert({
    symbol: input.symbol,
    side,
    strike: input.strike,
    expiration: input.expiration,
    entryMid,
    t1: input.t1 ?? 0,
    t2: input.t2 ?? 0,
    stop: input.stop ?? 0,
    strategyKey: input.setupFamily ?? "",
    optionSymbol: input.contract,
    actionableReason: input.actionableReason,
    bid: input.bid,
    ask: input.ask,
    detailUrl: input.detailUrl,
    includeInternalLink: input.includeInternalLink === true,
  });
}

export interface IntradayActionableInput {
  label?: "LIVE" | "TEST";
  symbol: string;
  side: string;
  contract?: string | null;
  expiration?: string;
  strike?: number;
  entryZone?: string | null;
  bid?: number | null;
  ask?: number | null;
  t1?: number | null;
  t2?: number | null;
  stop?: number | null;
  confidence?: number | null;
  setupFamily?: string | null;
  triggerConfirmed?: string | null;
  actionableReason: string;
  mainRisk?: string | null;
  quoteFreshness?: string | null;
  detailUrl?: string | null;
  includeInternalLink?: boolean;
}

type NotifyDb = {
  prepare: (sql: string) => { get: (...a: unknown[]) => unknown; run: (...a: unknown[]) => unknown };
  exec: (sql: string) => unknown;
};

function ensureIdempotency(db: NotifyDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS owner_research_notify_log (
      trading_day TEXT NOT NULL,
      kind TEXT NOT NULL,
      symbol TEXT NOT NULL DEFAULT '',
      sent_at_ms INTEGER NOT NULL,
      PRIMARY KEY (trading_day, kind, symbol)
    );
  `);
}

function alreadySent(db: NotifyDb, day: string, kind: string, symbol = ""): boolean {
  ensureIdempotency(db);
  return Boolean(db.prepare(
    `SELECT 1 FROM owner_research_notify_log WHERE trading_day = ? AND kind = ? AND symbol = ?`,
  ).get(day, kind, symbol));
}

function markSent(db: NotifyDb, day: string, kind: string, symbol = ""): void {
  ensureIdempotency(db);
  db.prepare(
    `INSERT OR IGNORE INTO owner_research_notify_log (trading_day, kind, symbol, sent_at_ms) VALUES (?, ?, ?, ?)`,
  ).run(day, kind, symbol, Date.now());
}

/**
 * Write the SUPPRESSED ledger row for a research observation that was deliberately
 * not posted. Same shape and payload_type as a real send, so the owner-mirror
 * audit and the daily summary still see the opening — the evidence survives, only
 * the notification does not.
 */
function recordSuppressedOwnerNotify(
  kind: OwnerResearchNotifyKind,
  content: string,
  metadata: {
    idempotencyKey?: string | null;
    opportunityCaseId?: string | null;
    thesisFingerprint?: string | null;
    lifecycleState?: string | null;
  },
): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createDiscordDelivery } = require("../alert-store.ts");
    const destination = ownerNotifyDestinationForKind(kind);
    return createDiscordDelivery({
      alertId: null,
      channelType: "discord_webhook",
      webhookName: destination.webhook,
      payloadType: `owner_${kind}`,
      payload: { content: content.slice(0, 1900) },
      idempotencyKey: metadata.idempotencyKey ?? null,
      opportunityCaseId: metadata.opportunityCaseId ?? null,
      thesisFingerprint: metadata.thesisFingerprint ?? null,
      openingState: metadata.lifecycleState ?? null,
      status: "SUPPRESSED",
      failureReason: "owner_watch_discord_suppressed",
    });
  } catch {
    // Evidence-only. A ledger write failure must never change the delivery outcome.
    return null;
  }
}

async function postOwner(
  kind: OwnerResearchNotifyKind,
  content: string,
  env: NodeJS.ProcessEnv = process.env,
  metadata: {
    idempotencyKey?: string | null;
    opportunityCaseId?: string | null;
    thesisFingerprint?: string | null;
    lifecycleState?: string | null;
  } = {},
): Promise<{ ok: boolean; reason: string; messageId: string | null; deliveryId: string | null }> {
  // Dynamic import keeps this module usable in unit tests without loading Next server bits.
  const { discordWebhookConfigured, sendTrackedDiscord } = await import("../notifications.ts");
  const destination = ownerNotifyDestinationForKind(kind);
  if (!discordWebhookConfigured(destination.webhook, env)) {
    return { ok: false, reason: `${destination.requiredEnv} not configured`, messageId: null, deliveryId: null };
  }
  try {
    const sent = await sendTrackedDiscord({
      alertId: null,
      payload: { content: content.slice(0, 1900) },
      webhook: destination.webhook,
      payloadType: `owner_${kind}`,
      idempotencyKey: metadata.idempotencyKey
        ?? `owner:${destination.webhook}:${kind}:${content.slice(0, 500)}`,
      opportunityCaseId: metadata.opportunityCaseId ?? null,
      thesisFingerprint: metadata.thesisFingerprint ?? null,
      openingState: metadata.lifecycleState ?? null,
    });
    return {
      ok: true,
      reason: "sent",
      messageId: sent.messageId ?? null,
      deliveryId: sent.deliveryId ?? null,
    };
  } catch (e: any) {
    return { ok: false, reason: String(e?.message ?? e), messageId: null, deliveryId: null };
  }
}

export async function sendOwnerResearchNotify(opts: {
  db: NotifyDb;
  kind: OwnerResearchNotifyKind;
  content: string;
  symbol?: string;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
  idempotencyKey?: string | null;
  opportunityCaseId?: string | null;
  thesisFingerprint?: string | null;
  lifecycleState?: string | null;
  /**
   * This notify is a RESEARCH OBSERVATION, not an actionable trade callout — an
   * owner opening that is not subscriber-approved. Eligible for
   * OWNER_WATCH_DISCORD_SUPPRESSED; evidence is retained either way.
   */
  researchObservation?: boolean;
  /** Test hook — bypass default recap post. */
  postOverride?: (content: string) => Promise<{
    ok: boolean;
    reason?: string;
    messageId?: string | null;
    deliveryId?: string | null;
  }>;
}): Promise<OwnerNotifyResult> {
  const env = opts.env ?? process.env;
  const day = tradingDay(opts.nowMs ?? Date.now());
  const symbol = opts.symbol ?? "";
  if (!enabled(env)) {
    return { sent: false, skipped: true, reason: "OWNER_RESEARCH_DISCORD_ENABLED!=1", kind: opts.kind, content: opts.content };
  }
  if (opts.kind === "intraday_actionable" && !ownerResearchIntradayEnabled(env)) {
    return { sent: false, skipped: true, reason: "OWNER_RESEARCH_INTRADAY_ENABLED!=1", kind: opts.kind };
  }
  if (alreadySent(opts.db, day, opts.kind, symbol)) {
    return { sent: false, skipped: true, reason: "already sent (idempotent)", kind: opts.kind };
  }
  // Safety: never allow "buy now" language in after-hours templates.
  if (/buy now/i.test(opts.content) && ownerNotifyDestinationForKind(opts.kind).webhook === "watchlist") {
    return { sent: false, skipped: true, reason: "blocked buy-now language", kind: opts.kind };
  }
  const destination = ownerNotifyDestinationForKind(opts.kind);
  const normalized = destination.webhook === "recap"
    ? normalizeRecapContent(opts.kind, opts.content)
    : destination.webhook === "watchlist"
      ? normalizeWatchlistContent(opts.content)
      : { ok: true as const, content: opts.content };
  if (!normalized.ok) {
    return { sent: false, skipped: true, reason: normalized.reason, kind: opts.kind };
  }
  if (opts.postOverride) {
    if (!webhookConfiguredForDestination(opts.kind, env)) {
      return { sent: false, skipped: true, reason: `${destination.requiredEnv} not configured`, kind: opts.kind };
    }
  }
  // Research observation + suppression on: record it, do not post it. Reported as
  // delivered so every downstream consumer of the send result (opening claim,
  // owner-mirror linkage, PRE_MOVE_DISCOVERY_V2 capture) behaves exactly as before.
  if (opts.researchObservation && ownerWatchDiscordSuppressed(env)) {
    const deliveryId = recordSuppressedOwnerNotify(opts.kind, normalized.content, {
      idempotencyKey: opts.idempotencyKey ?? null,
      opportunityCaseId: opts.opportunityCaseId ?? null,
      thesisFingerprint: opts.thesisFingerprint ?? null,
      lifecycleState: opts.lifecycleState ?? null,
    });
    markSent(opts.db, day, opts.kind, symbol);
    return {
      sent: true,
      skipped: false,
      reason: "owner_watch_discord_suppressed",
      kind: opts.kind,
      content: normalized.content,
      messageId: null,
      deliveryId,
    };
  }
  const res = opts.postOverride
    ? await opts.postOverride(normalized.content).then((r) => ({
        ok: r.ok,
        reason: r.reason ?? (r.ok ? "sent" : "post_failed"),
        messageId: r.messageId ?? null,
        deliveryId: r.deliveryId ?? null,
      }))
    : await postOwner(opts.kind, normalized.content, env, {
        idempotencyKey: opts.idempotencyKey
          ?? (opts.kind === "intraday_actionable"
            ? `owner:options:intraday_actionable:${symbol}:OPENING`
            : null),
        opportunityCaseId: opts.opportunityCaseId,
        thesisFingerprint: opts.thesisFingerprint,
        lifecycleState: opts.lifecycleState,
      });
  if (!res.ok) return { sent: false, skipped: false, reason: res.reason, kind: opts.kind };
  markSent(opts.db, day, opts.kind, symbol);
  return {
    sent: true,
    skipped: false,
    reason: "ok",
    kind: opts.kind,
    messageId: res.messageId,
    deliveryId: res.deliveryId,
  };
}

export interface OwnerResearchTestResult {
  ok: boolean;
  configured: boolean;
  sent: boolean;
  reason: string;
  messageId: string | null;
  operatingMode: string;
  operatingLabel: string;
}

/**
 * Owner manual TEST — recap webhook only. Never writes idempotency log, readiness state,
 * subscriber alerts, trades, or Twitter/X drafts.
 */
export async function sendOwnerResearchTestNotification(
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): Promise<OwnerResearchTestResult> {
  const webhook = String(env.DISCORD_WEBHOOK_RECAP ?? "").trim();
  if (!webhook) {
    return {
      ok: false,
      configured: false,
      sent: false,
      reason: "DISCORD_WEBHOOK_RECAP not configured",
      messageId: null,
      operatingMode: "",
      operatingLabel: "",
    };
  }
  if (!enabled(env)) {
    return {
      ok: false,
      configured: true,
      sent: false,
      reason: "OWNER_RESEARCH_DISCORD_ENABLED!=1",
      messageId: null,
      operatingMode: "",
      operatingLabel: "",
    };
  }

  let monitorAlive: boolean | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { optionsMonitorHealth } = require("../research/options/monitor");
    const monitor = optionsMonitorHealth(env, nowMs);
    monitorAlive = monitor.alive || monitor.running;
  } catch {
    monitorAlive = null;
  }

  const operating = resolveOperatingMode({
    nowMs,
    monitorAlive,
    providerConfigured: Boolean(String(env.POLYGON_API_KEY ?? env.MASSIVE_API_KEY ?? "").trim()),
    providerHealthy: monitorAlive,
    dbOk: true,
  });

  const content = [
    "🧪 **TEST — OWNER RESEARCH NOTIFICATION**",
    "_Recap channel only · no trade · no subscriber alert · readiness unchanged_",
    "",
    `Operating mode: **${operating.label}**`,
    `Session detail: ${operating.detail}`,
    "",
    "**Sample next-session row (format check):**",
    "**#1 SPY** · BULLISH · ORB continuation",
    "Trigger: hold above prior high · Invalidation: lose VWAP",
    "Preferred DTE: 0DTE · Moneyness: ATM · Confidence: 82",
    "Main reason: ranked setup with clear trigger (fixture sample).",
    "Main risk: wide spread if chased without fresh quote.",
    "⚠️ VERIFY CONTRACT AFTER OPTIONS OPEN · quotes STALE · PRIOR SESSION",
  ].join("\n");

  const { postToDiscord } = await import("../notifications.ts");
  try {
    const res = await postToDiscord({ content: content.slice(0, 1900) }, { webhook: "recap", skipPublicCheck: true });
    return {
      ok: true,
      configured: true,
      sent: true,
      reason: "ok",
      messageId: res.messageId,
      operatingMode: operating.mode,
      operatingLabel: operating.label,
    };
  } catch (e: any) {
    return {
      ok: false,
      configured: true,
      sent: false,
      reason: String(e?.message ?? e),
      messageId: null,
      operatingMode: operating.mode,
      operatingLabel: operating.label,
    };
  }
}

/** Pure fixtures for screenshot / review HTML (no network). */
export function demoDiscordMessages(plan: OvernightPlan): Record<string, string> {
  return {
    next_session_watchlist: formatEodWatchlist(plan),
    premarket_watchlist_update: formatPremarketPlan(plan),
    market_open_revalidation: formatMarketOpenConfirm(plan),
    intraday_actionable: formatIntradayActionable({
      label: "LIVE",
      symbol: "SPY",
      side: "call",
      contract: "O:SPY260727C00635000",
      expiration: "2026-07-27",
      strike: 635,
      entryZone: "$1.20–$1.30",
      bid: 1.2,
      ask: 1.3,
      t1: 1.66,
      t2: 2.1,
      stop: 0.89,
      confidence: 88,
      setupFamily: "opening_range_breakout",
      triggerConfirmed: "Hold above ORB high with volume",
      actionableReason: "Fresh bid/ask, READY contract, ORB breakout held.",
      mainRisk: "Do not chase if mid exceeds planned entry without new high.",
      quoteFreshness: "fresh · 8s",
      detailUrl: "/intelligence/demo-case",
    }),
  };
}
