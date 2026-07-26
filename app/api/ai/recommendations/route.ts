import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  try {
    const { getDb } = await import("@/lib/db");
    const { listRecommendationsOnDb, buildCursorExportPrompt } = await import("@/lib/ai/recommendations");
    const { loadEvidencePacketOnDb } = await import("@/lib/ai/evidence-packet");
    const url = new URL(req.url);
    const id = Number(url.searchParams.get("id"));
    const db = getDb();
    const rows = listRecommendationsOnDb(db as any, 100);
    if (Number.isFinite(id) && id > 0) {
      const rec = rows.find((r) => r.id === id);
      if (!rec) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
      const evidence = rec.evidencePacketId ? loadEvidencePacketOnDb(db as any, rec.evidencePacketId) : null;
      if (url.searchParams.get("export") === "cursor") {
        return NextResponse.json({
          ok: true,
          recommendation: rec,
          cursorPrompt: buildCursorExportPrompt(rec, evidence),
        });
      }
      return NextResponse.json({ ok: true, recommendation: rec, evidence });
    }
    return NextResponse.json({ ok: true, recommendations: rows }, { status: 200 });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}

export async function POST(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  try {
    const body = await req.json().catch(() => ({}));
    const id = Number(body.id);
    if (!Number.isFinite(id) || id <= 0) {
      return NextResponse.json({ ok: false, error: "id_required" }, { status: 400 });
    }
    const { getDb } = await import("@/lib/db");
    const { updateRecommendationWorkflowOnDb } = await import("@/lib/ai/recommendations");
    const ok = updateRecommendationWorkflowOnDb(getDb() as any, id, {
      workflowStatus: body.workflowStatus,
      decisionNotes: body.decisionNotes,
      evidencePacketId: body.evidencePacketId,
      implementedCommitSha: body.implementedCommitSha,
    });
    return NextResponse.json({ ok }, { status: ok ? 200 : 400 });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
