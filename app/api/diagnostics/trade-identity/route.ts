import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/diagnostics/trade-identity — proves, per Opportunity Case, that every
 * performance number was observed on the ONE contract the case froze its entry on.
 *
 * The invariant: ONE CASE PERFORMANCE IDENTITY = ONE FROZEN OCC. A case may observe
 * many candidate contracts as its thesis lives on; those are alternate observations,
 * never this trade's performance trajectory.
 *
 *   ?caseId=oc_x[,oc_y]  reconcile specific cases
 *   ?days=N              window (default 30)
 *   ?limit=N             cap (default 200, max 2000)
 *   ?scope=delivered|all delivered is the default — the scanner creates thousands of
 *                        undelivered candidate cases a day, and auditing those reports
 *                        a clean bill of health for rows that never carried a number
 *   ?only=contaminated   return only cases that fail the invariant
 *
 * Reads PERSISTED evidence only. No provider call, no quota spend, no send authority.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const { getDb } = await import("@/lib/db");
    const { reconcileRecentTradeIdentitiesOnDb, summarizeTradeIdentities } = await import(
      "@/lib/opportunity-case/trade-identity"
    );

    const caseIdParam = url.searchParams.get("caseId");
    const caseIds = caseIdParam
      ? caseIdParam.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    const days = Math.max(1, Math.min(365, Number(url.searchParams.get("days") ?? 30)));
    const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get("limit") ?? 200)));
    const only = url.searchParams.get("only");
    const scope = url.searchParams.get("scope") === "all" ? "all" : "delivered";

    const db = getDb() as any;
    const all = reconcileRecentTradeIdentitiesOnDb(db, {
      caseIds,
      sinceMs: caseIds ? null : Date.now() - days * 86_400_000,
      limit,
      scope,
    });
    const summary = summarizeTradeIdentities(all);
    const reports = only === "contaminated"
      ? all.filter((r) => r.verdict === "CROSS_CONTRACT_CONTAMINATION" || r.verdict === "OCC_MISMATCH")
      : all;

    return NextResponse.json({
      ok: true,
      scope: caseIds ? { caseIds } : { days, limit, population: scope },
      summary,
      reports,
      note:
        "Persisted evidence only. SAME_OCC_VERIFIED is the ONLY verdict that permits a numeric "
        + "performance claim. IDENTITY_UNVERIFIABLE means the evidence is absent, not that the trade was flat.",
    });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
