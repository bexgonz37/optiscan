import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";
import { getLastUniverseFilterSnapshot, getLastUniverseFilterSummary } from "@/lib/universe-filter-runtime";
import { DEFAULT_UNIVERSE_FILTERS } from "@/lib/universe-filters";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/diagnostics/universe-funnel — last filter-chain attrition. */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const snap = getLastUniverseFilterSnapshot();
    const summary = getLastUniverseFilterSummary();
    return NextResponse.json({
      ok: true,
      configuredFilters: DEFAULT_UNIVERSE_FILTERS.map((f) => ({ id: f.id, label: f.label })),
      snapshot: snap,
      summary,
      note: "Attrition is diagnostic. Live Discord SEND still uses independent options delivery gates.",
    });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
