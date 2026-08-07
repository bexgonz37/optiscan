import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Owner diagnostic: the frozen lower_high_continuation cohort, the pre-entry winner/loser
 * comparison, and the SHADOW selection experiment measured against it.
 *
 * Read-only, ZERO provider calls, and it authorizes nothing. `productionBehaviorChanged` is
 * a constant false on every response.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const devParam = url.searchParams.get("developmentSessions");

    const { getDb } = await import("@/lib/db");
    const { loadLowerHighCohortOnDb } = await import("@/lib/research/options/lower-high-cohort-loader");
    const { closedRows, performance, classifyLoss, COHORT_ID, MIN_MARKS_FOR_TRAJECTORY } =
      await import("@/lib/research/options/lower-high-cohort");
    const { evaluate, simulate, splitByDate, perSessionEffect, GATES, EXPERIMENT_ID, EXPERIMENT_MODE } =
      await import("@/lib/research/options/selection-experiment");
    const { compareWinnersToLosers } = await import("@/lib/research/options/pre-entry-comparison");
    const { degenerateFeatures, FEATURE_BASIS } = await import("@/lib/research/options/pre-entry-features");
    const { deployInfo } = await import("@/lib/build-info");

    const sha = (() => { try { return deployInfo().commit ?? null; } catch { return null; } })();
    const cohort = loadLowerHighCohortOnDb(getDb() as never, { deploymentSha: sha });
    const closed = closedRows(cohort);

    // Development block defaults to every session before the last three, so the most recent
    // sessions stay untouched validation unless the caller says otherwise.
    const devSessions = devParam
      ? devParam.split(",").map((s) => s.trim()).filter(Boolean)
      : cohort.sessions.slice(0, Math.max(0, cohort.sessions.length - 3));
    const { development, validation } = splitByDate(closed, devSessions);

    const losses = closed.filter((r) => r.outcome === "LOSS");
    const lossTaxonomy: Record<string, number[]> = {};
    for (const r of losses) {
      const { cause } = classifyLoss(r);
      (lossTaxonomy[cause] ??= []).push(r.paperTradeId);
    }

    return NextResponse.json(
      {
        ok: true,
        readOnly: true,
        providerCallsIssued: 0,
        productionBehaviorChanged: false,
        note: "Persisted evidence only. Shadow experiment. No send, paper, or threshold authority.",
        generatedAtMs: Date.now(),
        deploymentSha: sha,

        cohort: {
          cohortId: COHORT_ID,
          strategy: cohort.strategy,
          paperKind: cohort.paperKind,
          counts: cohort.counts,
          sessions: cohort.sessions,
          minMarksForTrajectory: MIN_MARKS_FOR_TRAJECTORY,
          trajectoryTrustworthy: cohort.rows.filter((r) => r.trajectoryTrustworthy).length,
          members: cohort.rows.map((r) => ({
            paperTradeId: r.paperTradeId, alertId: r.alertId, opportunityCaseId: r.opportunityCaseId,
            discordMessageId: r.discordMessageId, symbol: r.symbol, optionSymbol: r.optionSymbol,
            side: r.side, expiration: r.expiration, sessionDate: r.sessionDate,
            enteredAtMs: r.enteredAtMs, exitAtMs: r.exitAtMs, entryFill: r.entryFill,
            outcome: r.outcome, returnPct: r.returnPct, exitReason: r.exitReason,
            sameContractMarks: r.sameContractMarks, trajectoryTrustworthy: r.trajectoryTrustworthy,
            peakPct: r.peakPct, troughPct: r.troughPct, neverWorked: r.neverWorked,
            strategyVersion: r.strategyVersion, exitPolicyVersion: r.exitPolicyVersion,
            deploymentSha: r.deploymentSha,
            decision: evaluate(r.features),
          })),
        },

        performance: {
          all: performance(closed),
          development: performance(development),
          validation: performance(validation),
        },

        preEntryComparison: compareWinnersToLosers(closed, development, validation),
        featureBasis: FEATURE_BASIS,
        degenerateFeatures: degenerateFeatures(cohort.rows.map((r) => r.features)),

        lossTaxonomy,
        neverWorked: losses.filter((r) => r.neverWorked === true).map((r) => r.paperTradeId),
        workedThenLost: losses.filter((r) => r.neverWorked === false).map((r) => r.paperTradeId),

        experiment: {
          experimentId: EXPERIMENT_ID,
          mode: EXPERIMENT_MODE,
          gates: GATES.map((g) => ({ id: g.id, label: g.label, rationale: g.rationale })),
          developmentSessions: devSessions,
          overall: simulate(closed),
          development: simulate(development),
          validation: simulate(validation),
          perSession: perSessionEffect(closed),
        },
      },
      { status: 200 },
    );
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
