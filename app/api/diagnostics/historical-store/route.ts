import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/diagnostics/historical-store — what the DURABLE historical store actually
 * holds, plus the state of the ingestion lane that fills it.
 *
 * Distinct from /api/diagnostics/data-truth, which answers the broader
 * "provider vs OptiScan" question. This one is about the new store specifically: how
 * much is possessed, which jobs are resumable, and whether mining is currently allowed
 * to run at all.
 *
 * Read-only: no provider call, no quota spend, no writes, no send authority.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const { getDb } = await import("@/lib/db");
    const { historicalCoverageOnDb, listIngestProgressOnDb } = await import("@/lib/research/historical/store");
    const { historicalIngestionSessionGate, TIER_1_SYMBOLS } = await import("@/lib/research/historical/ingestion");

    const db = getDb() as any;
    const nowMs = Date.now();
    const gate = historicalIngestionSessionGate(nowMs, process.env);
    const verbose = url.searchParams.get("verbose") === "1";
    const progress = listIngestProgressOnDb(db, { limit: verbose ? 500 : 50 });

    const byStatus: Record<string, number> = {};
    for (const p of progress) byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;

    return NextResponse.json({
      ok: true,
      coverage: historicalCoverageOnDb(db),
      ingestion: {
        gate,
        tier1Symbols: TIER_1_SYMBOLS,
        jobs: progress.length,
        byStatus,
        resumable: progress.filter((p) => p.status !== "COMPLETE").length,
        progress: verbose ? progress : progress.slice(0, 25),
      },
      note:
        "Counts are STORED ROWS in this database — possession, not entitlement. The ingestion gate "
        + "REFUSES during REGULAR_SESSION, OPENING_DISCOVERY and POWER_HOUR: the live scanner has "
        + "provider priority, and a refusal is not a throttle. Every job persists a cursor, so a "
        + "blocked or timed-out run resumes rather than restarts. Nothing in this store is read by "
        + "any gate, threshold, ranking weight, stop or exit.",
    });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
