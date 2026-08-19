import { NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-route-auth";
import { ensureServerBoot } from "@/lib/server-boot";
import { getCallStats, hasPolygon } from "@/lib/polygon-provider";
import { loopState } from "@/lib/scanner-loop";
import {
  getSystemDataHealth,
  describeSymbolActionability,
  describeBlockingSample,
  aggregateBlockedActionability,
  maxAgeSecondsFor,
  kindLabel,
  type DataKind,
  type FreshnessSample,
} from "@/lib/data-freshness";
import { discordDeliverySummary, listDiscordDeliveries } from "@/lib/alert-store";
import { discordWebhookConfigured } from "@/lib/notifications";
import { marketSession } from "@/lib/trading-session";
import { supervisorTelemetry } from "@/lib/supervisor-cycle";
import { quotaPolicySnapshot } from "@/lib/quota-policy";
import { subscriberDiscordOwnershipSummary } from "@/lib/subscriber-discord-owner";

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
 *
 * RESILIENCE CONTRACT: a System Health page must NEVER white-screen. Every
 * independent section is isolated in `safe(...)` so a single faulted subsystem
 * (e.g. the SQLite volume not mounting on Railway, which makes getDb() throw)
 * degrades that one card and is reported in `faults[]` instead of 500-ing the
 * whole route and tripping the app error boundary ("Something went wrong").
 */

export async function GET(req: Request) {
  const denied = requireApiToken(req);
  if (denied) return denied;
  // Request-local so concurrent requests never share fault state.
  const faults: string[] = [];
  const safe = <T,>(label: string, fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (err: any) {
      faults.push(`${label}: ${String(err?.message ?? err).slice(0, 160)}`);
      return fallback;
    }
  };
  safe("boot", () => ensureServerBoot(), undefined);
  const now = Date.now();
  const session = safe("market_session", () => marketSession(now), "closed" as ReturnType<typeof marketSession>);
  const callStats = safe("call_stats", () => getCallStats(now), null as any);
  const dataHealth = safe("data_health", () => getSystemDataHealth(callStats), null as any);

  // Database health — a cheap writable ping, isolated so a DB fault never
  // masquerades as a provider or freshness problem.
  const db = safe<{ ok: boolean; note: string; storage: Record<string, unknown> | null }>("database", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require("@/lib/db");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getStorageHealthOnDb } = require("@/lib/storage-health");
    const handle = getDb();
    const one = handle.prepare("SELECT 1 AS one").get()?.one;
    return one === 1
      ? { ok: true, note: "read/write OK", storage: getStorageHealthOnDb(handle, process.env, now) }
      : { ok: false, note: "unexpected ping result", storage: null };
  }, { ok: false, note: "database unavailable", storage: null });

  const loop = safe("scanner_loop", () => loopState(), { running: false, intervalMs: null, lastTickAt: null, ticks: 0, triggers: 0, alerts: 0, errors: 0, note: "scanner state unavailable" } as any);
  const lastTickAgeMs = loop.lastTickAt == null ? null : Math.max(0, now - loop.lastTickAt);

  // Read-only owner-summary flags (no behavior change; pure reads of config/state).
  const supervisorEnabled = process.env.SUPERVISOR_RUNTIME === "1";
  const paperEnabled = process.env.PAPER_TRADING_ENABLED !== "0";
  const { owner, stockGate } = safe("owner_settings", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ownerSettings, stockAlertGateReason } = require("@/lib/owner-settings");
    return { owner: ownerSettings(), stockGate: stockAlertGateReason() };
  }, { owner: null as any, stockGate: null as any });
  const modelState = safe("model", () =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("@/lib/model-registry").modelStatus()?.state ?? "INACTIVE_NO_TRAINABLE_DATA",
    "INACTIVE_NO_TRAINABLE_DATA");

  // Per-kind freshness rows with the real thresholds attached.
  const freshness = safe("freshness", () => FRESHNESS_KINDS.map((kind) => {
    const sample = dataHealth?.freshness?.[kind] as FreshnessSample | undefined;
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
  }), [] as any);

  // Human-readable blocking reasons — aggregated by class for System Health,
  // with full per-symbol drill-down retained for on-demand inspection.
  const blocked = safe("blocked", () => (dataHealth?.blocking_symbols ?? dataHealth?.stale_symbols ?? []).map((sym: string) => describeSymbolActionability(sym)), [] as any);
  const blockedAggregates = safe("blocked_aggregates", () => aggregateBlockedActionability(blocked), [] as any);

  // Webhook configuration is an ENV-ONLY read — it must NEVER depend on the DB.
  // (Bundling it with the DB-backed ledger below made a DB fault masquerade as
  // "webhook not configured" on the dashboard.) Computed on its own so the config
  // signal stays truthful even when the SQLite volume is down.
  const webhooks = safe("discord_webhooks", () => ({
    options: discordWebhookConfigured("options"),
    stocks: discordWebhookConfigured("stocks"),
    recap: discordWebhookConfigured("recap"),
    default: discordWebhookConfigured("default"),
  }), { options: false, stocks: false, recap: false, default: false });
  const discordLedger = safe("discord_ledger", () => ({
    summary: discordDeliverySummary(),
    recentFailures: listDiscordDeliveries(10).filter((d: any) =>
      ["FAILED", "RETRYING", "SUPPRESSED", "NOT_CONFIGURED"].includes(d.status),
    ),
  }), { summary: [] as { status: string; count: number }[], recentFailures: [] as any[] });
  const discord = { webhooks, ...discordLedger };

  const provider: any = dataHealth?.provider ?? { rate_limit_status: "UNKNOWN" };

  const quota = safe("quota_policy", () => quotaPolicySnapshot(), null as ReturnType<typeof quotaPolicySnapshot> | null);

  const forwardLearning = safe("forward_learning", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require("@/lib/db");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildForwardLearningOverviewOnDb } = require("@/lib/research/episode/forward-labeler");
    return buildForwardLearningOverviewOnDb(getDb(), now, process.env);
  }, null as Record<string, unknown> | null);

  const independentOptions = safe("independent_options", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { optionsMonitorHealth, optionsMonitorMetrics } = require("@/lib/research/options/monitor");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { evaluateMarketSessionGuard } = require("@/lib/market-session-guard");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readRuntimeStatusOnDb } = require("@/lib/research/options/runtime");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildIndependentPipelineHealth } = require("@/lib/research/options/independent-pipeline-health");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { researchFlags } = require("@/lib/research/flags");
    const ownership = subscriberDiscordOwnershipSummary();
    const monitor = optionsMonitorHealth(process.env, now);
    const metrics = optionsMonitorMetrics();
    const sessionGuard = evaluateMarketSessionGuard(now, process.env);
    let runtimeStatus: Record<string, unknown> | null = null;
    let recentSentCount24h: number | null = null;
    let latency: Record<string, unknown> | null = null;
    let setupEpisodeV2: Record<string, unknown> | null = null;
    let contractFunnel: Record<string, unknown> | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getDb } = require("@/lib/db");
      const db = getDb();
      runtimeStatus = readRuntimeStatusOnDb(db, process.env, now) as Record<string, unknown>;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { optionsLatencySummaryOnDb } = require("@/lib/research/options/latency-telemetry");
        latency = optionsLatencySummaryOnDb(db, now);
      } catch { latency = null; }
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { setupEpisodeV2HealthOnDb } = require("@/lib/research/episode/v2");
        setupEpisodeV2 = setupEpisodeV2HealthOnDb(db);
      } catch (err: any) {
        setupEpisodeV2 = { status: "ERROR", error: String(err?.message ?? err).slice(0, 180) };
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { contractFunnelHealthOnDb } = require("@/lib/research/options/contract-funnel-store");
        contractFunnel = contractFunnelHealthOnDb(db);
      } catch (err: any) {
        contractFunnel = { status: "ERROR", error: String(err?.message ?? err).slice(0, 180) };
      }
      try {
        const since = now - 24 * 3600_000;
        recentSentCount24h = Number((db.prepare(
          "SELECT COUNT(*) n FROM options_alerts WHERE state='SENT' AND research_only=0 AND sent_at_ms >= ?",
        ).get(since) as { n?: number } | undefined)?.n ?? 0);
      } catch { recentSentCount24h = null; }
    } catch { /* optional */ }
    const hb = (runtimeStatus?.heartbeat ?? null) as Record<string, unknown> | null;
    const selfCheck = (runtimeStatus?.selfCheck ?? null) as { items?: { name: string; ok: boolean }[] } | null;
    const selfCheckPolygonOk = selfCheck?.items?.find((i) => i.name === "polygonApiKey")?.ok ?? null;
    const health = buildIndependentPipelineHealth({
      nowMs: now,
      discoveryEnabled: Boolean(researchFlags(process.env).independentOptionsDiscovery ?? monitor.enabled),
      killSwitch: process.env.OPTIONS_CALLOUTS_KILL === "1",
      ownership: ownership.owner,
      independentOwns: ownership.independentOwns,
      localRunning: monitor.running,
      localAlive: monitor.alive,
      localLastTier0CycleMs: monitor.lastTier0CycleMs,
      localLastTier1CycleMs: monitor.lastTier1CycleMs,
      localLastTier2CycleMs: monitor.lastTier2CycleMs,
      localBreaker: monitor.breakerState,
      localUnhealthyReason: monitor.unhealthyReason,
      portfolioHealthy: Boolean(monitor.portfolioDelivery?.healthy),
      heartbeat: hb,
      heartbeatAgeMs: (runtimeStatus?.heartbeatAgeMs as number | null) ?? null,
      heartbeatFresh: Boolean(runtimeStatus?.heartbeatFresh),
      sessionGuardState: sessionGuard.state ?? null,
      sessionGuardReason: sessionGuard.reason ?? null,
      polygonEnvConfigured: hasPolygon(),
      selfCheckPolygonOk,
      webhookConfigured: discordWebhookConfigured("options"),
      recentSentCount24h,
    });
    return {
      ...health,
      portfolioDelivery: monitor.portfolioDelivery,
      runtimeSession: (hb?.session as string | null) ?? health.session,
      metrics: {
        sessionState: health.session,
        throttles: metrics.throttles,
        providerFailures: Number(hb?.providerFailures ?? metrics.providerFailures ?? 0),
        discoveryPaused: callStats?.discoveryPaused ?? false,
      },
      latency,
      setupEpisodeV2,
      contractFunnel,
    };
  }, null as Record<string, unknown> | null);

  return NextResponse.json({
    ok: faults.length === 0,
    faults,
    application_time: dataHealth?.application_time ?? new Date(now).toISOString(),
    exchange_time: dataHealth?.exchange_time ?? null,
    trading_day: dataHealth?.trading_day ?? null,
    market_session: session,
    provider: {
      configured: safe("provider_configured", () => hasPolygon(), false),
      ...provider,
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
    blocked_aggregates: blockedAggregates,
    monitored_symbol_count: dataHealth?.monitored_symbols?.length ?? 0,
    stale_symbol_count: dataHealth?.stale_symbols?.length ?? 0,
    blocking_symbol_count: (dataHealth?.blocking_symbols ?? []).length,
    monitored_symbols: dataHealth?.monitored_symbols ?? [],
    stale_symbols: dataHealth?.stale_symbols ?? [],
    blocking_symbols: dataHealth?.blocking_symbols ?? [],
    entitlement_limitations: dataHealth?.entitlement_limitations ?? [],
    rate_limit: {
      status: provider.rate_limit_status,
      calls_today: callStats?.callsToday ?? null,
      daily_cap: callStats?.dailyCap ?? null,
      calls_this_minute: callStats?.callsThisMinute ?? null,
      minute_cap: callStats?.minuteCap ?? null,
      quota_exceeded: callStats?.quotaExceeded ?? false,
      grader_daily_reserve: callStats?.graderDailyReserve ?? null,
      discovery_daily_budget: callStats?.discoveryDailyBudget ?? null,
      discovery_paused: callStats?.discoveryPaused ?? false,
      quota_mode: callStats?.quotaMode ?? quota?.quotaMode ?? null,
      operator_warning: quota?.operatorWarning ?? null,
    },
    alert_reliability: {
      ownership: subscriberDiscordOwnershipSummary(),
      kill_switch: process.env.OPTIONS_CALLOUTS_KILL === "1",
    },
    independent_options: independentOptions,
    forward_learning: forwardLearning,
    stock_scanner: {
      running: loop.running,
      interval_ms: loop.intervalMs,
      last_tick_age_ms: lastTickAgeMs,
      ticks: loop.ticks,
      triggers: loop.triggers,
      alerts: loop.alerts,
      errors: loop.errors,
      note: loop.note,
    },
    database: db,
    discord,
    supervisor: { enabled: supervisorEnabled, ...safe("supervisor", () => supervisorTelemetry(), {} as ReturnType<typeof supervisorTelemetry>) },
    paper: { enabled: paperEnabled },
    model: { state: modelState },
    owner: owner ? {
      core_universe: owner.coreUniverse,
      max_discord_alerts: owner.maxDiscordAlerts,
      min_setup_quality: owner.minSetupQuality,
      bullish_enabled: owner.bullishEnabled,
      bearish_enabled: owner.bearishEnabled,
      early_alerts_enabled: owner.earlyAlertsEnabled,
      categories: [...owner.categories],
      stock_alerts_blocked_reason: stockGate,
    } : null,
  });
}
