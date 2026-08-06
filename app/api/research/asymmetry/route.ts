import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";
import { intParam } from "@/lib/query-params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET — private, read-only High-Asymmetry Radar diagnostics.
 *
 * Token-gated. Performs SELECTs only: no writes, no migrations, no provider
 * calls, no scheduler participation, no Discord configuration of any kind, and
 * no authority to change live behaviour. Nothing here can send an alert.
 *
 * Query: ?date=YYYY-MM-DD  &limit=<recent candidates shown, default 25>
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const date = url.searchParams.get("date") || undefined;
    const recentLimit = intParam(url.searchParams, "limit", 25, 1, 100);

    const { getDb } = await import("@/lib/db");
    const { loadAsymmetryCohortOnDb } = await import("@/lib/research/asymmetry/loader");

    const load = loadAsymmetryCohortOnDb(getDb() as any, { sessionDate: date });
    const { report } = load;

    return NextResponse.json({
      ok: true,
      readOnly: true,
      shadowOnly: true,
      phase: "PHASE_1_RESEARCH_FOUNDATION",
      sessionDate: load.sessionDate,
      evaluationAtMs: load.evaluationAtMs,

      cohortSizes: report.cohortComparison.cohortSizes,
      outcomeCounts: report.outcomeCounts,
      outsizedCount: report.outsizedCount,
      researchStateCounts: report.stateCounts,
      premiumChaseDistribution: report.premiumChaseDistribution,

      dataCoverage: report.coverage,
      knownUnsourcedFields: load.knownUnsourcedFields,
      warnings: load.warnings,

      featureComparison: {
        minimumSupportedSample: report.cohortComparison.minimumSupportedSample,
        outcomeRates: report.cohortComparison.outcomeRates,
        numericFeatures: report.cohortComparison.numericFeatures,
        categoricalFeatures: report.cohortComparison.categoricalFeatures,
        topFeature: report.cohortComparison.topFeature,
        notes: report.cohortComparison.notes,
      },

      // Compact recent rows. Full evidence objects are intentionally not
      // serialized here; this endpoint is for diagnosis, not bulk export.
      recentCandidates: report.candidates.slice(-recentLimit).map((candidate) => ({
        candidateId: candidate.candidateId,
        symbol: candidate.symbol,
        sessionDate: candidate.sessionDate,
        detectionAtMs: candidate.evidence.detectionAtMs,
        timeOfDay: candidate.evidence.timeOfDay,
        setupFamily: candidate.evidence.setupFamily,
        occSymbol: candidate.evidence.occSymbol,
        state: candidate.state,
        stateReason: candidate.stateReason,
        evidenceCoverage: candidate.evidenceCoverage,
        missingFields: candidate.missingFields,
        label: candidate.label,
        cohort: candidate.cohort,
        premiumChaseBucket: candidate.premiumChaseBucket,
        premiumChasePct: candidate.premiumChasePct,
        mfePct: candidate.outcome.mfePct,
        maePct: candidate.outcome.maePct,
        finalVerifiedReturnPct: candidate.outcome.finalVerifiedReturnPct,
        outsizedMoveTiming: candidate.outcome.outsizedMoveTiming,
        usableMarkCount: candidate.outcome.usableMarkCount,
        limitation: candidate.outcome.limitation,
      })),

      limitations: report.limitations,
      safety: {
        advisoryOnly: true,
        productionBehaviorChanged: false,
        canSend: false,
        isSubscriberPerformance: false,
        note: "Research foundation only. These are NOT subscriber performance results, NOT predictions, and NOT an indication that any candidate will produce a gain. No research state can authorize a SEND.",
      },
    }, { status: 200 });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
