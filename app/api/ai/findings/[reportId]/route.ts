import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ reportId: string }> }) {
  if (!checkApiToken(req)) return unauthorized();
  try {
    const { reportId } = await params;
    const id = Number(String(reportId).replace(/^(nightly|weekly):/, ""));
    if (!Number.isFinite(id) || id <= 0) {
      return NextResponse.json({ ok: false, error: "valid report id required" }, { status: 400 });
    }
    const { getDb } = await import("@/lib/db");
    const { getReportByIdOnDb, listReportsOnDb, listProposalsOnDb, recentJobFailuresOnDb } = await import("@/lib/ai/store");
    const { momentumDiagnosticsForDay } = await import("@/lib/momentum-diagnostics");
    const { buildCanonicalFindingsReport, linkedReadyToSentOnDb } = await import("@/lib/ai/findings-report");
    const db = getDb();
    const reportRow = getReportByIdOnDb(db, id);
    if (!reportRow || !["nightly", "weekly"].includes(reportRow.reportType)) {
      return NextResponse.json({ ok: false, error: "report not found" }, { status: 404 });
    }
    const latestMomentumDiagnostics = reportRow.reportType === "nightly"
      ? momentumDiagnosticsForDay(reportRow.periodKey, db, 1000)
      : [];
    const linkedReadyToSent = linkedReadyToSentOnDb(db, reportRow.periodStartMs, reportRow.periodEndMs ?? reportRow.createdAtMs);
    const report = buildCanonicalFindingsReport({
      nightlyReports: [reportRow, ...listReportsOnDb(db, "nightly", 30).filter((r) => r.id !== reportRow.id)],
      weeklyReports: listReportsOnDb(db, "weekly", 20),
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
