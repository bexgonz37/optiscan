import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/research/executable-opportunity — was there still a buyable option
 * when the mover was found?
 *
 *   ?session=YYYY-MM-DD   trading session (default: today)
 *   ?minMove=N            peak |move| floor for inclusion (default 10)
 *   ?limit=N              how many of the session's top movers to measure
 *
 * Answers the EXECUTABLE half of EXTREME_PREMARKET_DISCOVERY_V1 for the subset
 * OptiScan actually quoted, by joining evidence that was already paid for:
 * options_research_observations, asymmetry_outcomes, contract_funnel_evidence
 * and market_mover_observations.
 *
 * MAKES NO PROVIDER REQUEST. That is load-bearing rather than incidental: this
 * measurement is most needed precisely when the minute cap is saturated, and a
 * lane that had to spend budget to run would be unavailable exactly then.
 *
 * A symbol with no NBBO on record returns a coverage verdict and a NULL ladder.
 * It never returns a zero, and it never infers an option return from how far the
 * underlying moved. `bias.unmeasuredFraction` states on every response how much
 * of the discovered population the aggregates exclude.
 *
 * SHADOW / RESEARCH ONLY. No gate, threshold, ranking weight, target, stop, exit
 * or delivery decision reads this.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const { getDb } = await import("@/lib/db");
    const { tradingDay } = await import("@/lib/trading-session");
    const { measureExecutableOpportunityOnDb } = await import(
      "@/lib/research/options/executable-opportunity"
    );
    const { EXTREME_PREMARKET_DISCOVERY_V1_SCOPES } = await import(
      "@/lib/research/options/experiment-registry"
    );

    const sessionDate = url.searchParams.get("session") ?? tradingDay(Date.now());
    const minMove = Number(url.searchParams.get("minMove") ?? 10);
    const limit = Number(url.searchParams.get("limit") ?? 40);

    const report = measureExecutableOpportunityOnDb(getDb() as any, {
      sessionDate,
      minPeakAbsMovePct: Number.isFinite(minMove) ? minMove : 10,
      limit: Number.isFinite(limit) ? limit : 40,
    });

    return NextResponse.json({
      ok: true,
      experimentId: "EXTREME_PREMARKET_DISCOVERY_V1",
      scopes: EXTREME_PREMARKET_DISCOVERY_V1_SCOPES,
      readOnly: true,
      report,
      safety: {
        providerRequests: report.providerRequests,
        productionBehaviorChanged: false,
        note:
          "Retrospective join over evidence already on disk. No provider call, no send, "
          + "no trade authority. A mover with no NBBO carries a null ladder, never a zero.",
      },
    });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
