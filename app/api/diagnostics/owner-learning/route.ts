import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/diagnostics/owner-learning — does the learning pipeline actually SEE the owner
 * callouts?
 *
 * The owner lane produces one paper mirror per Discord opening, on the exact contract that
 * was called. Five learning consumers resolved it through `alert_id`, which an owner
 * callout never has, so every one of them reported the lane as empty rather than erroring.
 * This endpoint puts the three things side by side that make that visible:
 *
 *   identity  — how many owner rows carry an alert id (the broken link) versus a case id
 *               on the mirror's own snapshot (the durable one)
 *   contrast  — DELIVERED_ALERT_PAPER for the same session, which is the population the
 *               owner summary used to report under an OWNER heading
 *   owner     — the repaired OWNER_VALIDATION_PAPER lane, with per-trade path labels,
 *               stop evidence and pre-callout features
 *
 *   ?session=YYYY-MM-DD   session for the summary + contrast (default: today, ET)
 *   ?rows=1               include every per-trade learning row, not just the statistics
 *   ?case=oc_...          trace ONE callout end to end, by either of its case identities
 *
 * SHADOW / RESEARCH ONLY. Read-only: no provider call, no quota spend, no send authority,
 * no writes, and nothing here is read by a gate, threshold, ranking weight, contract
 * selection, target, stop, exit or subscriber decision.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const { getDb } = await import("@/lib/db");
    const {
      buildOwnerLearningReportOnDb,
      buildDeliveredLaneContrastOnDb,
      censusOwnerIdentityOnDb,
    } = await import("@/lib/research/options/owner-learning");
    const { resolveOwnerMirrorOnDb } = await import("@/lib/opportunity-case/owner-mirror-identity");
    const { buildPreMoveNightlyReport } = await import("@/lib/research/options/pre-move-nightly");
    const { buildCohortStatisticsOnDb } = await import("@/lib/research/options/cohort-probability");
    const { tradingDay } = await import("@/lib/trading-session");

    const db = getDb() as any;
    const nowMs = Date.now();
    const sessionDate = url.searchParams.get("session") ?? tradingDay(nowMs);
    const includeRows = url.searchParams.get("rows") === "1";
    const caseId = url.searchParams.get("case");

    const identity = censusOwnerIdentityOnDb(db, {});
    const session = buildOwnerLearningReportOnDb(db, { sessionDate });
    const allTime = buildOwnerLearningReportOnDb(db, {});
    const contrast = buildDeliveredLaneContrastOnDb(db, sessionDate);

    const preMoveOwner = (() => {
      try {
        const r = buildPreMoveNightlyReport(db, { sinceMs: null });
        const lane = r.lanes.find((l) => l.lane === "OWNER");
        return lane
          ? {
            census: lane.census,
            gradedAlerts: lane.gradedAlerts,
            alertInstantsDerived: lane.alertInstantsDerived,
            alertsWithMilestoneAlreadyHit: lane.alertsWithMilestoneAlreadyHit,
            medianPremiumConsumedBeforeAlertPct: lane.medianPremiumConsumedBeforeAlertPct,
            medianRewardRemainingFraction: lane.medianRewardRemainingFraction,
            milestoneAttainment: lane.milestoneAttainment,
            questions: r.questions,
          }
          : null;
      } catch { return null; }
    })();

    const cohort = (() => {
      try {
        return buildCohortStatisticsOnDb(db, { paperKind: "OWNER_VALIDATION_PAPER" }, { sinceMs: null });
      } catch { return null; }
    })();

    const trace = caseId
      ? (() => {
        const resolution = resolveOwnerMirrorOnDb(db, caseId);
        const row = allTime.rows.find(
          (r) => r.opportunityCaseId === caseId || r.preMoveCaseId === caseId,
        ) ?? null;
        return { requested: caseId, resolution, learningRow: row };
      })()
      : null;

    return NextResponse.json({
      ok: true,
      mode: "SHADOW_ONLY",
      scope: { sessionDate, includeRows },
      identity,
      contrast,
      ownerSession: session.statistics,
      ownerAllTime: allTime.statistics,
      preMoveOwner,
      cohort,
      trace,
      rows: includeRows ? allTime.rows : undefined,
      rowCount: allTime.rows.length,
      note: allTime.note,
    });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
