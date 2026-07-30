/**
 * End-to-end pipeline diagnostics — answers "why did no alerts arrive?"
 * Aggregates monitor, candidates, delivery decisions, Discord, and provider health.
 */
import { researchFlags } from "../flags.ts";
import { optionsMonitorHealth, optionsMonitorMetrics } from "./monitor.ts";
import { deliveryDecisionMetricsOnDb } from "./delivery-decision.ts";
import { readDeliveryMetricsOnDb } from "./delivery.ts";
import { readRuntimeStatusOnDb } from "./runtime.ts";
import { countOpportunityCasesByDeliveryOnDb } from "../../opportunity-case/store.ts";
import {
  opportunityLifecycleEnabled,
  opportunityLifecycleSchemaReady,
  readLifecycleMetricsOnDb,
  recentSuppressionsOnDb,
} from "../../opportunity-case/live.ts";
import { explainTickerAlertDecision, type TickerAlertExplanation } from "./why-no-alert.ts";
import { quotaPolicySnapshot } from "../../quota-policy.ts";
import { subscriberDiscordOwnershipSummary } from "../../subscriber-discord-owner.ts";
import { evaluateMarketSessionGuard } from "../../market-session-guard.ts";
import { inspectSchemaReadiness } from "../../db-schema-readiness.ts";
import { readInstrumentationFallbackInserts } from "../../db-legacy-columns.ts";
import { buildPaperChainDiagnostic } from "./paper-chain.ts";
import { buildShadowSoakAggregate } from "./shadow-outcomes.ts";
import { buildQuantLaneReport } from "./quant-lanes.ts";

interface DiagDb {
  prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[]; run?: (...a: any[]) => { changes: number } };
}

export interface PipelineStageCounts {
  stage: string;
  count: number;
  reasonCode?: string;
}

export interface WhyNoAlertsDiagnostic {
  ok: boolean;
  generatedAtMs: number;
  summary: string;
  likelyBlockers: string[];
  flags: {
    independentOptionsDiscovery: boolean;
    earlyOptionsCallouts: boolean;
    portfolioDelivery: boolean;
    realOptionPaper: boolean;
  };
  monitor: ReturnType<typeof optionsMonitorHealth> & { metrics: ReturnType<typeof optionsMonitorMetrics> };
  session: { state: string; tradingHoursSupported: boolean };
  candidates: { observed24h: number; ready24h: number; rejected24h: number; byState: Record<string, number> };
  delivery: { decisionsAllTime: Record<string, number>; sent24h: number; failed24h: number; duplicate24h: number; metrics?: Record<string, unknown> };
  provider: { failures: number; breakerOpen: boolean; staleBars: number };
  discord: { webhookConfigured: boolean; recentFailures: number };
  latency: { detectionToDecisionP50: number | null; detectionToDecisionP95: number | null };
  opportunityCases: Record<string, number>;
  rejectionReasons: { code: string; count: number }[];
  lifecycle?: {
    enabled: boolean;
    schemaReady: boolean;
    active: boolean;
    newOpportunitiesCreated: number;
    duplicateOpeningAlertsSuppressed: number;
    evidenceEventsAttached: number;
    milestonesReached: number;
    milestoneUpdatesDelivered: number;
    milestoneDeliveryFailures: number;
    activeOpportunities: number;
    contentEventsPending: number;
    recentSuppressions: Record<string, unknown>[];
  };
  tickerExplanation?: TickerAlertExplanation | null;
  alertReliability?: {
    ownership: ReturnType<typeof subscriberDiscordOwnershipSummary>;
    quota: ReturnType<typeof quotaPolicySnapshot>;
    killSwitch: boolean;
    ambiguousOpens24h: number;
  };
  sessionGuard?: ReturnType<typeof evaluateMarketSessionGuard>;
  schemaReadiness?: {
    ok: boolean;
    missingShadowSoakTables: string[];
    missingInstrumentationColumns: Array<{ table: string; column: string }>;
    instrumentationFallbackInserts: number;
  };
  evidenceIntegrity?: {
    paperChain: { paperLinkRate: number | null; unhealthyRows: number; sent24h: number };
    shadowGrader: { pendingOutcomes: number; missingDataPct: number; wouldSend: number; wouldBlock: number };
    quantLanes: { lanesWithEvidence: number; lanesInsufficient: number };
    aiWeekly: { lastStatus: string | null; validationFailed24h: number };
  };
}

