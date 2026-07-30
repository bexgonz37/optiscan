import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET — read-only professional Watchlist. Returns the persisted overnight plan
 * and premarket update for a trading day plus the outcome summary. Performs no
 * writes and no provider calls; building is owned by the scheduler / POST.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const { getDb } = await import("@/lib/db");
    const { tradingDay } = await import("@/lib/trading-session");
    const { loadProfessionalPlanOnDb, loadWatchlistOutcomesOnDb } = await import("@/lib/research/watchlist/professional-store");
    const { summarizeWatchlistOutcomes } = await import("@/lib/research/watchlist/outcomes");
    const { researchFlags } = await import("@/lib/research/flags");

    const db = getDb() as any;
    const day = url.searchParams.get("date") || tradingDay();
    const overnight = loadProfessionalPlanOnDb(db, day, "OVERNIGHT_PLAN");
    const premarket = loadProfessionalPlanOnDb(db, day, "PREMARKET_UPDATE");
    const outcomes = loadWatchlistOutcomesOnDb(db, { tradingDay: day });

    return NextResponse.json({
      ok: true,
      readOnly: true,
      enabled: researchFlags().professionalWatchlist,
      tradingDay: day,
      overnightPlan: overnight,
      premarketUpdate: premarket,
      outcomes: summarizeWatchlistOutcomes(outcomes),
      safety: {
        advisoryOnly: true,
        productionBehaviorChanged: false,
        note: "A published trigger is not TRADE READY. Every triggered row still passes through the canonical options SEND path and its gates.",
      },
    }, { status: 200 });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}

/**
 * POST — explicit, bounded build of one Watchlist phase. Never sends Discord and
 * never changes scanner, authority, or delivery behaviour. A no-op unless
 * PROFESSIONAL_WATCHLIST_ENABLED=1.
 */
export async function POST(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const body = await req.json().catch(() => ({}));
    const phase = body?.phase === "PREMARKET_UPDATE" ? "PREMARKET_UPDATE" : "OVERNIGHT_PLAN";
    const { getDb } = await import("@/lib/db");
    const { runProfessionalWatchlistOnDb, liveProfessionalWatchlistDeps } = await import("@/lib/research/watchlist/professional-runner");
    const result = await runProfessionalWatchlistOnDb(
      getDb() as any,
      liveProfessionalWatchlistDeps(),
      {
        phase,
        maxSymbols: Number.isFinite(Number(body?.maxSymbols)) ? Number(body.maxSymbols) : undefined,
        providerCallBudget: Number.isFinite(Number(body?.providerCallBudget)) ? Number(body.providerCallBudget) : undefined,
      },
    );
    return NextResponse.json({ ok: result.errors.length === 0, result }, { status: 200 });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
