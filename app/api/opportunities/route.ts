import { NextResponse } from "next/server";
import { ensureServerBoot } from "@/lib/server-boot";
import { groupedOpportunities, listOpportunities } from "@/lib/opportunity-store";
import { explanationForOpportunity } from "@/lib/explanation-adapters";
import type { OpportunityRecord } from "@/lib/opportunity-lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/opportunities — persisted opportunity lifecycle for today, grouped
 * into Command Center buckets. Read-only; the scanner loop owns the writes, so
 * this makes no provider calls. Each record carries a deterministic `explanation`
 * (one shared object rendered by both Simple and Advanced desktop modes).
 */
export async function GET() {
  ensureServerBoot();
  try {
    const all = listOpportunities();
    const buckets = groupedOpportunities();
    // Build one explanation per opportunity, reused across the flat list + buckets.
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
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? "opportunities unavailable" }, { status: 500 });
  }
}
