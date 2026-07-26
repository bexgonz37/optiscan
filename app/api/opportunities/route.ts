import { NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-route-auth";
import { ensureServerBoot } from "@/lib/server-boot";
import { groupedOpportunities, listOpportunities } from "@/lib/opportunity-store";
import { explanationForOpportunity } from "@/lib/explanation-adapters";
import type { OpportunityRecord } from "@/lib/opportunity-lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireApiToken(req);
  if (denied) return denied;
  ensureServerBoot();
  try {
    const all = listOpportunities();
    const buckets = groupedOpportunities();
    const byId = new Map<string, ReturnType<typeof explanationForOpportunity>>();
    const withExplanation = (r: OpportunityRecord) => {
      let exp = byId.get(r.opportunity_id);
      if (!exp) { exp = explanationForOpportunity(r); byId.set(r.opportunity_id, exp); }
      return { ...r, explanation: exp };
    };
    const opportunities = all.map(withExplanation);
    const bucketsOut: Record<string, unknown[]> = {};
    for (const [k, rows] of Object.entries(buckets)) bucketsOut[k] = rows.map(withExplanation);
    return NextResponse.json({ ok: true, count: all.length, buckets: bucketsOut, opportunities });
  } catch (err: unknown) {
    return NextResponse.json({ ok: false, error: (err as Error)?.message ?? "opportunities unavailable" }, { status: 500 });
  }
}
