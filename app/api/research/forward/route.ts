import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Phase-F product-readiness report (forward validation + two-speed alert latency). Token-gated,
 * READ-ONLY. Returns an honest COLLECTING_DATA report until there is a real forward sample AND a
 * measured production-latency sample; it never claims the latency targets or edge are met on
 * synthetic/backtest data. Also reports flag state so an operator can see whether capture is live.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  const { getDb } = await import("@/lib/db");
  const { readForwardReportOnDb } = await import("@/lib/research/forward/read");
  const { researchFlags } = await import("@/lib/research/flags");
  const f = researchFlags(process.env);
  const report = readForwardReportOnDb(getDb());
  return NextResponse.json({
    ok: true,
    flags: { forwardCapture: f.forwardCapture, twoSpeedAlerts: f.twoSpeedAlerts },
    report,
  });
}
