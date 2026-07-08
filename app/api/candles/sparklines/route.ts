import { NextResponse } from "next/server";
import { fetchCandles } from "@/lib/polygon-provider";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { cached, mapLimit } from "@/lib/scan-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/candles/sparklines?symbols=AAPL,NVDA — last ~36 session 5m closes for mini charts. */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  const raw = new URL(req.url).searchParams.get("symbols") ?? "";
  const symbols = [...new Set(
    raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
  )].slice(0, 40);
  if (!symbols.length) {
    return NextResponse.json({ ok: true, series: {} as Record<string, number[]> });
  }

  try {
    const cacheKey = `sparklines:${symbols.join(",")}`;
    const series = await cached(cacheKey, 60_000, async () => {
      const out: Record<string, number[]> = {};
      await mapLimit(symbols, 4, async (symbol) => {
        const res: any = await fetchCandles(symbol, { resolution: "5", timespan: "minute", days: 1, countback: 40 });
        if (res?.available === false || !res?.bars?.length) return;
        const closes = res.bars.map((b: { c: number }) => b.c).filter((c: number) => Number.isFinite(c));
        if (closes.length >= 2) out[symbol] = closes.slice(-36);
      });
      return out;
    });
    return NextResponse.json({ ok: true, series });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? "sparklines failed", series: {} }, { status: 500 });
  }
}
