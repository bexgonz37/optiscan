import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/performance/statistics — the AUTHORITATIVE statistics layer (Phase 2),
 * computed only from paper_trade_outcomes. Read-only + idempotent refresh. No
 * guarantees language; evidence states gate every trustworthy claim.
 *
 * ?kind=strategy|session|fingerprint|tod_bucket|dte_bucket|... filters the cuts.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();

  const { syncPaperOutcomes } = await import("@/lib/outcome-store");
  const { refreshStatistics, listStatistics } = await import("@/lib/statistics-store");
  const { STATISTICS_VERSION } = await import("@/lib/setup-statistics");

  // Grade any newly-terminal trades, then refresh the materialized cache.
  syncPaperOutcomes();
  const refresh = refreshStatistics();

  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") ?? undefined;
  const overall = listStatistics("overall")[0] ?? null;
  const stats = listStatistics(kind);

  return NextResponse.json({
    ok: true,
    statisticsVersion: STATISTICS_VERSION,
    refresh,
    overall,
    stats,
    disclaimer: "Research / paper-trading statistics only. Past results do not guarantee future performance.",
  });
}
