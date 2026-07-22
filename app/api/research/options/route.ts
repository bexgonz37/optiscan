import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Options Opportunity Scanner report (read-only, token-gated). DISTINCT from the Stock Momentum
 * Radar — candidate states, callout outcomes, and paper performance split by strategy / side / DTE /
 * core-vs-broad, with real-option vs modeled outcomes labeled separately. Nothing here is actionable.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  const { getDb } = await import("@/lib/db");
  const { readOptionsReportOnDb } = await import("@/lib/research/options/report");
  const { researchFlags } = await import("@/lib/research/flags");
  const { optionsMonitorMetrics, optionsMonitorHealth } = await import("@/lib/research/options/monitor");
  const f = researchFlags(process.env);
  const db = getDb();
  const activePaperPositions = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='options_paper_trades'").get()
    ? Number((db.prepare("SELECT COUNT(*) n FROM options_paper_trades WHERE status='ENTERED'").get() as any)?.n ?? 0) : 0;
  const { readDeliveryMetricsOnDb } = await import("@/lib/research/options/delivery");
  const { readRuntimeStatusOnDb } = await import("@/lib/research/options/runtime");
  const { readGradingBacklogOnDb, optionsGraderState } = await import("@/lib/research/options/grade");
  return NextResponse.json({
    ok: true,
    flags: { independentOptionsDiscovery: f.independentOptionsDiscovery, earlyOptionsCallouts: f.earlyOptionsCallouts, realOptionPaper: f.realOptionPaper },
    monitor: { ...optionsMonitorMetrics(), health: optionsMonitorHealth(process.env), activePaperPositions },
    grading: { ...readGradingBacklogOnDb(db), grader: optionsGraderState() },
    runtime: readRuntimeStatusOnDb(db, process.env),
    aiResearchQueue: (await import("@/lib/research/options/research-queue")).researchQueueMetricsOnDb(db, process.env),
    delivery: { enabled: f.independentOptionsDiscovery && f.earlyOptionsCallouts, webhookConfigured: Boolean(String(process.env.DISCORD_WEBHOOK_OPTIONS ?? "").trim()), ...readDeliveryMetricsOnDb(db) },
    report: readOptionsReportOnDb(db),
  });
}

/** Operator transport test (token-gated): sends ONE synthetic connectivity message to the options
 *  webhook. No ticker/contract/entry; creates no paper trade or performance record. */
export async function POST(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  if (String(body.action ?? "").toLowerCase() !== "transport_test") {
    return NextResponse.json({ ok: false, error: "action must be 'transport_test'" }, { status: 400 });
  }
  const { optionsWebhookTransportTest } = await import("@/lib/research/options/delivery");
  const result = await optionsWebhookTransportTest();
  return NextResponse.json({ ok: result.ok, result });
}
