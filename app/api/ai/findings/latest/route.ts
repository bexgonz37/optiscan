import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  try {
    const { getDb } = await import("@/lib/db");
    const { listReportsOnDb, listProposalsOnDb, recentJobFailuresOnDb } = await import("@/lib/ai/store");
    const { momentumDiagnosticsForDay } = await import("@/lib/momentum-diagnostics");
    const { buildCanonicalFindingsReport, linkedReadyToSentOnDb } = await import("@/lib/ai/findings-report");
    const db = getDb();
    const nightlyReports = listReportsOnDb(db, "nightly", 30);
    const weeklyReports = listReportsOnDb(db, "weekly", 20);
    const latest = nightlyReports[0] ?? null;
    const latestMomentumDiagnostics = latest?.periodKey ? momentumDiagnosticsForDay(latest.periodKey, db, 1000) : [];
    const linkedReadyToSent = latest
      ? linkedReadyToSentOnDb(db, latest.periodStartMs, latest.periodEndMs ?? latest.createdAtMs)
      : undefined;
    const report = buildCanonicalFindingsReport({
      nightlyReports,
      weeklyReports,
      proposals: listProposalsOnDb(db, 100),
      jobFailures: recentJobFailuresOnDb(db, 20),
      latestMomentumDiagnostics,
      linkedReadyToSent,
    });
    return NextResponse.json({ ok: true, report }, { status: 200, headers: { "content-type": "application/json" } });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
