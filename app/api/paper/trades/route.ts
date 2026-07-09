import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/paper/trades — all trades + analytics summary + bucket cuts. */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  const { listPaperTrades, listPaperDecisions, paperEngineState } = await import("@/lib/paper-engine");
  const { summarize, byConfidence, byExpirationLength, bySetup, byExitKind } = await import("@/lib/paper-analytics");
  const trades = listPaperTrades();
  return NextResponse.json({
    ok: true,
    trades,
    summary: summarize(trades),
    buckets: {
      byConfidence: byConfidence(trades),
      byExpirationLength: byExpirationLength(trades),
      bySetup: bySetup(trades),
      byExitKind: byExitKind(trades),
    },
    decisions: listPaperDecisions(),
    engine: paperEngineState(),
  });
}

/** POST /api/paper/trades — create from an alert ({alertId}) or manually. */
export async function POST(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  let body: any = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const { createPaperTrade } = await import("@/lib/paper-engine");
  const result = createPaperTrade(body ?? {});
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
