import { NextResponse } from "next/server";
import { fetchOptionChain } from "@/lib/polygon-provider";
import { optionsLiquidityScore, ivToPct } from "@/lib/alert-scoring";
import { rankZeroDteContracts, zeroDteContractScore, expectedRemainingMovePct } from "@/lib/zero-dte";
import { optionsPressure } from "@/lib/options-pressure";
import { minutesToClose } from "@/lib/db";
import { checkApiToken, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Contract Reality Check payload for one ranked contract. Research data —
 * preferred-zone flags and ratings, never directives. */
function realityCheck(c: any, minsToClose: number, expRemainPct: number) {
  const under = c.underlyingPrice ?? null;
  const mid = c.mid ?? null;
  const breakeven = c.strike != null && mid != null ? (c.side === "put" ? c.strike - mid : c.strike + mid) : null;
  const premiumPctOfSpot = under && mid != null ? +((mid / under) * 100).toFixed(2) : null;
  const estMoveNeededPct = under && breakeven != null ? +((Math.abs(breakeven - under) / under) * 100).toFixed(2) : null;
  const scored = zeroDteContractScore(c, { minsToClose, expRemainPct });
  return {
    ...c,
    contractScore: scored.score,
    flags: scored.flags,
    breakeven: breakeven != null ? +breakeven.toFixed(2) : null,
    premiumPctOfSpot,
    estMoveNeededPct,
    expectedRemainingMovePct: expRemainPct,
    premiumRisk: scored.flags.premiumTooExpensive ? "High" : premiumPctOfSpot != null && estMoveNeededPct != null && estMoveNeededPct > expRemainPct ? "Medium" : "Low",
    thetaRisk: scored.flags.thetaRiskHigh ? "High" : minsToClose > 240 ? "Medium" : "Medium",
    ivRisk: scored.flags.ivTooHot ? "High" : (ivToPct(c.iv) ?? 0) > 150 ? "Medium" : "Low",
    liquidityRating: (c.volume ?? 0) >= 2000 || (c.openInterest ?? 0) >= 1000 ? "Good" : (c.volume ?? 0) >= 300 ? "Fair" : "Thin",
    spreadRating: c.spreadPct == null ? "Unknown" : c.spreadPct <= 4 ? "Tight" : c.spreadPct <= 10 ? "OK" : "Wide",
  };
}

/** GET /api/options/:ticker — chain + liquidity read.
 *  ?zero=1 — 0DTE mode: nearest-expiry chain, best call + best put reality
 *  check, and the options-pressure confirmation read. */
export async function GET(req: Request, { params }: { params: Promise<{ ticker: string }> }) {
  if (!checkApiToken(req)) return unauthorized();
  const { ticker } = await params;
  const zero = new URL(req.url).searchParams.get("zero") === "1";
  try {
    let res: any;
    if (zero) {
      res = await fetchOptionChain(ticker, { dteMin: 0, dteMax: 1, maxPages: 2 });
      if (!res?.available || !res.contracts?.length) res = await fetchOptionChain(ticker, { dteMin: 0, dteMax: 5, maxPages: 2 });
    } else {
      res = await fetchOptionChain(ticker, {});
    }
    if (res?.available === false) {
      return NextResponse.json({ ok: false, error: res.note ?? "chain unavailable", contracts: [] }, { status: 502 });
    }

    if (zero) {
      const mins = minutesToClose();
      const expRemain = expectedRemainingMovePct({ shortRate: 0.2, minsToClose: mins }); // neutral estimate for browsing
      const bestCalls = rankZeroDteContracts(res.contracts, "call", { minsToClose: mins, expRemainPct: expRemain, max: 3 } as any);
      const bestPuts = rankZeroDteContracts(res.contracts, "put", { minsToClose: mins, expRemainPct: expRemain, max: 3 } as any);
      return NextResponse.json({
        ok: true,
        ticker: res.underlying,
        minsToClose: mins,
        pressure: optionsPressure(res.contracts),
        bestCalls: bestCalls.map((r: any) => realityCheck(r.contract, mins, expRemain)),
        bestPuts: bestPuts.map((r: any) => realityCheck(r.contract, mins, expRemain)),
        note: "Reality check is research data (ratings + required move), not a recommendation.",
      });
    }

    const contracts = (res.contracts ?? []).map((c: any) => {
      const liq = optionsLiquidityScore(c);
      const absDelta = c.delta != null ? Math.abs(c.delta) : null;
      return {
        ...c,
        liquidityScore: liq.score,
        inPreferredDeltaZone: absDelta != null && absDelta >= 0.3 && absDelta <= 0.7,
        thin: (c.volume ?? 0) < 5 && (c.openInterest ?? 0) < 50,
        wideSpread: c.spreadPct != null && c.spreadPct > 15,
        highIvFlag: c.iv != null && (c.iv <= 5 ? c.iv * 100 : c.iv) > 150,
      };
    });
    return NextResponse.json({ ok: true, ticker: res.underlying, count: contracts.length, contracts });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? "options fetch failed" }, { status: 500 });
  }
}
