import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/research/options/exit-risk
 *
 * The two OBSERVATION studies over the owner lane:
 *
 *   PROFIT PROTECTION — at the instant a trade first touched +10/+15/+20/+25/+30/+35, do the
 *   eventual winners look different from the ones that gave it all back? Every feature is
 *   computed from marks at or before that instant.
 *
 *   OVERNIGHT RISK — held versus same-day, the gap across the boundary, and the slippage
 *   between the frozen stop and the actual fill.
 *
 * NEITHER PRODUCES A RULE. No trailing stop, break-even stop, profit lock, sell-at-level,
 * cutoff time or stop change exists, is proposed, or is implied by any figure here.
 * `productionBehaviorChanged` is a constant false, and the overnight report returns the
 * winners a flat close-before-the-bell rule would destroy before any gap statistic.
 *
 * Read-only. Zero provider calls, zero writes.
 *
 *   ?session=YYYY-MM-DD   narrow to one ET session (default: the whole forward record)
 *   ?cases=1              include the per-trade observations, not just the aggregates
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const session = url.searchParams.get("session");
    const includeCases = url.searchParams.get("cases") === "1";

    const { getDb } = await import("@/lib/db");
    const { buildExitRiskObservationsOnDb } = await import("@/lib/research/options/exit-risk-loader");
    const { deployInfo } = await import("@/lib/build-info");

    const report = buildExitRiskObservationsOnDb(getDb() as never, {
      sessionDate: session && /^\d{4}-\d{2}-\d{2}$/.test(session) ? session : null,
    });

    return NextResponse.json({
      ok: true,
      mode: "OBSERVATION_ONLY",
      exitPolicyChanged: false,
      stopPolicyChanged: false,
      // `productionBehaviorChanged` comes from the report itself, where it is a literal
      // false. Restating it here would let a route-level constant mask a report that ever
      // said otherwise, which is the one thing this field exists to make impossible.
      ...report,
      // The per-trade observations are large and are the study's raw material rather than its
      // finding. Available on request; never the default payload.
      cases: includeCases ? undefined : "omitted — add ?cases=1",
      deploy: (() => { try { return deployInfo(); } catch { return null; } })(),
    });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
