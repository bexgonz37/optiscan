import { NextResponse } from "next/server";
import { ensureServerBoot } from "@/lib/server-boot";
import { groupedOpportunities, listOpportunities } from "@/lib/opportunity-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/opportunities — persisted opportunity lifecycle for today, grouped
 * into Command Center buckets. Read-only; the scanner loop owns the writes, so
 * this makes no provider calls.
 */
export async function GET() {
  ensureServerBoot();
  try {
    const all = listOpportunities();
    const buckets = groupedOpportunities();
    return NextResponse.json({ ok: true, count: all.length, buckets, opportunities: all });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? "opportunities unavailable" }, { status: 500 });
  }
}
