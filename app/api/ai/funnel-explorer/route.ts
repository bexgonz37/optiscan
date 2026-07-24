import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Funnel Explorer + observability report (Phases 1–3).
 * Auth-gated. Read-only. Never affects live gates.
 *
 * GET /api/ai/funnel-explorer              → full observability report
 * GET /api/ai/funnel-explorer?id=cand_123  → single opportunity lifecycle
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  try {
    const { getDb } = await import("@/lib/db");
    const { buildObservabilityReportOnDb, loadExplorerDetailOnDb } = await import("@/lib/metrics/observability");
    const db = getDb();
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (id) {
      const trace = loadExplorerDetailOnDb(db, id);
      if (!trace) {
        return NextResponse.json(
          { ok: false, error: "opportunity not found", id },
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      return NextResponse.json(
        { ok: true, trace },
        { headers: { "content-type": "application/json" } },
      );
    }
    const report = buildObservabilityReportOnDb(db);
    return NextResponse.json(
      { ok: true, report },
      { headers: { "content-type": "application/json" } },
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: String((err as Error)?.message ?? err).slice(0, 240) },
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }
}
