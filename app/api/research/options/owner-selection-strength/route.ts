import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/research/options/owner-selection-strength
 *
 * The `OWNER_SELECTION_STRENGTH_GATE_V1` scoreboard: the frozen rule, the in-sample window it
 * was read from, and the prospective window that is the only one able to disprove it.
 *
 * Read-only. ZERO provider calls, zero writes, and it authorizes nothing:
 * `productionBehaviorChanged` is a constant false on every response, no callout was rejected
 * or reordered to produce any figure here, and `verdict` can never be an approval.
 *
 * `?prospectiveStart=YYYY-MM-DD` re-cuts the window for inspection only. It cannot move the
 * frozen record — `frozen.prospectiveStartDate` is returned alongside so a re-cut view is
 * always visibly a re-cut view.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const override = url.searchParams.get("prospectiveStart");
    const includeRows = url.searchParams.get("rows") === "1";

    const { getDb } = await import("@/lib/db");
    const { buildOwnerSelectionStrengthScoreboardOnDb, supportedRegistryStatus } =
      await import("@/lib/research/options/owner-selection-strength-scoreboard");
    const { currentStatusOnDb, statusHistoryOnDb } = await import("@/lib/research/options/shadow-arm-store");
    const { deployInfo, deploymentShaAttribution } = await import("@/lib/build-info");

    const db = getDb() as never;
    const board = buildOwnerSelectionStrengthScoreboardOnDb(db, {
      prospectiveStartDate: override && /^\d{4}-\d{2}-\d{2}$/.test(override) ? override : undefined,
    });

    const recordedStatus = (() => {
      try { return currentStatusOnDb(db as never, board.experimentId, board.experimentVersion); }
      catch { return null; }
    })();
    const history = (() => {
      try { return statusHistoryOnDb(db as never, board.experimentId, board.experimentVersion); }
      catch { return []; }
    })();

    return NextResponse.json({
      ok: true,
      mode: board.mode,
      productionBehaviorChanged: false,
      experimentId: board.experimentId,
      experimentVersion: board.experimentVersion,
      floor: board.floor,
      definitionFrozen: board.definitionFrozen,
      frozen: board.frozen,

      windowRecut: override ? { requested: override, frozenStart: board.frozen.prospectiveStartDate } : null,

      inSample: includeRows ? board.inSample : { ...board.inSample, simulation: withoutTrades(board.inSample.simulation) },
      prospective: includeRows ? board.prospective : { ...board.prospective, simulation: withoutTrades(board.prospective.simulation) },

      evidence: board.evidence,
      verdict: board.verdict,
      verdictReason: board.verdictReason,
      /** The registry status this evidence SUPPORTS. Recording it is the nightly's decision. */
      supportedRegistryStatus: supportedRegistryStatus(board),
      recordedStatus,
      statusHistory: history,

      authority: board.authority,
      limitations: board.limitations,

      deploy: (() => { try { return deployInfo(); } catch { return null; } })(),
      shaAttribution: (() => { try { return deploymentShaAttribution(); } catch { return null; } })(),
    });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}

/**
 * Drop the per-trade lists from a simulation unless they were asked for.
 *
 * `winnersRejected` is NOT dropped. It is the filter's cost, it is reported unconditionally
 * everywhere else in this system, and a default view that shows what a rule saved while
 * hiding what it gave up is the exact shape of the trailing-stop mistake.
 */
function withoutTrades(sim: any) {
  const { winnersRetained, lossesRejected, lossesRetained, ...rest } = sim;
  return {
    ...rest,
    winnersRetainedCount: winnersRetained.length,
    lossesRejectedCount: lossesRejected.length,
    lossesRetainedCount: lossesRetained.length,
  };
}
