import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Auth-gated Brokerage V2 migration readiness + soak history. No production cutover. */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const { getDb } = await import("@/lib/db");
    const { ensureBrokerSchemaOnDb } = await import("@/lib/broker/schema-migrate");
    const { evaluateBrokerV2Readiness } = await import("@/lib/broker/readiness");
    const {
      generateDailyReadinessReportIfDue,
      buildSoakPeriodSummary,
      listDailyReadinessReports,
    } = await import("@/lib/broker/soak-report");
    const { validateBrokerV2FlagCombination, assertBrokerV2FlagsSafe } = await import("@/lib/broker/flags");
    const flagCheck = validateBrokerV2FlagCombination(process.env);
    // Do not crash the readiness page on bad flags — surface them in the report.
    try {
      assertBrokerV2FlagsSafe(process.env);
    } catch {
      /* included in report.routing.flagValidation */
    }
    const db = getDb();
    ensureBrokerSchemaOnDb(db as never);
    // Persist today's soak report if due (idempotent). Never enables flags/cutover.
    const daily = generateDailyReadinessReportIfDue(db as never, process.env);
    const report = evaluateBrokerV2Readiness(db as never, process.env);
    const soak = buildSoakPeriodSummary(db as never);
    const recentDaily = listDailyReadinessReports(db as never, 30);
    return NextResponse.json(
      {
        ok: true,
        label: "Brokerage V2 Migration Readiness — No Production Cutover",
        productionCutoverEnabled: false,
        soakPhase: true,
        flagValidation: flagCheck,
        report,
        soak: {
          period: soak,
          today: daily,
          recentDaily,
          cutoverPerformed: false,
          note:
            soak.everReachedControlledCutoverGate
              ? "Gate READY_FOR_CONTROLLED_CUTOVER observed — human approval required; no auto cutover."
              : "Soak in progress — collecting daily readiness evidence.",
        },
      },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
