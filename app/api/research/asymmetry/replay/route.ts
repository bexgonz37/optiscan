import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET — private, read-only High-Asymmetry replay diagnostics.
 *
 * Token-gated. Performs SELECTs only: no writes, no migrations, no provider
 * calls, no scheduler participation, and no authority to change live
 * behaviour. Nothing here can send an alert.
 *
 * Query:
 *   ?dates=YYYY-MM-DD,YYYY-MM-DD   explicit sessions (default: most recent)
 *   &sessions=N                    how many recent sessions to discover
 *   &limit=N                       detail rows returned
 *   &identity=OCC_SESSION_FIRST_OBSERVATION | OCC_SESSION_CLUSTER | OCC_SESSION_FINGERPRINT
 *   &at=<ms>                       evidence horizon, for a reproducible run
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const intParam = (name: string, fallback: number, min: number, max: number): number => {
      const value = Number(url.searchParams.get(name));
      return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
    };

    const dates = (url.searchParams.get("dates") ?? "")
      .split(",").map((day) => day.trim()).filter(Boolean);
    const identity = url.searchParams.get("identity");
    const at = Number(url.searchParams.get("at"));

    const { getDb } = await import("@/lib/db");
    const { runAsymmetryReplayOnDb, replayCoverageSummary } = await import("@/lib/research/asymmetry/replay");
    const { CANDIDATE_IDENTITY_STRATEGIES } = await import("@/lib/research/asymmetry/identity");
    const { rankMissingSources } = await import("@/lib/research/asymmetry/source-priority");

    const identityStrategy = CANDIDATE_IDENTITY_STRATEGIES.includes(identity as never)
      ? (identity as (typeof CANDIDATE_IDENTITY_STRATEGIES)[number])
      : undefined;

    const result = runAsymmetryReplayOnDb(getDb() as any, {
      sessionDates: dates.length ? dates : undefined,
      maxSessions: intParam("sessions", 5, 1, 90),
      detailLimit: intParam("limit", 50, 1, 500),
      evaluationAtMs: Number.isFinite(at) ? at : undefined,
      identityStrategy,
    });

    return NextResponse.json({
      ok: true,
      readOnly: true,
      shadowOnly: true,
      writesPerformed: result.writesPerformed,
      phase: "PHASE_2_REAL_DATA_REPLAY",

      evaluationAtMs: result.evaluationAtMs,
      identityStrategy: result.identityStrategy,
      sessionsAvailableInDb: result.sessionsAvailableInDb,
      sessionsRequested: result.sessionsRequested,
      sessionsWithData: result.sessionsWithData,

      dataCoverage: {
        totalObservations: result.coverage.totalObservations,
        observationsWithoutContract: result.coverage.observationsWithoutContract,
        distinctOccContracts: result.coverage.distinctOccContracts,
        distinctCandidateDetections: result.coverage.distinctCandidateDetections,
        distinctTradingSessions: result.coverage.distinctTradingSessions,
        distinctSymbols: result.coverage.distinctSymbols,
        candidatesWithFreshAskEntry: result.coverage.candidatesWithFreshAskEntry,
        candidatesWithSubsequentFreshBidMarks: result.coverage.candidatesWithSubsequentFreshBidMarks,
        gradeableByHorizon: result.coverage.gradeableByHorizon,
        candidatesWithMfeEvidence: result.coverage.candidatesWithMfeEvidence,
        candidatesWithMaeEvidence: result.coverage.candidatesWithMaeEvidence,
        candidatesWithPremiumChaseBaseline: result.coverage.candidatesWithPremiumChaseBaseline,
        gradeableCandidates: result.coverage.gradeableCandidates,
        ungradeableCandidates: result.coverage.ungradeableCandidates,
        sharePct: replayCoverageSummary(result),
        notes: result.coverage.notes,
      },
      exclusions: result.coverage.exclusions,

      cohortCounts: result.report.cohortComparison.cohortSizes,
      outcomeCounts: result.report.outcomeCounts,
      outsizedCount: result.report.outsizedCount,
      researchStateCounts: result.report.stateCounts,
      premiumChaseDistribution: result.report.premiumChaseDistribution,

      duplicateAudit: {
        contractsExamined: result.duplicateAudit.contractsExamined,
        contractsWithMultipleObservations: result.duplicateAudit.contractsWithMultipleObservations,
        contractsWithMultipleClustersByGapMs: result.duplicateAudit.contractsWithMultipleClustersByGapMs,
        contractsWithMultipleFingerprints: result.duplicateAudit.contractsWithMultipleFingerprints,
        rowsCarryingFingerprint: result.duplicateAudit.rowsCarryingFingerprint,
        candidateCountByStrategy: result.duplicateAudit.candidateCountByStrategy,
        candidatesWithVacuousPremiumChase: result.duplicateAudit.candidatesWithVacuousPremiumChase,
        recommendation: result.duplicateAudit.recommendation,
        recommendationReason: result.duplicateAudit.recommendationReason,
        contracts: result.duplicateAudit.contracts,
        notes: result.duplicateAudit.notes,
      },

      recentReplayRows: result.rows,
      sourcePriority: rankMissingSources(result.coverage, result.report.coverage.missingByField),
      knownUnsourcedFields: result.knownUnsourcedFields,
      warnings: result.warnings,
      notes: result.notes,
      limitations: result.report.limitations,

      safety: {
        advisoryOnly: true,
        productionBehaviorChanged: false,
        canSend: false,
        isSubscriberPerformance: false,
        note: "Read-only replay of persisted evidence. These are NOT subscriber performance results, NOT predictions, and NOT an indication that any candidate will produce a gain. Zero gradeable candidates means evidence is absent, not that a strategy performed at zero.",
      },
    }, { status: 200 });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
