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
  const legacyPayload = {
    ok: true as const,
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
    source: "LEGACY" as const,
  };

  // B6 shadow-read: never changes returned legacy payload fields above; only records parity events.
  try {
    const { resolvePaperReadSource } = await import("@/lib/broker/routing");
    const { recordShadowReadComparison } = await import("@/lib/broker/shadow-read");
    const { getDb } = await import("@/lib/db");
    const route = resolvePaperReadSource(process.env);
    if (route.runShadowCompare) {
      const t0 = Date.now();
      let v2Equity: number | null = null;
      let v2Open = 0;
      let v2Realized: number | null = null;
      try {
        const { ensureBrokerSchemaOnDb } = await import("@/lib/broker/schema-migrate");
        const { resolveBrokerAccount, buildAccountSummary, buildStatsPayload } = await import("@/lib/broker/paper-read");
        const db = getDb();
        ensureBrokerSchemaOnDb(db as never);
        const account = resolveBrokerAccount(db as never, { accountKey: "subscriber_paper" });
        if (account) {
          const summaryV2 = buildAccountSummary(db as never, account, process.env);
          v2Equity = summaryV2.totalEquity;
          v2Open = summaryV2.openPositionCount;
          v2Realized = summaryV2.realizedPnl;
          const stats = buildStatsPayload(db as never, account, process.env, {});
          const pf = stats.analytics?.performance?.profitFactor as { value: number | null } | undefined;
          const wr = stats.analytics?.performance?.winRate as { value: number | null } | undefined;
          const dd = stats.analytics?.risk?.maximumDrawdownDollars as { value: number | null } | undefined;
          recordShadowReadComparison(db as never, {
            legacyTable: "paper_trades_api",
            legacyId: "primary",
            accountId: account.id,
            legacyLatencyMs: 0,
            v2LatencyMs: Date.now() - t0,
            metrics: {
              trade_count: { legacy: trades.length, v2: stats.counts?.fills ?? null, tolerance: 0 },
              open_position_count: {
                legacy: trades.filter((t) => t.status === "ENTERED" || t.status === "READY").length,
                v2: v2Open,
              },
              realized_pnl: { legacy: summary.totalPnlDollars, v2: v2Realized },
              account_equity: { legacy: equity, v2: v2Equity },
              win_rate: { legacy: summary.winRatePct ?? null, v2: wr?.value ?? null, tolerance: 0.5 },
              profit_factor: {
                legacy: Number.isFinite(summary.profitFactor as number) ? summary.profitFactor : null,
                v2: pf?.value ?? null,
                tolerance: 0.05,
              },
              drawdown: { legacy: null, v2: dd?.value ?? null },
            },
          }, process.env);
        }
      } catch {
        /* shadow failures must never affect legacy response */
      }
    }
  } catch {
    /* routing import optional */
  }

  return NextResponse.json(legacyPayload);
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
