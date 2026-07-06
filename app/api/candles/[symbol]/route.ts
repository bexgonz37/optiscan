import { NextResponse } from "next/server";
import { fetchCandles } from "@/lib/polygon-provider";
import { checkApiToken, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/candles/:symbol — OHLCV bars for the chart panel.
 * Query: res (multiplier, default 5), span (timespan, default minute), days.
 * Timeframe presets map to (res, span, days): 1m -> (1,minute,1),
 * 5m -> (5,minute,5), 1D -> (1,day,180).
 */

const PRESETS: Record<string, { res: string; span: string; days: number }> = {
  "1m": { res: "1", span: "minute", days: 1 },
  "5m": { res: "5", span: "minute", days: 5 },
  "1D": { res: "1", span: "day", days: 180 },
};

export async function GET(req: Request, { params }: { params: Promise<{ symbol: string }> }) {
  if (!checkApiToken(req)) return unauthorized();
  const { symbol } = await params;
  const url = new URL(req.url);
  const tf = url.searchParams.get("tf");
  const preset = tf ? PRESETS[tf] : null;

  const resolution = preset?.res ?? url.searchParams.get("res") ?? "5";
  const timespan = preset?.span ?? url.searchParams.get("span") ?? "minute";
  const days = preset?.days ?? Number(url.searchParams.get("days") ?? 2);

  try {
    const out: any = await fetchCandles(symbol, { resolution, timespan, days });
    if (out?.available === false) {
      return NextResponse.json({ ok: false, error: out.note ?? "candles unavailable", bars: [] }, { status: 502 });
    }
    return NextResponse.json({
      ok: true,
      symbol: String(symbol).toUpperCase(),
      resolution,
      timespan,
      bars: out.bars ?? [],
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? "candles fetch failed", bars: [] }, { status: 500 });
  }
}
