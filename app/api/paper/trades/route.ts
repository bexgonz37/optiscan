import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/paper/trades — all trades + analytics summary + bucket cuts. */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  const { listPaperTrades, listPaperDecisions, paperEngineState, recentPaperEvents, paperTradeEvents, dailyPaperSummary } = await import("@/lib/paper-engine");
  const { summarize, byConfidence, byExpirationLength, bySetup, byExitKind } = await import("@/lib/paper-analytics");
  const { optionsPerformance } = await import("@/lib/paper-options-analytics");
  const { syncPaperOutcomes } = await import("@/lib/outcome-store");

  const url = new URL(req.url);

  // Read-only NBBO preflight diagnostic (?diag=nbbo). Reports counts only — no
  // secrets, no fabrication. Honestly shows whether verified stock NBBO fills
  // have occurred in this DB.
  if (url.searchParams.get("diag") === "nbbo") {
    const { nbboDiagnostic } = await import("@/lib/outcome-store");
    return NextResponse.json({ ok: true, diag: "nbbo", ...nbboDiagnostic() });
  }

  // Idempotent: freeze fingerprints + grade terminal trades before reading.
  syncPaperOutcomes();

  // Detail view: ?tradeId=N returns the full chronological event log for one trade.
  const tradeIdParam = url.searchParams.get("tradeId");
  if (tradeIdParam != null && Number.isFinite(Number(tradeIdParam))) {
    return NextResponse.json({ ok: true, tradeId: Number(tradeIdParam), events: paperTradeEvents(Number(tradeIdParam)) });
  }

  const allTrades = listPaperTrades();
  // Primary and Challenge statistics are NEVER mixed. Primary is the default
  // account; the Challenge is the independent AGGRESSIVE_CHALLENGE portfolio.
  const trades = allTrades.filter((t) => (t.portfolio ?? "PRIMARY") === "PRIMARY");
  const challengeTrades = allTrades.filter((t) => t.portfolio === "CHALLENGE");
  const toPerfRow = (t: typeof allTrades[number]) => ({
    optionSymbol: t.optionSymbol, optionType: t.optionType, status: t.status,
    dteAtEntry: t.dteAtEntry, contracts: t.contracts, entryPrice: t.entryPrice,
    exitPrice: t.exitPrice, lastMark: t.lastMark, entryAtMs: t.entryAtMs, exitAtMs: t.exitAtMs,
    strategy: t.strategy,
    entrySlippage: (t.entryCosts?.slippage as number | null) ?? null,
    exitSlippage: (t.exitCosts?.slippage as number | null) ?? null,
    entryFees: (t.entryCosts?.fees as number | null) ?? null,
    exitFees: (t.exitCosts?.fees as number | null) ?? null,
    opportunityPeakPct: t.opportunityPeakPct,
  });
  const hitPct = Number(process.env.PAPER_OPPORTUNITY_HIT_PCT ?? 30);
  const summary = summarize(trades);
  const optionsPerf = optionsPerformance(trades.map(toPerfRow), hitPct);
  const startingBalance = Number(process.env.PAPER_STARTING_BALANCE_USD ?? process.env.PAPER_STARTING_BALANCE ?? 5000);
  const equity = +(startingBalance + summary.totalPnlDollars).toFixed(2);
  const engine = paperEngineState();
  return NextResponse.json({
    ok: true,
    trades,
    summary,
    optionsPerformance: optionsPerf,
    daily: dailyPaperSummary(),
    account: {
      startingBalance,
      realizedPnl: summary.totalPnlDollars,
      equity,
      buyingPowerNote: "Risk engine reserves are enforced by max risk, max ticker exposure, and max open trades.",
    },
    // Independent AGGRESSIVE_CHALLENGE — separate rows, balance, P&L, and analytics.
    challenge: {
      ...engine.challenge,
      trades: challengeTrades,
      summary: summarize(challengeTrades),
      optionsPerformance: optionsPerformance(challengeTrades.map(toPerfRow), hitPct),
    },
    buckets: {
      byConfidence: byConfidence(trades),
      byExpirationLength: byExpirationLength(trades),
      bySetup: bySetup(trades),
      byExitKind: byExitKind(trades),
    },
    decisions: listPaperDecisions(),
    events: recentPaperEvents(200),
    engine,
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
