import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  try {
    const url = new URL(req.url);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
    const { getDb } = await import("@/lib/db");
    const { listRecentOpportunityCasesOnDb } = await import("@/lib/opportunity-case/store");
    const db = getDb();
    const cases = listRecentOpportunityCasesOnDb(db, limit);
    return NextResponse.json(
      { ok: true, cases, count: cases.length, meta: { count: cases.length } },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
