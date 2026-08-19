import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/research/command-center — the PRIVATE research view's single read.
 *
 * Distinct from /api/command-center, which is the operational homepage snapshot
 * (loop health, provider, delivery config). This one answers "where does the evidence
 * stand", and the two are kept apart because mixing an ops fault with a research
 * verdict on one screen makes both harder to act on.
 *
 * Token-gated. Owner only — subscribers never see this surface, and nothing here is
 * subscriber performance.
 *
 * Reads persisted evidence only. No provider call, no quota spend, no send authority,
 * no write, and nothing served here is consulted by a scanner rule, threshold, ranking
 * weight, contract choice, target, stop, exit or subscriber decision.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const { getDb } = await import("@/lib/db");
    const { buildResearchCommandCenterOnDb } = await import("@/lib/research/options/research-command-center");
    const { PRE_MOVE_DISCOVERY_V2_DEFINITION } = await import("@/lib/research/options/pre-move-discovery-v2");
    const { aiBudgetReportOnDb } = await import("@/lib/ai/monthly-budget");
    const { aiConfig } = await import("@/lib/ai/config");

    const report = buildResearchCommandCenterOnDb(getDb() as any, {});

    // The AI budget belongs on this page because "Explain This" spends from it, and a
    // reader who cannot see the remaining balance cannot tell a refused explanation
    // from a broken one.
    let budget: unknown = null;
    try { budget = aiBudgetReportOnDb(getDb() as any, aiConfig(process.env)); } catch { budget = null; }

    return NextResponse.json({
      ok: true,
      report,
      budget,
      discoveryDefinition: PRE_MOVE_DISCOVERY_V2_DEFINITION,
      safety: {
        audience: "OWNER_ONLY",
        subscriberDeliveryEnabled: false,
        aiAuthority: "ADVISORY_ONLY",
        productionBehaviorChanged: false,
        note:
          "Owner-validation evidence. No subscriber received these trades and none of "
          + "these figures is subscriber performance. No experiment on this page has any "
          + "live authority, and nothing here can promote one.",
      },
    });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
