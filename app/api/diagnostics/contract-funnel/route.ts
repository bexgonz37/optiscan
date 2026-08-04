import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/diagnostics/contract-funnel — where contract discovery actually loses
 * candidates, and how the selected contract's delta was established.
 *
 * This is the endpoint the roadmap's own validation step required and could not
 * use: "confirm deltaSource splits sensibly between PROVIDER_DELTA and
 * MONEYNESS_PROXY". The evidence was computed per candidate since `a4777ec` and
 * discarded, so no query could answer it.
 *
 * Reads PERSISTED evidence only. Makes no provider call, spends no quota, and
 * holds no send authority. `?date=YYYY-MM-DD` scopes to a session, `?symbol=` and
 * `?side=` slice the split.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const { tradingDay } = await import("@/lib/trading-session");
    const {
      deltaSourceSplitOnDb, terminalReasonBreakdownOnDb, readRecentFunnelEvidenceOnDb,
      strategyStageBreakdownOnDb,
    } = await import("@/lib/research/options/contract-funnel-store");
    const { evaluateDiscoveryHealth, rankAlerts } = await import("@/lib/research/options/discovery-monitor");
    const { getDb } = await import("@/lib/db");

    const date = url.searchParams.get("date") ?? tradingDay(Date.now());
    const symbol = url.searchParams.get("symbol") ?? undefined;
    const sideParam = url.searchParams.get("side");
    const side = sideParam === "call" || sideParam === "put" ? sideParam : undefined;
    const windowMs = Math.max(60_000, Number(url.searchParams.get("windowMs") ?? 15 * 60_000));

    const db = getDb() as never;
    // One scope, applied to all three readers. Two of them used to ignore it and
    // return global counts under a `scope` header that claimed the filter had
    // been applied — so `?symbol=SPY` attributed every symbol's PROVIDER_ERRORs
    // to SPY, and an impossible symbol still reported the full global funnel.
    const scope: { symbol?: string; side?: "call" | "put" } = { symbol, side };
    const split = deltaSourceSplitOnDb(db, date, scope);
    const terminalReasons = terminalReasonBreakdownOnDb(db, date, scope);
    const recent = readRecentFunnelEvidenceOnDb(db, date, Date.now() - windowMs, 2000, scope);
    // Which strategy asked, and how far the chain it was given actually got. A
    // terminal reason alone cannot distinguish "the date math dropped valid
    // contracts" from "this strategy asked for a band the fetch never requested".
    const strategyStages = strategyStageBreakdownOnDb(db, date, scope);

    // Run the monitor over every (symbol, side) present in the window. It reads
    // persisted evidence only and cannot send anything.
    const groups = new Map<string, typeof recent>();
    for (const e of recent) {
      const k = `${e.symbol}|${e.requestedSide}`;
      const g = groups.get(k);
      if (g) g.push(e); else groups.set(k, [e]);
    }
    const alerts = rankAlerts(
      [...groups.entries()].flatMap(([k, list]) => {
        const [sym, sd] = k.split("|");
        return evaluateDiscoveryHealth(sym, sd as "call" | "put", list, windowMs);
      }),
    );

    return NextResponse.json({
      ok: true,
      tradingDate: date,
      scope: { symbol: symbol ?? null, side: side ?? null, windowMs },
      deltaSource: {
        ...split,
        // Stays null when nothing was selected. Absence of evidence is not 0%.
        note: split.proxyShareOfSelected == null
          ? "No contract was selected in this scope — the proxy share is UNKNOWN, not 0%."
          : "Share of SELECTED contracts that required the missing-data fallback.",
      },
      terminalReasons,
      strategyStages,
      observedInWindow: recent.length,
      discoveryAlerts: alerts,
      note:
        "Persisted evidence only. No provider call, no quota spend, no send authority. "
        + "MONEYNESS_PROXY is a labelled moneyness rule, NOT an estimated delta.",
    });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
