import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/diagnostics/historical-digest — whether the drafts held back from
 * individual Discord delivery are actually being consumed.
 *
 * `/api/diagnostics/content-delivery` answers "did the flood stop?" It counted
 * `HELD_FOR_HISTORICAL_DIGEST: 30` and reported the backlog as drained — which
 * was true about Discord and silent about the owner. Held is not consumed. This
 * endpoint answers the other half: how many outcomes those held rows collapse
 * to, how many are digest-ready, how many are excluded and why, and whether any
 * digest has ever been generated or delivered.
 *
 * Read-only. Builds a candidate digest in memory to count, persists nothing,
 * sends nothing, and issues no provider call.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const { buildDigestDiagnostics, readHeldDraftRows, priorDigestOutcomeIds, casesWithDeliveredReportCard } =
      await import("@/lib/content/historical-digest-runtime");
    const { buildHistoricalDigest } = await import("@/lib/content/historical-digest");
    const { getDb } = await import("@/lib/db");
    const { schedulerState } = await import("@/lib/scheduler");

    const db = getDb() as never;
    const nowMs = Date.now();
    const diagnostics = buildDigestDiagnostics(db, process.env, nowMs);

    // The candidate digest is rebuilt here so exclusions can be reported WITH
    // their reasons. A count of "excluded: 4" without the reasons is exactly the
    // shape that lets "already delivered" and "deferred by the cap" read alike.
    const candidate = buildHistoricalDigest({
      rows: readHeldDraftRows(db, { includeArchive: false }),
      nowMs,
      priorDigestOutcomeIds: priorDigestOutcomeIds(db),
      casesWithDeliveredReportCard: casesWithDeliveredReportCard(db),
      env: process.env,
    });
    const exclusionsByReason: Record<string, number> = {};
    for (const e of candidate.excluded) {
      exclusionsByReason[e.reason] = (exclusionsByReason[e.reason] ?? 0) + 1;
    }

    const sched = schedulerState();
    return NextResponse.json({
      ok: true,
      diagnostics,
      candidate: {
        digestId: candidate.digestId,
        coveredFromMs: candidate.coveredFromMs,
        coveredToMs: candidate.coveredToMs,
        stats: candidate.stats,
        hasMore: candidate.hasMore,
        remainingOutcomes: candidate.remainingOutcomes,
        exclusionsByReason,
        included: candidate.included.map((o) => ({
          outcomeId: o.outcomeId,
          opportunityCaseId: o.opportunityCaseId,
          symbol: o.symbol,
          occ: o.occ,
          contractLabel: o.contractLabel,
          result: o.result,
          returnPercent: o.returnPercent,
          maxReturnPercent: o.maxReturnPercent,
          causeCode: o.causeCode,
          causeProvable: o.causeProvable,
          evidenceQuality: o.evidenceQuality,
          collapsedVariantCount: o.collapsedVariantCount,
          draftIds: o.draftIds,
          contentEventIds: o.contentEventIds,
        })),
        excluded: candidate.excluded.map((e) => ({
          outcomeId: e.outcomeId, reason: e.reason, explanation: e.explanation, draftIds: e.draftIds,
        })),
      },
      lastScan: (sched.lastContentDrafts as { digest?: unknown } | null)?.digest ?? null,
      note: "Historical learning digest. Owner-only, never auto-posted to public social media. Read-only endpoint.",
    });
  } catch (e) {
    return jsonFromRouteError(e);
  }
}
