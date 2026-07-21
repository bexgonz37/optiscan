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
  const f = researchFlags(process.env);
  return NextResponse.json({
    ok: true,
    flags: { independentOptionsDiscovery: f.independentOptionsDiscovery, earlyOptionsCallouts: f.earlyOptionsCallouts, realOptionPaper: f.realOptionPaper },
    report: readOptionsReportOnDb(getDb()),
  });
}
