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

    // PAYLOAD (2026-08-18 audit): a full Opportunity Case document is ~46KB of
    // evidence, so the LIST view was shipping 2.3MB to render a six-column table.
    // `view=summary` projects the six fields the list actually reads. It is derived
    // from the SAME parsed case object the full response returns -- not from the
    // denormalised columns beside it -- so the list can never disagree with the
    // detail view about a case's decision or symbol.
    //
    // Default stays full, because existing consumers and the detail route depend on
    // the whole document and silently truncating it would be a data change.
    if (url.searchParams.get("view") === "summary") {
      const summaries = cases.map((c) => ({
        opportunityId: c.opportunityId,
        underlyingSymbol: c.underlyingSymbol,
        setupFamily: c.setupFamily ?? null,
        deliveryDecision: c.deliveryDecision,
        acceptanceDecision: c.acceptanceDecision,
        detectedAtMs: c.detectedAtMs,
      }));
      return NextResponse.json(
        { ok: true, view: "summary", cases: summaries, count: summaries.length, meta: { count: summaries.length } },
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    return NextResponse.json(
      { ok: true, view: "full", cases, count: cases.length, meta: { count: cases.length } },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
