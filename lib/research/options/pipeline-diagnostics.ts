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
  delivery: { decisions24h: Record<string, number>; sent24h: number; failed24h: number; duplicate24h: number; metrics?: Record<string, unknown> };
  provider: { failures: number; breakerOpen: boolean; staleBars: number };
  discord: { webhookConfigured: boolean; recentFailures: number };
  latency: { detectionToDecisionP50: number | null; detectionToDecisionP95: number | null };
  opportunityCases: Record<string, number>;
  rejectionReasons: { code: string; count: number }[];
}

function hasTable(db: DiagDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(name));
  } catch {
    return false;
  }
}

export function buildWhyNoAlertsDiagnostic(db: DiagDb | null, env: NodeJS.ProcessEnv = process.env, nowMs = Date.now()): WhyNoAlertsDiagnostic {
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

  const decisions24h: Record<string, number> = {};
  if (db) {
    const dm = deliveryDecisionMetricsOnDb(db as any);
    if (dm.byOutcome) {
      for (const [k, v] of Object.entries(dm.byOutcome)) decisions24h[k] = Number(v);
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
    delivery: { decisions24h, sent24h, failed24h, duplicate24h, metrics: deliveryMetrics },
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
