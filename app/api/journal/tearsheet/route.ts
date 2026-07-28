import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";
import { buildTearsheet, loadJournalTradesOnDb } from "@/lib/trade-tearsheet";
import { listResearchTrialsOnDb } from "@/lib/research-trials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/journal/tearsheet */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const { getDb } = await import("@/lib/db");
    const db = getDb();
    const trades = loadJournalTradesOnDb(db as any);
    const tearsheet = buildTearsheet(trades);
    return NextResponse.json({
      ok: true,
      tearsheet,
      researchTrials: listResearchTrialsOnDb(db as any, 10),
    });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
