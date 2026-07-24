import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Auth-gated paper trade lifecycle diagnostic (Candidate → … → Broker V2). */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const lane = url.searchParams.get("lane");
    const tradeId = url.searchParams.get("tradeId");
    const optionTradeId = url.searchParams.get("optionTradeId");
    const alertId = url.searchParams.get("alertId");
    const { getDb } = await import("@/lib/db");
    const {
      listRecentPaperLifecycles,
      buildLegacyPaperLifecycle,
      buildOptionsPaperLifecycle,
    } = await import("@/lib/paper-lifecycle");
    const db = getDb();

    if (lane === "legacy" && tradeId) {
      const report = buildLegacyPaperLifecycle(db as never, Number(tradeId));
      return NextResponse.json({ ok: true, report });
    }
    if ((lane === "options" || optionTradeId || alertId) && (optionTradeId || alertId)) {
      const report = buildOptionsPaperLifecycle(db as never, {
        optionTradeId: optionTradeId ? Number(optionTradeId) : undefined,
        alertId: alertId ?? undefined,
      });
      return NextResponse.json({ ok: true, report });
    }

    const recent = listRecentPaperLifecycles(db as never, 50);
    return NextResponse.json({
      ok: true,
      label: "Paper Trade Lifecycle Diagnostic",
      recent,
      note: "Select a row for full Candidate → Broker V2 stage timeline with blocking reasons.",
    });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