function hasTable(db: DiagDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(name));
  } catch {
    return false;
  }
}

export function buildWhyNoAlertsDiagnostic(
  db: DiagDb | null,
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
  opts: { symbol?: string | null } = {},
): WhyNoAlertsDiagnostic {
  const f = researchFlags(env);
  const monitor = optionsMonitorHealth(env, nowMs);
  const metrics = optionsMonitorMetrics();
  const since24h = nowMs - 86_400_000;
  const likelyBlockers: string[] = [];

  if (!f.independentOptionsDiscovery) likelyBlockers.push("INDEPENDENT_OPTIONS_DISCOVERY_ENABLED!=1");
  if (!f.earlyOptionsCallouts) likelyBlockers.push("EARLY_OPTIONS_CALLOUTS_ENABLED!=1");
  if (env.OPTIONS_PORTFOLIO_DELIVERY_ENABLED !== "1") likelyBlockers.push("OPTIONS_PORTFOLIO_DELIVERY_ENABLED!=1");
  if (!String(env.DISCORD_WEBHOOK_OPTIONS ?? "").trim()) likelyBlockers.push("DISCORD_WEBHOOK_OPTIONS not configured");
  if (monitor.breakerState === "open") likelyBlockers.push("Provider circuit breaker OPEN");
  if (!monitor.alive && f.independentOptionsDiscovery) likelyBlockers.push("Options monitor not alive (no recent cycle)");
  if (db) {
    const schema = inspectSchemaReadiness(db as any, env);
    if (!schema.ok && env.SUBSCRIBER_CONFIG_STRICT !== "0") {
      likelyBlockers.push("Instrumentation schema incomplete for shadow soak");
    }
  }

  const byState: Record<string, number> = {};
  let observed24h = 0, ready24h = 0, rejected24h = 0;
  if (db && hasTable(db, "options_candidates")) {
    const rows = db.prepare(
      "SELECT state, COUNT(*) n FROM options_candidates WHERE created_at_ms >= ? GROUP BY state",
    ).all(since24h) as { state: string; n: number }[];
    for (const r of rows) {
      byState[r.state] = Number(r.n);
      observed24h += Number(r.n);
      if (r.state === "READY") ready24h = Number(r.n);
      if (r.state === "REJECTED") rejected24h = Number(r.n);
    }
  }

  // deliveryDecisionMetricsOnDb intentionally reports its full persisted cohort.
  // Keep the scope honest here; the session-audit read model supplies bounded counts.
  const decisionsAllTime: Record<string, number> = {};
  if (db) {
    const dm = deliveryDecisionMetricsOnDb(db as any);
    if (dm.byOutcome) {
      for (const [k, v] of Object.entries(dm.byOutcome)) decisionsAllTime[k] = Number(v);
    }
  }

  let sent24h = 0, failed24h = 0, duplicate24h = 0;
  const rejectionReasons: { code: string; count: number }[] = [];
  if (db && hasTable(db, "options_alerts")) {
    sent24h = Number((db.prepare("SELECT COUNT(*) n FROM options_alerts WHERE state='SENT' AND created_at_ms >= ?").get(since24h) as { n: number })?.n ?? 0);
    failed24h = Number((db.prepare("SELECT COUNT(*) n FROM options_alerts WHERE state='SEND_FAILED' AND created_at_ms >= ?").get(since24h) as { n: number })?.n ?? 0);
    const rejRows = db.prepare(
      "SELECT failure_reason code, COUNT(*) n FROM options_alerts WHERE failure_reason IS NOT NULL AND created_at_ms >= ? GROUP BY failure_reason ORDER BY n DESC LIMIT 10",
    ).all(since24h) as { code: string; n: number }[];
    for (const r of rejRows) rejectionReasons.push({ code: r.code, count: Number(r.n) });
  }
  if (db && hasTable(db, "options_delivery_decisions")) {
    duplicate24h = Number((db.prepare(
      "SELECT COUNT(*) n FROM options_delivery_decisions WHERE final_delivery_reason LIKE '%duplicate%' AND created_at_ms >= ?",
    ).get(since24h) as { n: number })?.n ?? 0);
  }

  const deliveryMetrics = db ? readDeliveryMetricsOnDb(db as any) : {};
  const runtime = db ? readRuntimeStatusOnDb(db as any, env) : null;
  const opportunityCases = db && hasTable(db, "opportunity_cases") ? countOpportunityCasesByDeliveryOnDb(db as any, since24h) : {};

  let summary = "Pipeline operational";
  if (likelyBlockers.length > 0) summary = `Blocked: ${likelyBlockers[0]}`;
  else if (observed24h === 0) summary = "No candidates observed in 24h — check monitor and market session";
  else if (ready24h === 0) summary = "Candidates observed but none reached READY — review rejection reasons";
  else if (sent24h === 0) summary = "READY candidates exist but no Discord SENT in 24h — review delivery decisions";

  const det = metrics.detectionToDecisionMs as { p50?: number | null; p95?: number | null } | undefined;

  let ambiguousOpens24h = 0;
  if (db && hasTable(db, "discord_send_attempts")) {
    ambiguousOpens24h = Number(
      (db.prepare("SELECT COUNT(*) n FROM discord_send_attempts WHERE ambiguous=1 AND created_at_ms >= ?").get(since24h) as { n: number })?.n ?? 0,
    );
  }

  return {
    ok: likelyBlockers.length === 0,
    generatedAtMs: nowMs,
    summary,
    likelyBlockers,
    flags: {
      independentOptionsDiscovery: f.independentOptionsDiscovery,
      earlyOptionsCallouts: f.earlyOptionsCallouts,
      portfolioDelivery: env.OPTIONS_PORTFOLIO_DELIVERY_ENABLED === "1",
      realOptionPaper: f.realOptionPaper,
    },
    monitor: { ...monitor, metrics },
    session: {
      state: String((runtime as Record<string, unknown> | null)?.session ?? metrics.sessionState ?? "unknown"),
      tradingHoursSupported: metrics.sessionState !== "closed",
    },
    candidates: { observed24h, ready24h, rejected24h, byState },
    delivery: { decisionsAllTime, sent24h, failed24h, duplicate24h, metrics: deliveryMetrics },
    provider: {
      failures: Number(metrics.providerFailures ?? 0),
      breakerOpen: monitor.breakerState === "open",
      staleBars: Number((metrics.stages as Record<string, number>)?.stage15Stale ?? 0),
    },
    discord: {
      webhookConfigured: Boolean(String(env.DISCORD_WEBHOOK_OPTIONS ?? "").trim()),
      recentFailures: failed24h,
    },
    latency: {
      detectionToDecisionP50: det?.p50 ?? null,
      detectionToDecisionP95: det?.p95 ?? null,
    },
    opportunityCases,
    rejectionReasons,
    lifecycle: (() => {
      const enabled = opportunityLifecycleEnabled(env);
      const schemaReady = db ? opportunityLifecycleSchemaReady(db as any) : false;
      const m = db ? readLifecycleMetricsOnDb(db as any) : {};
      const activeOpportunities = Number((m as any).activeOpportunities ?? 0);
      return {
        enabled,
        schemaReady,
        active: enabled && schemaReady,
        newOpportunitiesCreated: Number((m as any).newOpportunitiesCreated ?? 0),
        duplicateOpeningAlertsSuppressed: Number((m as any).duplicateOpeningAlertsSuppressed ?? 0),
        evidenceEventsAttached: Number((m as any).evidenceEventsAttached ?? 0),
        milestonesReached: Number((m as any).milestonesReached ?? 0),
        milestoneUpdatesDelivered: Number((m as any).milestoneUpdatesDelivered ?? 0),
        milestoneDeliveryFailures: Number((m as any).milestoneDeliveryFailures ?? 0),
        activeOpportunities,
        contentEventsPending: Number((m as any).contentEventsPending ?? 0),
        recentSuppressions: db ? recentSuppressionsOnDb(db as any, 15) : [],
      };
    })(),
    tickerExplanation: opts.symbol ? explainTickerAlertDecision(db, opts.symbol, nowMs) : null,
    alertReliability: {
      ownership: subscriberDiscordOwnershipSummary(env),
      quota: quotaPolicySnapshot(env, nowMs),
      killSwitch: env.OPTIONS_CALLOUTS_KILL === "1",
      ambiguousOpens24h,
    },
    sessionGuard: evaluateMarketSessionGuard(nowMs, env),
    schemaReadiness: db ? (() => {
      const schema = inspectSchemaReadiness(db as any, env);
      return {
        ok: schema.ok,
        missingShadowSoakTables: schema.missingShadowSoakTables,
        missingInstrumentationColumns: schema.missingInstrumentationColumns,
        instrumentationFallbackInserts: readInstrumentationFallbackInserts(),
      };
    })() : undefined,
    evidenceIntegrity: db ? (() => {
      const paper = buildPaperChainDiagnostic(db as any, env, 50);
      const shadow = buildShadowSoakAggregate(db as any, env, 7);
      const quant = buildQuantLaneReport(db as any, env);
      let lastAi: string | null = null;
      let validationFailed24h = 0;
      if (hasTable(db, "ai_job_runs")) {
        lastAi = String((db.prepare(
          "SELECT status FROM ai_job_runs WHERE job_type IN ('weekly_proposals','weekly_proposals_retry') ORDER BY created_at_ms DESC LIMIT 1",
        ).get() as { status?: string } | undefined)?.status ?? null);
        validationFailed24h = Number((db.prepare(
          "SELECT COUNT(*) n FROM ai_job_runs WHERE job_type IN ('weekly_proposals','weekly_proposals_retry') AND status='VALIDATION_FAILED' AND created_at_ms >= ?",
        ).get(since24h) as { n: number })?.n ?? 0);
      }
      const pendingOutcomes = hasTable(db, "options_shadow_outcomes")
        ? Number((db.prepare("SELECT COUNT(*) n FROM options_shadow_outcomes WHERE data_status='PENDING'").get() as { n: number })?.n ?? 0)
        : 0;
      return {
        paperChain: {
          paperLinkRate: paper.paperLinkRate,
          unhealthyRows: paper.rows.filter((r) => r.graderHealth !== "healthy").length,
          sent24h: paper.sent24h,
        },
        shadowGrader: {
          pendingOutcomes,
          missingDataPct: shadow.missingDataPct,
          wouldSend: shadow.wouldSend,
          wouldBlock: shadow.wouldBlock,
        },
        quantLanes: {
          lanesWithEvidence: quant.lanes.filter((l) => !l.insufficientEvidence).length,
          lanesInsufficient: quant.lanes.filter((l) => l.insufficientEvidence).length,
        },
        aiWeekly: { lastStatus: lastAi, validationFailed24h },
      };
    })() : undefined,
  };
}

/** Strip any secret-like substrings from diagnostic output */
export function sanitizeDiagnosticForResponse(d: WhyNoAlertsDiagnostic): WhyNoAlertsDiagnostic {
  const strip = (s: string) => s.replace(/api[_-]?key[=:\s][^\s]+/gi, "[REDACTED]").replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
  return {
    ...d,
    summary: strip(d.summary),
    likelyBlockers: d.likelyBlockers.map(strip),
    rejectionReasons: d.rejectionReasons.map((r) => ({ ...r, code: strip(r.code) })),
  };
}
