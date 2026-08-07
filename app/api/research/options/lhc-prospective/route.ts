import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Owner diagnostic: the PROSPECTIVE `LHC_SELECT_V1` shadow arm.
 *
 * Baseline and experiment decisions recorded live, side by side, with every component value,
 * the confirmation-cost capture, the frozen policy attribution, and the scoreboard computed
 * from CLOSED outcomes only.
 *
 * Read-only. ZERO provider calls. Authorizes nothing — `productionBehaviorChanged` is a
 * constant false, and no response from this route is consulted by any delivery path.
 *
 * `?refresh=1` re-reads outcome columns from the persisted paper store (still zero provider
 * calls); `?session=YYYY-MM-DD` scopes the decision list; `?full=1` includes every decision row.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const sessionDate = url.searchParams.get("session");
    const full = url.searchParams.get("full") === "1";
    const doRefresh = url.searchParams.get("refresh") === "1";

    const { getDb } = await import("@/lib/db");
    const {
      listShadowDecisionsOnDb, refreshShadowOutcomesOnDb, statusHistoryOnDb, currentStatusOnDb,
    } = await import("@/lib/research/options/shadow-arm-store");
    const { buildProspectiveScoreboard, weeklyVerdict } =
      await import("@/lib/research/options/prospective-scoreboard");
    const { LHC_SELECT_V1, checkFrozen, describeExperiment } =
      await import("@/lib/research/options/experiment-registry");
    const { listFindingsOnDb } = await import("@/lib/research/options/findings-store");
    const { POLICY_VERSIONS } = await import("@/lib/research/options/policy-attribution");
    const { deployInfo } = await import("@/lib/build-info");

    const db = getDb() as never;
    const sha = (() => { try { return deployInfo().commit ?? null; } catch { return null; } })();

    const refreshed = doRefresh ? refreshShadowOutcomesOnDb(db).refreshed : 0;

    const rows = listShadowDecisionsOnDb(db, {
      experimentId: LHC_SELECT_V1.experimentId,
      sessionDate: sessionDate ?? undefined,
    });
    const scoreboard = buildProspectiveScoreboard(rows);
    const frozen = checkFrozen();
    const status = currentStatusOnDb(db, LHC_SELECT_V1.experimentId, LHC_SELECT_V1.experimentVersion);

    return NextResponse.json(
      {
        ok: true,
        readOnly: true,
        providerCallsIssued: 0,
        productionBehaviorChanged: false,
        note:
          "Prospective shadow arm. Persisted decisions only. Expectancy and profit factor are " +
          "computed from CLOSED outcomes; a positive MFE is never counted as a win.",
        generatedAtMs: Date.now(),
        deploymentSha: sha,
        outcomesRefreshed: refreshed,

        experiment: {
          ...describeExperiment(LHC_SELECT_V1, status ?? "PROPOSED"),
          creationSha: LHC_SELECT_V1.creationSha,
          prospectiveStartDate: LHC_SELECT_V1.prospectiveStartDate,
          sourceCohortId: LHC_SELECT_V1.sourceCohortId,
          developmentSessions: LHC_SELECT_V1.developmentSessions,
          validationSessions: LHC_SELECT_V1.validationSessions,
          historicalResult: LHC_SELECT_V1.historicalResult,
          gates: LHC_SELECT_V1.gates,
          wouldBeDisprovenBy: LHC_SELECT_V1.wouldBeDisprovenBy,
        },
        immutability: frozen,
        lifecycle: {
          currentStatus: status,
          history: statusHistoryOnDb(db, LHC_SELECT_V1.experimentId, LHC_SELECT_V1.experimentVersion),
          note: "There is deliberately no SUBSCRIBER_APPROVED status. Promotion is a human act elsewhere.",
        },

        scoreboard,
        weeklyVerdict: weeklyVerdict(scoreboard),

        policyVersions: POLICY_VERSIONS,
        findings: listFindingsOnDb(db, { strategy: "lower_high_continuation" }),

        decisionCount: rows.length,
        decisions: full ? rows : rows.slice(-50),
      },
      { status: 200 },
    );
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
