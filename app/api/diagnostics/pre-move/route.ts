import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/diagnostics/pre-move — PRE_MOVE_DISCOVERY_V1, per lane.
 *
 * Answers "did OptiScan find it BEFORE it ran", which a good realized return cannot:
 * a trade alerted after the move was already spent and one alerted before it began can
 * close at the same number while meaning opposite things about the scanner.
 *
 *   ?days=N     window over first detection (default 7; 0 = all history)
 *   ?verbose=1  include per-case lead-time rows, not just the lane summaries
 *
 * Reads persisted evidence only. No provider call, no quota spend, no send authority,
 * and nothing here is read by a gate, threshold, ranking weight, stop or exit.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const { getDb } = await import("@/lib/db");
    const { buildPreMoveNightlyReport } = await import("@/lib/research/options/pre-move-nightly");

    const days = Math.max(0, Math.min(365, Number(url.searchParams.get("days") ?? 7)));
    const sinceMs = days === 0 ? null : Date.now() - days * 86_400_000;
    const verbose = url.searchParams.get("verbose") === "1";

    const report = buildPreMoveNightlyReport(getDb() as any, { sinceMs });
    return NextResponse.json({
      ok: true,
      scope: { days: days === 0 ? "ALL" : days, sinceMs },
      version: report.version,
      questions: report.questions,
      lanes: report.lanes.map((l) => ({
        ...l,
        rows: verbose ? l.rows : undefined,
        rowCount: l.rows.length,
      })),
      note: report.note,
    });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
