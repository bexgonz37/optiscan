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
  return NextResponse.json({
    ok: true,
    flags: { independentOptionsDiscovery: f.independentOptionsDiscovery, earlyOptionsCallouts: f.earlyOptionsCallouts, realOptionPaper: f.realOptionPaper },
    monitor: { ...optionsMonitorMetrics(), health: optionsMonitorHealth(process.env), activePaperPositions },
    report: readOptionsReportOnDb(db),
  });
}
