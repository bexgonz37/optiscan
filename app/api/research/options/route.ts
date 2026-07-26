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
    deliveryDecisions: { enabled: process.env.OPTIONS_PORTFOLIO_DELIVERY_ENABLED === "1", ...(await import("@/lib/research/options/delivery-decision")).deliveryDecisionMetricsOnDb(db) },
    delivery: { enabled: f.independentOptionsDiscovery && f.earlyOptionsCallouts, webhookConfigured: Boolean(String(process.env.DISCORD_WEBHOOK_OPTIONS ?? "").trim()), ...readDeliveryMetricsOnDb(db) },
    report: readOptionsReportOnDb(db),
  });
}

/** Operator tests (token-gated):
 *  - action=transport_test: ONE synthetic connectivity message (no paper/performance).
 *  - action=lifecycle_smoke: full Opportunity Case open→suppress→milestone→close path.
 *    HARD gated by OPTIONS_LIFECYCLE_SMOKE=1.
 */
export async function POST(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const action = String(body.action ?? "").toLowerCase();
  if (action === "transport_test") {
    const { optionsWebhookTransportTest } = await import("@/lib/research/options/delivery");
    const result = await optionsWebhookTransportTest();
    return NextResponse.json({ ok: result.ok, result });
  }
  if (action === "lifecycle_smoke") {
    const { getDb } = await import("@/lib/db");
    const { runOpportunityLifecycleSmoke } = await import("@/lib/research/options/lifecycle-smoke");
    const result = await runOpportunityLifecycleSmoke({ getDb });
    return NextResponse.json({ ok: result.ok, result }, { status: result.ok ? 200 : 409 });
  }
  return NextResponse.json({ ok: false, error: "action must be 'transport_test' or 'lifecycle_smoke'" }, { status: 400 });
}
