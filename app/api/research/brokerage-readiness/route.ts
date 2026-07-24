import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Auth-gated Brokerage V2 migration readiness (B6). No production cutover. */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const { getDb } = await import("@/lib/db");
    const { ensureBrokerSchemaOnDb } = await import("@/lib/broker/schema-migrate");
    const { evaluateBrokerV2Readiness } = await import("@/lib/broker/readiness");
    const { assertBrokerV2FlagsSafe, validateBrokerV2FlagCombination } = await import("@/lib/broker/flags");
    const flagCheck = validateBrokerV2FlagCombination(process.env);
    // Do not crash the readiness page on bad flags — surface them in the report.
    try {
      assertBrokerV2FlagsSafe(process.env);
    } catch {
      /* included in report.routing.flagValidation */
    }
    const db = getDb();
    ensureBrokerSchemaOnDb(db as never);
    const report = evaluateBrokerV2Readiness(db as never, process.env);
    return NextResponse.json(
      {
        ok: true,
        label: "Brokerage V2 Migration Readiness — No Production Cutover",
        productionCutoverEnabled: false,
        flagValidation: flagCheck,
        report,
      },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
