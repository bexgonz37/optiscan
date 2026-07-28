/**
 * Owner-only Discord research notifications (recap webhook).
 * Never posts to subscriber options webhook or Twitter/X content webhook.
 * Gated by OWNER_RESEARCH_DISCORD_ENABLED=1 (default off).
 */
import { tradingDay } from "../trading-session.ts";
import type { OvernightPlan, OvernightRecommendation } from "../research/overnight/next-session-plan.ts";
import { resolveOperatingMode } from "../dashboard/operating-mode.ts";

export type OwnerResearchNotifyKind =
  | "eod_watchlist"
  | "evening_delta"
  | "premarket_plan"
  | "market_open_confirm"
  | "intraday_actionable"
  | "watchlist_followup";

export interface OwnerNotifyResult {
  sent: boolean;
  skipped: boolean;
  reason: string;
  kind: OwnerResearchNotifyKind;
  content?: string;
}

function enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OWNER_RESEARCH_DISCORD_ENABLED === "1";
}

export function ownerResearchIntradayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OWNER_RESEARCH_DISCORD_ENABLED === "1" && env.OWNER_RESEARCH_INTRADAY_ENABLED === "1";
}

function formatRec(r: OvernightRecommendation): string {
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

export function formatEodWatchlist(plan: OvernightPlan): string {
  const lines = [
    `📋 **Next-session watchlist** · ${plan.tradingDay}`,
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

export function formatEveningDelta(plan: OvernightPlan, reasons: string[]): string {
  return [
    `🔄 **Evening watchlist update** · ${plan.tradingDay}`,
    `_Plan changed: ${reasons.slice(0, 6).join("; ")}_`,
    `_Research only — not a buy signal._`,
    "",
    ...plan.recommendations.slice(0, 6).map(formatRec),
  ].join("\n");
}

export function formatPremarketPlan(plan: OvernightPlan): string {
  return [
    `🌅 **Premarket plan** · ${plan.tradingDay}`,
    `_Refreshed levels — VERIFY CONTRACT AFTER OPTIONS OPEN_`,
    "",
    ...plan.recommendations.slice(0, 8).map(formatRec),
  ].join("\n");
}

export function formatMarketOpenConfirm(plan: OvernightPlan): string {
  return [
    `🔔 **Market open — revalidate contracts** · ${plan.tradingDay}`,
    `_Do not use prior-session quotes. Confirm fresh bid/ask before any TRADE NOW._`,
    "",
    ...plan.recommendations.slice(0, 8).map((r) =>
      `#${r.rank} ${r.symbol} · ${r.bias} · trigger ${r.triggerLevel ?? "TBD"} · ${r.preferredDteRange} ${r.preferredMoneyness}`
    ),
  ].join("\n");
}

export function formatIntradayActionable(input: IntradayActionableInput): string {
  const side = String(input.side).toUpperCase();
  const labelPrefix = input.label === "TEST" ? "🧪 TEST · " : "⚡ LIVE · ";
  const lines = [
    `${labelPrefix}**TRADE NOW CANDIDATE** · ${input.symbol} ${side}`,
    input.contract ? `Contract: \`${input.contract}\`` : "Contract: pending fresh selection",
    input.expiration ? `Expiration: ${input.expiration} · Strike: ${input.strike}` : null,
    input.entryZone ? `Entry zone: ${input.entryZone}` : null,
    input.bid != null && input.ask != null ? `Bid/Ask: $${input.bid.toFixed(2)} / $${input.ask.toFixed(2)}` : null,
    input.t1 != null ? `T1: $${input.t1.toFixed(2)}${input.t2 != null ? ` · T2: $${input.t2.toFixed(2)}` : ""}${input.stop != null ? ` · Stop: $${input.stop.toFixed(2)}` : ""}` : null,
    input.setupFamily ? `Setup: ${input.setupFamily}` : null,
    input.triggerConfirmed ? `Trigger confirmed: ${input.triggerConfirmed}` : null,
    input.actionableReason ? `Why actionable now: ${input.actionableReason}` : null,
    input.mainRisk ? `Main risk: ${input.mainRisk}` : null,
    input.confidence != null ? `Confidence: ${input.confidence}` : null,
    input.quoteFreshness ? `Quote: ${input.quoteFreshness}` : null,
    input.detailUrl ? `Detail: ${input.detailUrl}` : null,
    "_Owner research mirror — not guaranteed profit. Subscriber delivery uses the independent options path._",
  ].filter(Boolean);
  return lines.join("\n");
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

async function postOwner(content: string, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; reason: string }> {
  // Dynamic import keeps this module usable in unit tests without loading Next server bits.
  const { postToDiscord } = await import("../notifications.ts");
  const webhook = env.DISCORD_WEBHOOK_RECAP || env.DISCORD_WEBHOOK_URL;
  if (!webhook) return { ok: false, reason: "DISCORD_WEBHOOK_RECAP unset" };
  try {
    await postToDiscord(
      { content: content.slice(0, 1900) },
      { webhook: "recap", skipPublicCheck: true },
    );
    return { ok: true, reason: "sent" };
  } catch (e: any) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

export async function sendOwnerResearchNotify(opts: {
  db: NotifyDb;
  kind: OwnerResearchNotifyKind;
  content: string;
  symbol?: string;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
  /** Test hook — bypass default recap post. */
  postOverride?: (content: string) => Promise<{ ok: boolean; reason?: string }>;
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
  if (/buy now/i.test(opts.content) && (opts.kind === "eod_watchlist" || opts.kind === "evening_delta" || opts.kind === "premarket_plan")) {
    return { sent: false, skipped: true, reason: "blocked buy-now language", kind: opts.kind };
  }
  const res = opts.postOverride
    ? await opts.postOverride(opts.content).then((r) => ({ ok: r.ok, reason: r.reason ?? (r.ok ? "sent" : "post_failed") }))
    : await postOwner(opts.content, env);
  if (!res.ok) return { sent: false, skipped: false, reason: res.reason, kind: opts.kind };
  markSent(opts.db, day, opts.kind, symbol);
  return { sent: true, skipped: false, reason: "ok", kind: opts.kind };
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
    eod_watchlist: formatEodWatchlist(plan),
    premarket_plan: formatPremarketPlan(plan),
    market_open_confirm: formatMarketOpenConfirm(plan),
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
