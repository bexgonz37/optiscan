import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Marking-evidence diagnostic: how much of the stored outcome history is a real trajectory
 * and how much is a single mark wearing an excursion's name.
 *
 * Read-only, ZERO provider calls. This is the surface that proves the marking gap and the
 * one that will verify it is fixed during the next open session.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const daysRaw = Number(url.searchParams.get("days"));
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(120, daysRaw) : 45;
    const lane = url.searchParams.get("lane");
    const nowMs = Date.now();

    const { getDb } = await import("@/lib/db");
    const { loadMarkEvidenceOnDb } = await import("@/lib/research/options/mark-evidence-loader");
    const { summariseMarkEvidence, excursionIsTrustworthy, MIN_MARKS_FOR_EXCURSION, EARLY_WINDOW_MS } =
      await import("@/lib/research/options/mark-evidence");
    const { optionsGraderState, graderIntervalMs } = await import("@/lib/research/options/grade");
    const { deployInfo } = await import("@/lib/build-info");

    const db = getDb();
    const rows = loadMarkEvidenceOnDb(db as any, {
      sinceMs: nowMs - days * 86_400_000,
      lane: lane || null,
      limit: 20_000,
    });
    const overall = summariseMarkEvidence(rows);

    // Per strategy AND lane, because the two lanes diverged sharply on expectancy and the
    // marking picture is the first place to look for why.
    const byStrategy: Record<string, any> = {};
    for (const r of rows) {
      const k = `${r.strategy ?? "unknown"}|${r.lane ?? "unknown"}`;
      (byStrategy[k] ??= []).push(r);
    }
    const strategies = Object.entries(byStrategy).map(([k, list]) => {
      const [strategy, laneName] = k.split("|");
      const s = summariseMarkEvidence(list as any);
      return {
        strategy, lane: laneName,
        total: s.total,
        excursionTrustworthy: s.excursionTrustworthy,
        excursionUntrustworthyPct: s.total ? +(s.excursionUntrustworthy / s.total).toFixed(4) : null,
        realizedUsable: s.realizedUsable,
        immediateFailureUsable: s.immediateFailureUsable,
        medianDistinctObservations: s.medianDistinctObservations,
        medianCoverage: s.medianCoverage,
        byState: s.byState,
      };
    }).sort((a, b) => b.total - a.total);

    // Rows whose STORED mfe/mae disagree with what the evidence can actually support.
    const overstated = rows.filter((r) =>
      !excursionIsTrustworthy(r.state) && (r.storedMfePct != null || r.storedMaePct != null));

    return NextResponse.json(
      {
        ok: true,
        readOnly: true,
        providerCallsIssued: 0,
        note: "Persisted evidence only. No provider call, no quota spend, no send authority.",
        generatedAtMs: nowMs,
        windowDays: days,
        deployment: deployInfo(),
        rules: {
          minDistinctObservationsForExcursion: MIN_MARKS_FOR_EXCURSION,
          earlyWindowMs: EARLY_WINDOW_MS,
          why: "MAX and MIN over a single observation are that observation, which is what made MFE equal MAE.",
        },
        grader: { ...optionsGraderState(), intervalMs: graderIntervalMs() },
        overall,
        overstatedExcursionRows: {
          count: overstated.length,
          share: overall.total ? +(overstated.length / overall.total).toFixed(4) : null,
          note: "Rows carrying a stored MFE/MAE that their observation history cannot support.",
          sample: overstated.slice(0, 20).map((r) => ({
            tradeId: r.tradeId, strategy: r.strategy, lane: r.lane, state: r.state,
            markCount: r.markCount, distinctObservationTimes: r.distinctObservationTimes,
            storedMfePct: r.storedMfePct, storedMaePct: r.storedMaePct, returnPct: r.returnPct,
          })),
        },
        byStrategy: strategies,
      },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
