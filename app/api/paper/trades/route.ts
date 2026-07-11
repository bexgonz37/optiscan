import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/paper/trades — all trades + analytics summary + bucket cuts. */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  const { listPaperTrades, listPaperDecisions, paperEngineState, recentPaperEvents, paperTradeEvents } = await import("@/lib/paper-engine");
  const { summarize, byConfidence, byExpirationLength, bySetup, byExitKind } = await import("@/lib/paper-analytics");

  // Detail view: ?tradeId=N returns the full chronological event log for one trade.
  const tradeIdParam = new URL(req.url).searchParams.get("tradeId");
  if (tradeIdParam != null && Number.isFinite(Number(tradeIdParam))) {
    return NextResponse.json({ ok: true, tradeId: Number(tradeIdParam), events: paperTradeEvents(Number(tradeIdParam)) });
  }

  const trades = listPaperTrades();
  const summary = summarize(trades);
  const startingBalance = Number(process.env.PAPER_STARTING_BALANCE ?? 5000);
  const equity = +(startingBalance + summary.totalPnlDollars).toFixed(2);
  return NextResponse.json({
    ok: true,
    trades,
    summary,
    account: {
      startingBalance,
      realizedPnl: summary.totalPnlDollars,
      equity,
      buyingPowerNote: "Risk engine reserves are enforced by max risk, max ticker exposure, and max open trades.",
    },
    buckets: {
      byConfidence: byConfidence(trades),
      byExpirationLength: byExpirationLength(trades),
      bySetup: bySetup(trades),
      byExitKind: byExitKind(trades),
    },
    decisions: listPaperDecisions(),
    events: recentPaperEvents(200),
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
