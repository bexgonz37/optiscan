import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET — owner-private Missed Opportunity forensic. Token-gated and RESEARCH ONLY.
 *
 * Makes ZERO provider calls by default: the whole forensic is answered from
 * persisted decisions and persisted NBBO, which is what makes it safe to run while
 * the minute cap is saturated — including when the thing under investigation is
 * whether the budget caused the miss.
 *
 * `&persist=1` writes cases into `missed_opportunity_cases` only. It never
 * touches a scanner rule, a paper position, a delivery decision, or Discord.
 * `productionChanged` is recorded as false on every row so the invariant is
 * auditable rather than merely asserted.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const { getDb } = await import("@/lib/db");
    const { tradingDay } = await import("@/lib/trading-session");
    const { runSymbolForensic } = await import("@/lib/research/missed-opportunity/forensic");
    const { saveMissedOpportunityCase, listMissedOpportunityCases, rootCauseTally } =
      await import("@/lib/research/missed-opportunity/store");

    const db = getDb() as any;
    const nowMs = Date.now();
    const sessionDate = url.searchParams.get("date") || tradingDay();
    const persist = url.searchParams.get("persist") === "1";
    const thresholdPct = Math.max(Number(url.searchParams.get("threshold") ?? 200) || 200, 1);
    const direction = (url.searchParams.get("direction") ?? "CALL").toUpperCase() === "PUT" ? "PUT" : "CALL";
    const claimedRaw = url.searchParams.get("claimed");
    const claimedReturnPct = claimedRaw != null && claimedRaw !== "" ? Number(claimedRaw) : null;

    const symbols = (url.searchParams.get("symbols") ?? "SPY,NVDA,QQQ")
      .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 20);

    // Session bounds. A closed session is the only honest forensic window; an
    // open one is reported as partial rather than silently graded as complete.
    const { regularOpenMs, regularCloseMs } = sessionBounds(sessionDate);
    const sessionComplete = nowMs >= regularCloseMs;

    const results = symbols.map((symbol) => {
      const r = runSymbolForensic({
        db, symbol, sessionDate,
        sessionFromMs: regularOpenMs,
        sessionToMs: Math.min(nowMs, regularCloseMs + 4 * 60 * 60 * 1000),
        winnerDirection: direction as "CALL" | "PUT",
        thresholdPct,
        claimedReturnPct: Number.isFinite(claimedReturnPct as number) ? (claimedReturnPct as number) : null,
        claimSource: url.searchParams.get("source"),
        nowMs,
      });
      if (persist) saveMissedOpportunityCase(db, r.case);
      return r;
    });

    return NextResponse.json({
      ok: true,
      researchOnly: true,
      productionChanged: false,
      sessionDate,
      sessionComplete,
      thresholdPct,
      direction,
      persisted: persist,
      evidenceTiers: {
        nbbo: "bid/ask captured live by OptiScan — the only tier that can reach VERIFIED_EXECUTABLE",
        trade: "minute aggregates fetched after the fact — capped at LAST_TRADE_ONLY, never executable",
      },
      results: results.map((r) => ({
        symbol: r.case.symbol,
        verdict: r.case.externalClaim.verdict,
        executableReturnPct: r.case.verified.executableReturnPct,
        bestOcc: r.bestOcc,
        contractsWithNbbo: r.contractsWithNbbo,
        nbboObservations: r.nbboObservations,
        nbboCallContracts: r.nbboCallContracts,
        nbboPutContracts: r.nbboPutContracts,
        rootCause: r.case.rootCause,
        secondaryCauses: r.case.secondaryCauses,
        failureFamily: r.case.failureFamily,
        recoverability: r.case.recoverability,
        evidenceQuality: r.case.evidenceQuality,
        regularScanner: r.case.regularScanner,
        highAsymmetry: r.case.highAsymmetry,
        timeline: r.case.timeline,
        ladder: r.case.verified.ladder,
        diagnostics: r.case.verified.measured,
        notes: r.notes,
      })),
      storedCases: persist ? listMissedOpportunityCases(db, { sessionDate }).length : null,
      recurringDefects: rootCauseTally(db, sessionDate),
    });
  } catch (err) {
    return jsonFromRouteError(err, { route: "missed-opportunity" });
  }
}

/** RTH bounds for a session date, in UTC ms. ET is UTC-4 during DST. */
function sessionBounds(sessionDate: string): { regularOpenMs: number; regularCloseMs: number } {
  const [y, m, d] = sessionDate.split("-").map(Number);
  // 09:30 ET / 16:00 ET expressed in UTC for an EDT date.
  const regularOpenMs = Date.UTC(y, (m ?? 1) - 1, d ?? 1, 13, 30, 0);
  const regularCloseMs = Date.UTC(y, (m ?? 1) - 1, d ?? 1, 20, 0, 0);
  return { regularOpenMs, regularCloseMs };
}
