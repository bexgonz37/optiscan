import { NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-route-auth";
import { ensureServerBoot } from "@/lib/server-boot";
import { hasPolygon } from "@/lib/polygon-provider";
import { discordWebhookConfigured } from "@/lib/notifications";
import { subscriberDiscordOwnershipSummary } from "@/lib/subscriber-discord-owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/command-center — canonical homepage snapshot for Independent Options ops.
 * Token-gated. Composes overview-independent health, pipeline-health, readiness,
 * paper-chain launch sample, and content counters so the UI never mixes stale
 * unauthenticated overview with authenticated readiness.
 */
export async function GET(req: Request) {
  const denied = requireApiToken(req);
  if (denied) return denied;
  ensureServerBoot();
  const now = Date.now();
  const faults: string[] = [];
  const safe = <T,>(label: string, fn: () => T, fallback: T): T => {
    try { return fn(); } catch (err: any) {
      faults.push(`${label}: ${String(err?.message ?? err).slice(0, 160)}`);
      return fallback;
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDb } = require("@/lib/db");
  const db = safe("db", () => getDb(), null);

  const ownership = subscriberDiscordOwnershipSummary();
  const independent = safe("independent", () => {
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
    const monitor = optionsMonitorHealth(process.env, now);
    const metrics = optionsMonitorMetrics();
    const sessionGuard = evaluateMarketSessionGuard(now, process.env);
    const runtimeStatus = db ? readRuntimeStatusOnDb(db, process.env, now) : null;
    const hb = (runtimeStatus?.heartbeat ?? null) as Record<string, unknown> | null;
    const selfCheck = (runtimeStatus?.selfCheck ?? null) as { items?: { name: string; ok: boolean }[] } | null;
    let recentSentCount24h: number | null = null;
    if (db) {
      try {
        recentSentCount24h = Number((db.prepare(
          "SELECT COUNT(*) n FROM options_alerts WHERE state='SENT' AND research_only=0 AND sent_at_ms >= ?",
        ).get(now - 24 * 3600_000) as { n?: number })?.n ?? 0);
      } catch { /* optional */ }
    }
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
      selfCheckPolygonOk: selfCheck?.items?.find((i) => i.name === "polygonApiKey")?.ok ?? null,
      webhookConfigured: discordWebhookConfigured("options"),
      recentSentCount24h,
    });
    return { ...health, metrics, portfolioDelivery: monitor.portfolioDelivery };
  }, null);

  const pipeline = safe("pipeline", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildWhyNoAlertsDiagnostic } = require("@/lib/research/options/pipeline-diagnostics");
    // Must pass the DB handle (same as /api/research/options/pipeline-health), not a deps bag.
    return buildWhyNoAlertsDiagnostic(db, process.env, now);
  }, null);

  const readiness = safe("readiness", () => {
    if (!db) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { evaluateSubscriberReadiness } = require("@/lib/research/subscriber-readiness");
    return evaluateSubscriberReadiness(db, process.env, now);
  }, null);

  const paper = safe("paper", () => {
    if (!db) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readinessSampleCutoffMs } = require("@/lib/research/readiness-sample");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildPaperChainDiagnostic } = require("@/lib/research/options/paper-chain");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { optionsGraderState, readGradingBacklogOnDb } = require("@/lib/research/options/grade");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { aggregatePaperSample } = require("@/lib/dashboard/command-center-view");
    const cutoff = readinessSampleCutoffMs(process.env);
    const chain = buildPaperChainDiagnostic(db, process.env, 40, cutoff);
    const grader = optionsGraderState();
    const backlog = readGradingBacklogOnDb(db);
    const open = chain.rows.filter((r: any) => r.paperStatus === "ENTERED");
    const closed = chain.rows.filter((r: any) => r.paperStatus === "EXITED");
    const sample = aggregatePaperSample(chain.rows);

    // Read-only equity series from closed delivered mirrors (cumulative return %).
    let equityCurve: { t: number; equityPct: number; symbol?: string }[] = [];
    try {
      const exits = db.prepare(
        `SELECT p.exited_at_ms AS t, p.return_pct AS ret, a.candidate_symbol AS symbol
           FROM options_paper_trades p
           LEFT JOIN options_alerts a ON a.alert_id = p.alert_id
          WHERE p.paper_kind='DELIVERED_ALERT_PAPER' AND p.status='EXITED'
            AND p.return_pct IS NOT NULL AND p.exited_at_ms IS NOT NULL
          ORDER BY p.exited_at_ms ASC
          LIMIT 80`,
      ).all() as { t: number; ret: number; symbol?: string }[];
      let cum = 0;
      equityCurve = exits.map((e) => {
        cum += Number(e.ret);
        return { t: Number(e.t), equityPct: +cum.toFixed(4), symbol: e.symbol };
      });
    } catch { /* optional */ }

    return {
      cutoffMs: cutoff,
      openDelivered: open.length,
      closedInSample: closed.length,
      rows: chain.rows,
      paperLinkRate: chain.paperLinkRate,
      sent24h: chain.sent24h,
      linked24h: chain.linked24h,
      grader: {
        running: grader.running,
        lastCycleMs: grader.lastCycleMs,
        lastCycleAgeMs: grader.lastCycleMs != null ? Math.max(0, now - grader.lastCycleMs) : null,
        cycles: grader.cycles,
        errors: grader.errors,
      },
      backlog,
      unhealthy: chain.rows.filter((r: any) => r.graderHealth === "stuck_open" || r.graderHealth === "missing_case" || r.graderHealth === "missing_mirror").length,
      sample,
      equityCurve,
    };
  }, null);

  const content = safe("content", () => {
    const enabled = process.env.CONTENT_EVENTS_ENABLED === "1";
    const webhook = discordWebhookConfigured("content") || Boolean(String(process.env.DISCORD_WEBHOOK_CONTENT ?? "").trim());
    let pending = 0;
    let drafts = { total: 0, delivered: 0, skipped: 0, pending: 0 };
    if (db) {
      try {
        pending = Number((db.prepare(
          "SELECT COUNT(*) n FROM opportunity_content_events WHERE content_status='PENDING'",
        ).get() as { n?: number })?.n ?? 0);
      } catch { /* optional */ }
      try {
        const rows = db.prepare(
          "SELECT discord_delivery_status AS st, COUNT(*) n FROM content_drafts GROUP BY discord_delivery_status",
        ).all() as { st: string; n: number }[];
        for (const r of rows) {
          drafts.total += Number(r.n);
          const st = String(r.st ?? "").toUpperCase();
          if (st === "SENT" || st === "DELIVERED") drafts.delivered += Number(r.n);
          else if (st.includes("SKIP")) drafts.skipped += Number(r.n);
          else drafts.pending += Number(r.n);
        }
      } catch { /* optional */ }
    }
    let latest: Record<string, unknown> | null = null;
    if (db) {
      try {
        latest = db.prepare(
          "SELECT draft_id, category, status, discord_delivery_status, created_at_ms FROM content_drafts ORDER BY created_at_ms DESC LIMIT 1",
        ).get() as Record<string, unknown> | undefined ?? null;
      } catch { /* optional */ }
    }
    return { enabled, webhookConfigured: webhook, pendingEvents: pending, drafts, latest };
  }, null);

  const ai = safe("ai", () => {
    if (!db) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { aiOverviewOnDb } = require("@/lib/ai/overview");
    const ov = aiOverviewOnDb(db, process.env, now);
    const pending = ov.proposals?.pending ?? [];
    const latestWeekly = ov.weeklyHistory?.[0] ?? null;
    const latestRec = pending[0] ?? ov.proposals?.accepted?.[0] ?? null;
    return {
      nightlyStatus: ov.schedule?.lastNightlyStatus ?? null,
      nightlyAtMs: ov.schedule?.lastNightlyAtMs ?? null,
      nightlyDay: ov.schedule?.lastNightlyDay ?? null,
      weeklyStatus: latestWeekly?.narrativeStatus ?? null,
      weeklyAtMs: latestWeekly?.createdAtMs ?? null,
      pendingApproval: pending.length,
      latestRecommendation: latestRec
        ? {
            id: latestRec.id,
            title: latestRec.title ?? null,
            status: latestRec.status ?? null,
          }
        : null,
      evidenceSampleSize: Number(ov.evidenceLearning?.examples?.total ?? 0) || null,
      enabled: Boolean(ov.flags?.enabled),
    };
  }, null);

  const zeroDteResearch = safe("zeroDteResearch", () => {
    if (!db) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildZeroDteResearchSnapshot, zeroDteResearchConfig } = require("@/lib/research/options/zero-dte-research");
    const cfg = zeroDteResearchConfig(process.env);
    const snap = buildZeroDteResearchSnapshot(db, process.env, now);
    return {
      enabled: cfg.enabled,
      label: snap.label,
      account: snap.account,
      today: snap.today,
      bestOpen: snap.bestOpen,
      worstOpen: snap.worstOpen,
      openCount: snap.openPositions?.length ?? 0,
      winRate: snap.performance?.winRate ?? null,
      profitFactor: snap.performance?.profitFactor ?? null,
      equityCurve: snap.equityCurve ?? null,
      openRiskUsd: snap.account?.openRiskUsd ?? null,
    };
  }, null);

  const rankedSetups = safe("rankedSetups", () => {
    if (!db) return [];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildRankedSetupsNow } = require("@/lib/research/options/ranked-setups");
    return buildRankedSetupsNow(db, now, 12);
  }, []);

  const indices = safe("indices", () => {
    // Prefer last known underlying from open paper / alerts — never fabricate live Massive quotes here.
    if (!db) return { spy: null, qqq: null };
    const lastUnd = (sym: string) => {
      let price: number | null = null;
      let asOfMs: number | null = null;
      let source: "paper_cache" | "alert_cache" | "unavailable" = "unavailable";
      try {
        const row = db.prepare(
          `SELECT underlying_price p, updated_at_ms t FROM options_paper_trades
           WHERE option_symbol LIKE ? AND underlying_price IS NOT NULL
           ORDER BY updated_at_ms DESC LIMIT 1`,
        ).get(`O:${sym}%`) as { p: number; t: number } | undefined;
        if (row?.p != null) {
          price = Number(row.p);
          asOfMs = Number(row.t);
          source = "paper_cache";
        }
      } catch { /* */ }
      if (price == null) {
        try {
          const row = db.prepare(
            `SELECT delivered_underlying p, COALESCE(sent_at_ms, updated_at_ms) t FROM options_alerts
             WHERE candidate_symbol=? AND delivered_underlying IS NOT NULL
             ORDER BY COALESCE(sent_at_ms, updated_at_ms) DESC LIMIT 1`,
          ).get(sym) as { p: number; t: number } | undefined;
          if (row?.p != null) {
            price = Number(row.p);
            asOfMs = Number(row.t);
            source = "alert_cache";
          }
        } catch { /* */ }
      }
      let spark: number[] = [];
      try {
        spark = (db.prepare(
          `SELECT delivered_underlying p FROM options_alerts
           WHERE candidate_symbol=? AND delivered_underlying IS NOT NULL
           ORDER BY COALESCE(sent_at_ms, updated_at_ms) ASC LIMIT 24`,
        ).all(sym) as { p: number }[]).map((r) => Number(r.p)).filter(Number.isFinite);
      } catch { /* */ }
      return {
        symbol: sym,
        price,
        asOfMs,
        source,
        spark,
        // Derived UI states from cached pipeline — not live Massive tape.
        momentum: spark.length >= 2 ? (spark[spark.length - 1]! >= spark[0]! ? "UP" : "DOWN") : "UNKNOWN",
        volumeState: "UNAVAILABLE",
        volatilityState: "UNAVAILABLE",
        vwapRelation: "UNAVAILABLE",
      };
    };
    return { spy: lastUnd("SPY"), qqq: lastUnd("QQQ") };
  }, { spy: null, qqq: null });

  const quantSummary = safe("quantSummary", () => {
    if (!db) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildQuantLaneReport } = require("@/lib/research/options/quant-lanes");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildQuantLabSnapshot } = require("@/lib/research/options/quant-lab");
    const report = buildQuantLaneReport(db, process.env);
    const delivered = report.lanes.find((l: { lane: string }) => l.lane === "delivered_alert_paper") ?? null;
    const zeroDte = report.lanes.find((l: { lane: string }) => l.lane === "zero_dte_research_paper") ?? null;
    let pulse: Record<string, unknown> | null = null;
    try {
      const lab = buildQuantLabSnapshot(db, process.env);
      const lane = lab?.lanes?.delivered ?? lab;
      const fam = lane?.breakdowns?.strategyFamily ?? [];
      const tod = lane?.breakdowns?.timeOfDay ?? [];
      const best = [...fam].sort((a: any, b: any) => (b.expectancy ?? -999) - (a.expectancy ?? -999))[0];
      const worst = [...fam].sort((a: any, b: any) => (a.expectancy ?? 999) - (b.expectancy ?? 999))[0];
      const bestBucket = [...tod].sort((a: any, b: any) => (b.expectancy ?? -999) - (a.expectancy ?? -999))[0];
      pulse = {
        expectancy: lane?.metrics?.expectancy ?? delivered?.expectancy ?? null,
        profitFactor: lane?.metrics?.profitFactor ?? delivered?.profitFactor ?? null,
        captureEfficiency: lane?.metrics?.captureEfficiency ?? null,
        bestStrategy: best?.key ?? null,
        worstStrategy: worst?.key ?? null,
        bestTimeBucket: bestBucket?.key ?? null,
        sampleSize: lane?.sampleSize ?? delivered?.sampleSize ?? null,
        confidence: lane?.confidence ?? delivered?.confidence ?? null,
      };
    } catch { /* optional */ }
    return {
      generatedAtMs: report.generatedAtMs,
      delivered: delivered
        ? {
            sampleSize: delivered.sampleSize,
            winRate: delivered.winRate,
            expectancy: delivered.expectancy,
            profitFactor: delivered.profitFactor,
            confidence: delivered.confidence,
            mfeAvg: delivered.mfeAvg,
            maeAvg: delivered.maeAvg,
          }
        : null,
      zeroDteResearch: zeroDte
        ? {
            sampleSize: zeroDte.sampleSize,
            winRate: zeroDte.winRate,
            expectancy: zeroDte.expectancy,
            profitFactor: zeroDte.profitFactor,
            confidence: zeroDte.confidence,
          }
        : null,
      pulse,
      href: "/quant",
    };
  }, null);

  const providerBudget = safe("providerBudget", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { estimateMassiveRequestBudget } = require("@/lib/research/options/provider-budget");
    return estimateMassiveRequestBudget(process.env);
  }, null);

  const commit = safe("commit", () => ({
    commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT ?? null,
    commitShort: String(process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT ?? "").slice(0, 7) || null,
  }), { commit: null, commitShort: null });

  const stock = safe("stock", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loopState } = require("@/lib/scanner-loop");
    const loop = loopState();
    return {
      scannerRunning: Boolean(loop.running),
      supervisorEnabled: process.env.SUPERVISOR_RUNTIME === "1",
      independentOwns: ownership.independentOwns,
    };
  }, { scannerRunning: false, supervisorEnabled: false, independentOwns: ownership.independentOwns });

  return NextResponse.json({
    ok: faults.length === 0,
    faults,
    generatedAtMs: now,
    generatedAtIso: new Date(now).toISOString(),
    sourceEndpoint: "/api/command-center",
    commit: commit.commit,
    commitShort: commit.commitShort,
    independent,
    pipeline: pipeline
      ? {
          summary: pipeline.summary,
          delivery: pipeline.delivery,
          candidates: pipeline.candidates,
          monitor: pipeline.monitor,
          rejectionReasons: pipeline.rejectionReasons?.slice?.(0, 5) ?? [],
          lifecycle: pipeline.lifecycle,
        }
      : null,
    readiness: readiness
      ? {
          status: readiness.status,
          ready: readiness.ready,
          metrics: readiness.metrics,
          remainingWarnings: readiness.remainingWarnings,
          blockingGates: readiness.blockingGates,
        }
      : null,
    paper,
    content,
    ai,
    zeroDteResearch,
    rankedSetups,
    indices,
    quantSummary,
    providerBudget,
    stock,
  });
}
