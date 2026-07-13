import { NextResponse } from "next/server";
import { ensureServerBoot } from "@/lib/server-boot";
import { getCallStats, hasPolygon } from "@/lib/polygon-provider";
import { loopState } from "@/lib/scanner-loop";
import {
  getSystemDataHealth,
  describeSymbolActionability,
  describeBlockingSample,
  maxAgeSecondsFor,
  kindLabel,
  type DataKind,
  type FreshnessSample,
} from "@/lib/data-freshness";
import { discordDeliverySummary, listDiscordDeliveries } from "@/lib/alert-store";
import { discordWebhookConfigured } from "@/lib/notifications";
import { marketSession } from "@/lib/trading-session";
import { supervisorTelemetry } from "@/lib/supervisor-cycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FRESHNESS_KINDS: DataKind[] = [
  "stock_quote",
  "one_minute_candle",
  "options_chain",
  "options_quote",
  "greeks",
  "news",
];

/**
 * GET /api/system/overview — one readable snapshot for the System Health page.
 * Composes provider health, market session, scanner-loop status, per-kind data
 * freshness (with the exact max-age thresholds via maxAgeSecondsFor), Discord
 * ledger health, database health, and human-readable blocking reasons.
 *
 * Read-only telemetry: no provider calls are made here.
 */
export async function GET() {
  ensureServerBoot();
  const now = Date.now();
  const session = marketSession(now);
  const callStats = getCallStats(now);
  const dataHealth = getSystemDataHealth(callStats);

  // Database health — a cheap writable ping, isolated so a DB fault never
  // masquerades as a provider or freshness problem.
  let db: { ok: boolean; note: string } = { ok: false, note: "not checked" };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require("@/lib/db");
    const one = getDb().prepare("SELECT 1 AS one").get()?.one;
    db = one === 1 ? { ok: true, note: "read/write OK" } : { ok: false, note: "unexpected ping result" };
  } catch (err: any) {
    db = { ok: false, note: err?.message ?? "database unavailable" };
  }

  const loop = loopState();
  const lastTickAgeMs = loop.lastTickAt == null ? null : Math.max(0, now - loop.lastTickAt);

  // Read-only owner-summary flags (no behavior change; pure reads of config/state).
  const supervisorEnabled = process.env.SUPERVISOR_RUNTIME === "1";
  const paperEnabled = process.env.PAPER_TRADING_ENABLED !== "0";
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ownerSettings, stockAlertGateReason } = require("@/lib/owner-settings");
  const owner = ownerSettings();
  const stockGate = stockAlertGateReason();
  let modelState = "INACTIVE_NO_TRAINABLE_DATA";
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    modelState = require("@/lib/model-registry").modelStatus()?.state ?? modelState;
  } catch { /* model registry unavailable — keep default */ }

  // Per-kind freshness rows with the real thresholds attached.
  const freshness = FRESHNESS_KINDS.map((kind) => {
    const sample = dataHealth.freshness[kind] as FreshnessSample | undefined;
    return {
      kind,
      label: kindLabel(kind),
      max_age_seconds: maxAgeSecondsFor(kind, session),
      status: sample?.freshness_status ?? "NOT_REQUESTED_YET",
      symbol: sample?.symbol ?? null,
      age_seconds: sample?.data_age_seconds ?? null,
      provider_timestamp: sample?.provider_timestamp ?? null,
      reason: sample ? describeBlockingSample(sample) : "No sample observed yet in this process.",
    };
  });

  // Human-readable blocking reasons per stale symbol (provider health stays
  // independent — a single stale symbol does not mark the provider down).
  const blocked = (dataHealth.blocking_symbols ?? dataHealth.stale_symbols ?? []).map((sym) => describeSymbolActionability(sym));

  const discord = {
    webhooks: {
      options: discordWebhookConfigured("options"),
      stocks: discordWebhookConfigured("stocks"),
      recap: discordWebhookConfigured("recap"),
      default: discordWebhookConfigured("default"),
    },
    summary: discordDeliverySummary(),
    recentFailures: listDiscordDeliveries(10).filter((d: any) =>
      ["FAILED", "RETRYING", "SUPPRESSED", "NOT_CONFIGURED"].includes(d.status),
    ),
  };

  return NextResponse.json({
    ok: true,
    application_time: dataHealth.application_time,
    exchange_time: dataHealth.exchange_time,
    trading_day: dataHealth.trading_day,
    market_session: session,
    provider: {
      configured: hasPolygon(),
      ...dataHealth.provider,
    },
    scanner: {
      running: loop.running,
      interval_ms: loop.intervalMs,
      last_tick_age_ms: lastTickAgeMs,
      ticks: loop.ticks,
      triggers: loop.triggers,
      alerts: loop.alerts,
      errors: loop.errors,
      note: loop.note,
    },
    freshness,
    blocked,
    monitored_symbol_count: dataHealth.monitored_symbols.length,
    stale_symbol_count: dataHealth.stale_symbols.length,
    blocking_symbol_count: (dataHealth.blocking_symbols ?? []).length,
    monitored_symbols: dataHealth.monitored_symbols,
    stale_symbols: dataHealth.stale_symbols,
    blocking_symbols: dataHealth.blocking_symbols ?? [],
    entitlement_limitations: dataHealth.entitlement_limitations,
    rate_limit: {
      status: dataHealth.provider.rate_limit_status,
      calls_today: callStats?.callsToday ?? null,
      daily_cap: callStats?.dailyCap ?? null,
      calls_this_minute: callStats?.callsThisMinute ?? null,
      minute_cap: callStats?.minuteCap ?? null,
      quota_exceeded: callStats?.quotaExceeded ?? false,
    },
    database: db,
    discord,
    supervisor: { enabled: supervisorEnabled, ...supervisorTelemetry() },
    paper: { enabled: paperEnabled },
    model: { state: modelState },
    owner: {
      core_universe: owner.coreUniverse,
      max_discord_alerts: owner.maxDiscordAlerts,
      min_setup_quality: owner.minSetupQuality,
      bullish_enabled: owner.bullishEnabled,
      bearish_enabled: owner.bearishEnabled,
      early_alerts_enabled: owner.earlyAlertsEnabled,
      categories: [...owner.categories],
      stock_alerts_blocked_reason: stockGate,
    },
  });
}
