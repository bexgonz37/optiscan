import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Broad Discovery + Analog Shadow Bridge dashboard (read-only, token-gated). Reports what the
 * shadow layers have recorded — discovery coverage + rejection reasons, analog agree/disagree/abstain
 * rates + lookup latency, and market-context regime distribution — plus the flag state. SHADOW-ONLY:
 * nothing here is actionable and no alert is ever sent from this data.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  const { getDb } = await import("@/lib/db");
  const { readShadowReportOnDb } = await import("@/lib/research/shadow/store");
  const { researchFlags } = await import("@/lib/research/flags");
  const f = researchFlags(process.env);
  return NextResponse.json({
    ok: true,
    flags: { broadDiscoveryShadow: f.broadDiscoveryShadow, analogLiveShadow: f.analogLiveShadow, marketContextCapture: f.marketContextCapture },
    report: readShadowReportOnDb(getDb()),
  });
}
