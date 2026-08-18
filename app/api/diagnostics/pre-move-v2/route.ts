import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/diagnostics/pre-move-v2 — PRE_MOVE_DISCOVERY_V2, the prospective successor.
 *
 * V1 lives on at /api/diagnostics/pre-move and is not modified, reclassified or
 * deleted. Read them side by side: V1 measures the move consumed between detection
 * and alert (a median 1.6-second window, which is why it grades 100% of every lane
 * PRE_TRIGGER), and V2 measures how much of the SESSION's favourable range was
 * already spent when the callout went out.
 *
 *   ?days=N   window over the callout instant (default 30; 0 = all captured history)
 *
 * The population starts empty and grows forward only. Rows written before the V2
 * capture site went live carry no alert-instant session snapshot and are excluded
 * rather than counted as UNGRADABLE members — counting them would dilute every rate
 * with callouts the measurement never observed. `coverage` reports both numbers.
 *
 * Reads persisted evidence only. No provider call, no quota spend, no send authority,
 * and nothing here is read by a gate, threshold, ranking weight, target, stop or exit.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const { getDb } = await import("@/lib/db");
    const { buildPreMoveV2Report } = await import("@/lib/research/options/pre-move-v2-report");
    const { PRE_MOVE_DISCOVERY_V2_DEFINITION } = await import("@/lib/research/options/pre-move-discovery-v2");

    const days = Math.max(0, Math.min(365, Number(url.searchParams.get("days") ?? 30)));
    const sinceMs = days === 0 ? null : Date.now() - days * 86_400_000;

    const report = buildPreMoveV2Report(getDb() as any, { sinceMs });
    return NextResponse.json({
      ok: true,
      scope: { days: days === 0 ? "ALL" : days, sinceMs },
      definition: PRE_MOVE_DISCOVERY_V2_DEFINITION,
      report,
    });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
