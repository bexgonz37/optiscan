import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/diagnostics/data-truth — what OptiScan ACTUALLY HOLDS versus what the
 * provider would sell it.
 *
 *     PROVIDER HAS IT != OPTISCAN HAS IT.
 *
 * The two halves are reported side by side and never merged. `providerCapability` is
 * probe evidence about HTTP endpoints; `stored` is a count of rows that exist in this
 * database. Reading the first as the second is how a plan to build a 2023 cohort gets
 * made against data nothing has ever fetched.
 *
 * Read-only: no provider call, no quota spend, no writes, no send authority.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const { getDb } = await import("@/lib/db");
    const { buildDataTruthReport, historicalOptionsReadiness } = await import("@/lib/research/data-truth");
    const { MASSIVE_CAPABILITY_MATRIX, capabilitySummary, blockers } = await import(
      "@/lib/research/asymmetry/historical/capability-matrix"
    );

    const db = getDb() as any;
    return NextResponse.json({
      ok: true,
      stored: buildDataTruthReport(db),
      localOptionHistory: historicalOptionsReadiness(db),
      providerCapability: {
        summary: capabilitySummary(),
        blockers: blockers(),
        matrix: MASSIVE_CAPABILITY_MATRIX,
      },
      note:
        "`stored` counts rows in THIS database. `providerCapability` records what the plan was PROVEN "
        + "to serve when last probed. Entitlement is not possession: every row marked "
        + "INTEGRATED_UNUSED or NOT_INTEGRATED is data the provider would return and OptiScan has "
        + "never fetched, so no historical study can rest on it until something does.",
    });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
