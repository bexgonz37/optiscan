import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!checkApiToken(req)) return unauthorized();
  try {
    const { id } = await ctx.params;
    const { getDb } = await import("@/lib/db");
    const { replayDecisionOnDb } = await import("@/lib/opportunity-case/replay");
    const db = getDb();
    const replay = replayDecisionOnDb(db, id);
    return NextResponse.json(
      { ok: replay.caseFound, replay },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
