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

    const db = getDb() as any;
    // One scope, applied to all three readers. Two of them used to ignore it and
    // return global counts under a `scope` header that claimed the filter had
    // been applied — so `?symbol=SPY` attributed every symbol's PROVIDER_ERRORs
    // to SPY, and an impossible symbol still reported the full global funnel.
    const scope: { symbol?: string; side?: "call" | "put" } = { symbol, side };
    const split = deltaSourceSplitOnDb(db, date, scope);
    const terminalReasons = terminalReasonBreakdownOnDb(db, date, scope);
    const recent = readRecentFunnelEvidenceOnDb(db, date, Date.now() - windowMs, 2000, scope);
    const recentSinceMs = Date.now() - windowMs;
    const quoteByKey = (() => {
      try {
        const where = ["session_date = ?", "observed_at_ms >= ?", "option_symbol IS NOT NULL", "TRIM(option_symbol) <> ''"];
        const args: unknown[] = [date, recentSinceMs];
        if (symbol) { where.push("symbol = ?"); args.push(symbol); }
        if (side) { where.push("option_type = ?"); args.push(side); }
        const rows = db.prepare(
          `SELECT observed_at_ms, symbol, option_symbol, option_type, strategy_family,
                  underlying_price, option_bid, option_ask, spread_pct, quote_timestamp_ms,
                  quote_age_ms, volume, open_interest, delta, dte, freshness_state,
                  readiness_state, contract_quality_state, candidate_state
             FROM options_research_observations
            WHERE ${where.join(" AND ")}
            ORDER BY observed_at_ms DESC, CASE candidate_state
              WHEN 'READY' THEN 0
              WHEN 'QUOTE_VALIDATED' THEN 1
              WHEN 'CONTRACT_SELECTED' THEN 2
              ELSE 3
            END
            LIMIT 2000`,
        ).all(...args) as Record<string, unknown>[];
        const out = new Map<string, Record<string, unknown>>();
        for (const row of rows) {
          const key = `${String(row.symbol ?? "").toUpperCase()}|${String(row.option_symbol ?? "")}|${Number(row.observed_at_ms ?? 0)}`;
          if (!out.has(key)) out.set(key, row);
        }
        return out;
      } catch {
        return new Map<string, Record<string, unknown>>();
      }
    })();
    const selectedQuoteFor = (e: (typeof recent)[number]) => {
      if (!e.selectedOcc) return null;
      const row = quoteByKey.get(`${e.symbol.toUpperCase()}|${e.selectedOcc}|${e.atMs}`);
      if (!row) return null;
      const num = (v: unknown) => v == null || v === "" ? null : Number(v);
      return {
        optionSymbol: String(row.option_symbol ?? ""),
        optionType: row.option_type == null ? null : String(row.option_type),
        strategyFamily: row.strategy_family == null ? null : String(row.strategy_family),
        underlyingPrice: num(row.underlying_price),
        bid: num(row.option_bid),
        ask: num(row.option_ask),
        spreadPct: num(row.spread_pct),
        quoteTimestampMs: num(row.quote_timestamp_ms),
        quoteAgeMs: num(row.quote_age_ms),
        volume: num(row.volume),
        openInterest: num(row.open_interest),
        delta: num(row.delta),
        dte: num(row.dte),
        freshnessState: row.freshness_state == null ? null : String(row.freshness_state),
        readinessState: row.readiness_state == null ? null : String(row.readiness_state),
        contractQualityState: row.contract_quality_state == null ? null : String(row.contract_quality_state),
        candidateState: row.candidate_state == null ? null : String(row.candidate_state),
      };
    };
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
      terminalReasonUnits:
        "count = contract-selection ATTEMPTS (one per candidate evaluation); distinctSymbols = unique "
        + "underlyings. A symbol blocked all session is re-attempted every cooldown, so attempts are "
        + "many times distinct symbols. Quote both, never one as the other.",
      strategyStages,
      observedInWindow: recent.length,
      recentSample: recent.slice(0, 100).map((e) => ({
        atMs: e.atMs,
        symbol: e.symbol,
        direction: e.direction,
        requestedSide: e.requestedSide,
        strategyKey: e.strategyKey,
        terminalReason: e.terminalReason,
        selectedOcc: e.selectedOcc,
        requestedDteMin: e.requestedDteMin,
        requestedDteMax: e.requestedDteMax,
        fetchedDteRanges: e.fetchedDteRanges,
        requestedExpirationStart: e.requestedExpirationStart,
        requestedExpirationEnd: e.requestedExpirationEnd,
        expirationsCovered: e.expirationsCovered,
        rangeCoverage: e.rangeCoverage,
        chainOutcome: e.chainOutcome,
        pageLimitReached: e.pageLimitReached,
        pagesRequested: e.pagesRequested,
        pagesReceived: e.pagesReceived,
        rawContractsReceived: e.rawContractsReceived,
        normalizedContractsReceived: e.normalizedContractsReceived,
        contractsReceived: e.contractsReceived,
        passedSide: e.passedSide,
        passedDte: e.passedDte,
        twoSided: e.twoSided,
        withDelta: e.withDelta,
        deltaCoverage: e.deltaCoverage,
        rankedCount: e.rankedCount,
        deltaSource: e.deltaSource,
        selectedQuote: selectedQuoteFor(e),
      })),
      discoveryAlerts: alerts,
      note:
        "Persisted evidence only. No provider call, no quota spend, no send authority. "
        + "MONEYNESS_PROXY is a labelled moneyness rule, NOT an estimated delta.",
    });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
