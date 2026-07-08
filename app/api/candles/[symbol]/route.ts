import { NextResponse } from "next/server";
import { fetchCandles, getCallStats } from "@/lib/polygon-provider";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { cached } from "@/lib/scan-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/candles/:symbol — OHLCV bars for the chart panel.
 * Cached per symbol+timeframe so the chart drawer does not burn the shared
 * Massive minute budget (scanner loop has priority).
 */

const PRESETS: Record<string, { res: string; span: string; days?: number; lookbackMs?: number }> = {
  "1s": { res: "1", span: "second", lookbackMs: 15 * 60_000 },
  "1m": { res: "1", span: "minute", days: 1 },
  "5m": { res: "5", span: "minute", days: 5 },
  "15m": { res: "15", span: "minute", days: 10 },
  "1D": { res: "1", span: "day", days: 180 },
};

/** Server cache TTL — chart client polls slower; this dedupes bursts. */
const CACHE_TTL_MS: Record<string, number> = {
  "1s": 10_000,
  "1m": 25_000,
  "5m": 45_000,
  "15m": 60_000,
  "1D": 120_000,
};

/** Last good response when quota is hot — stale-while-revalidate for charts. */
const lastGood = new Map<string, { bars: unknown[]; ts: number }>();

function quotaMessage(stats: ReturnType<typeof getCallStats>): string {
  return `Massive API budget busy (${stats.callsThisMinute}/${stats.minuteCap} this minute). Scanner has priority — wait ~30s or use the live price header.`;
}

export async function GET(req: Request, { params }: { params: Promise<{ symbol: string }> }) {
  if (!checkApiToken(req)) return unauthorized();
  const { symbol } = await params;
  const sym = String(symbol ?? "").toUpperCase();
  if (!sym) {
    return NextResponse.json({ ok: false, error: "No symbol", bars: [] }, { status: 400 });
  }

  const url = new URL(req.url);
  const tf = url.searchParams.get("tf") ?? "1m";
  const preset = PRESETS[tf] ?? null;

  const resolution = preset?.res ?? url.searchParams.get("res") ?? "5";
  const timespan = preset?.span ?? url.searchParams.get("span") ?? "minute";
  const days = preset?.days ?? Number(url.searchParams.get("days") ?? 2);
  const lookbackMs = preset?.lookbackMs;
  const nowMs = Date.now();
  const from = lookbackMs ? new Date(nowMs - lookbackMs).toISOString() : undefined;
  const to = lookbackMs ? new Date(nowMs).toISOString() : undefined;

  const cacheKey = `candles:${sym}:${tf}`;
  const ttl = CACHE_TTL_MS[tf] ?? 30_000;
  const stats = getCallStats(nowMs);

  /** Reserve ~15% of the minute cap for the scanner loop. */
  const chartBudgetOk =
    !(stats.minuteCap > 0) || stats.callsThisMinute < Math.floor(stats.minuteCap * 0.85);

  if (stats.quotaExceeded || !chartBudgetOk) {
    const stale = lastGood.get(cacheKey);
    if (stale?.bars?.length) {
      return NextResponse.json({
        ok: true,
        symbol: sym,
        resolution,
        timespan,
        bars: stale.bars,
        stale: true,
        quotaBusy: true,
        note: quotaMessage(stats),
      });
    }
    return NextResponse.json(
      { ok: false, error: quotaMessage(stats), quotaBusy: true, bars: [] },
      { status: 429 },
    );
  }

  try {
    const out = await cached(cacheKey, ttl, async () => {
      const result: any = await fetchCandles(sym, {
        resolution,
        timespan,
        days: lookbackMs ? 1 : days,
        from,
        to,
        countback: lookbackMs ? 900 : undefined,
      });
      if (result?.available === false) {
        const note = String(result.note ?? "candles unavailable");
        if (note.includes("quota_exceeded")) throw Object.assign(new Error(note), { quotaBusy: true });
        throw new Error(note);
      }
      return result;
    });

    const bars = out?.bars ?? [];
    if (bars.length) lastGood.set(cacheKey, { bars, ts: Date.now() });

    return NextResponse.json({
      ok: true,
      symbol: sym,
      resolution,
      timespan,
      bars,
    });
  } catch (err: any) {
    const quotaBusy = Boolean(err?.quotaBusy) || String(err?.message ?? "").includes("quota_exceeded");
    const stale = lastGood.get(cacheKey);
    if (quotaBusy && stale?.bars?.length) {
      return NextResponse.json({
        ok: true,
        symbol: sym,
        resolution,
        timespan,
        bars: stale.bars,
        stale: true,
        quotaBusy: true,
        note: quotaMessage(getCallStats()),
      });
    }
    return NextResponse.json(
      {
        ok: false,
        error: quotaBusy ? quotaMessage(getCallStats()) : (err?.message ?? "candles fetch failed"),
        quotaBusy,
        bars: [],
      },
      { status: quotaBusy ? 429 : 500 },
    );
  }
}
