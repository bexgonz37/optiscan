import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  const { billingEnabled, listPlans, checkEntitlement } = await import("@/lib/billing/entitlements");
  const { DATASET_LICENSES, canRedistributeToSubscribers } = await import("@/lib/licensing/entitlements");
  return NextResponse.json({
    ok: true,
    billing: { enabled: billingEnabled(process.env), plans: listPlans(), status: billingEnabled(process.env) ? "configured" : "INACTIVE" },
    sampleEntitlement: checkEntitlement("full_dossier"),
    licensing: { datasets: DATASET_LICENSES.length, optionsChainRedistribution: canRedistributeToSubscribers("polygon", "options_chain") },
  });
}
