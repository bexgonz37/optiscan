import { NextResponse } from "next/server";
import { fetchOptionChain } from "@/lib/polygon-provider";
import { optionsLiquidityScore } from "@/lib/alert-scoring";
import { checkApiToken, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/options/:ticker — chain snapshot + liquidity read per contract
 * (research data; preferred-zone flags only, no directives). */
export async function GET(req: Request, { params }: { params: Promise<{ ticker: string }> }) {
  if (!checkApiToken(req)) return unauthorized();
  const { ticker } = await params;
  try {
    const res: any = await fetchOptionChain(ticker, {});
    if (res?.available === false) {
      return NextResponse.json({ ok: false, error: res.note ?? "chain unavailable", contracts: [] }, { status: 502 });
    }
    const contracts = (res.contracts ?? []).map((c: any) => {
      const liq = optionsLiquidityScore(c);
      const absDelta = c.delta != null ? Math.abs(c.delta) : null;
      return {
        ...c,
        liquidityScore: liq.score,
        // "preferred zone" = |delta| 0.30-0.70 with a workable market — a
        // research filter, not a recommendation.
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
