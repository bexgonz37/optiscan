import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/diagnostics/alert-decision?ticker=META&timestamp=2026-07-09T14:30:00Z
 *
 * Full decision transparency: reconstructs, from 1-minute bars, what the
 * scanner saw for a ticker at a moment in time and why it did or did not
 * alert. Nothing is hidden — every rule reports pass/fail with the exact
 * threshold. HONESTY NOTE baked into the response: the live burst gates run
 * on 10-SECOND windows which 1-minute bars cannot reproduce; burst gates are
 * therefore evaluated on best-1-minute-velocity with that caveat attached,
 * while the day-timeframe major-move detector is reconstructed exactly.
 *
 * Cost: 2 metered candle fetches (ticker + SPY) per request. Manual use.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();

  const url = new URL(req.url);
  const ticker = String(url.searchParams.get("ticker") ?? "").toUpperCase().trim();
  const tsRaw = url.searchParams.get("timestamp") ?? "";
  const tsMs = /^\d+$/.test(tsRaw) ? Number(tsRaw) : Date.parse(tsRaw);
  if (!ticker || !Number.isFinite(tsMs)) {
    return NextResponse.json({ ok: false, error: "ticker and timestamp (ISO or epoch ms) required" }, { status: 400 });
  }

  const { fetchCandles } = await import("@/lib/polygon-provider");
  const { vwap: sessionVwap, sessionBars } = await import("@/lib/momentum-signals");
  const { detectMajorMove } = await import("@/lib/major-move");
  const { isCoreSymbol } = await import("@/lib/universe");
  const { getSettingNum } = await import("@/lib/alert-store");
  const { marketSession } = await import("@/lib/trading-session");

  const day = new Date(tsMs).toISOString().slice(0, 10);
  const [res, spyRes] = await Promise.all([
    fetchCandles(ticker, { resolution: "1", timespan: "minute", from: `${day}T00:00:00Z`, to: new Date(tsMs + 60_000).toISOString() }),
    fetchCandles("SPY", { resolution: "1", timespan: "minute", from: `${day}T00:00:00Z`, to: new Date(tsMs + 60_000).toISOString() }),
  ]);
  const bars: any[] = (res as any)?.available ? (res as any).bars.filter((b: any) => b.t <= tsMs) : [];
  if (bars.length < 5) {
    return NextResponse.json({
      ok: false, ticker, timestamp: new Date(tsMs).toISOString(),
      error: "insufficient 1-minute bars up to that timestamp — check the date/provider plan",
      dataAvailable: { bars: bars.length, provider: (res as any)?.note ?? "ok" },
    }, { status: 422 });
  }

  const px = (i: number) => bars[Math.max(0, bars.length - 1 - i)].c;
  const last = bars[bars.length - 1];
  const dayOpen = bars[0].o;
  const dayHigh = Math.max(...bars.map((b) => b.h));
  const cumVol = bars.reduce((s, b) => s + (b.v ?? 0), 0);
  const changePct = (from: number) => ((last.c - from) / from) * 100;
  const rate1m = bars.length >= 2 ? changePct(px(1)) : null;                    // %/min over last 1 bar
  const rate5m = bars.length >= 6 ? changePct(px(5)) / 5 : null;               // avg %/min over 5
  const bestRate1m = Math.max(...bars.slice(-30).map((b, i, a) => (i ? ((b.c - a[i - 1].c) / a[i - 1].c) * 100 : 0)));
  const dayMovePct = changePct(dayOpen);
  const vwap = sessionVwap(sessionBars(bars));
  const vwapDistPct = vwap ? ((last.c - vwap) / vwap) * 100 : null;
  const avgBarVol = cumVol / bars.length;
  const relVolNow = avgBarVol > 0 ? (last.v ?? 0) / avgBarVol : null;
  const volAccel = bars.length >= 10
    ? (bars.slice(-5).reduce((s, b) => s + b.v, 0) / 5) / Math.max(1, bars.slice(-10, -5).reduce((s, b) => s + b.v, 0) / 5)
    : null;
  const hodBreakNow = last.h >= dayHigh - 1e-9 && last.c > bars[Math.max(0, bars.length - 6)].h;

  // SPY relative strength over the same window
  const spyBars: any[] = (spyRes as any)?.available ? (spyRes as any).bars.filter((b: any) => b.t <= tsMs) : [];
  const spyDayMove = spyBars.length ? ((spyBars[spyBars.length - 1].c - spyBars[0].o) / spyBars[0].o) * 100 : null;
  const spyRelative = spyDayMove != null ? +(dayMovePct - spyDayMove).toFixed(2) : null;

  // Burst gates (live thresholds), evaluated on the best 1-minute velocity.
  const core = isCoreSymbol(ticker);
  const minRate = getSettingNum("scanner_min_rate_pct_min", Number(process.env.SCANNER_MIN_RATE_PCT_MIN ?? 0.17)) * (core ? 0.9 : 1);
  const minSurge = getSettingNum("scanner_min_vol_surge", Number(process.env.SCANNER_MIN_VOL_SURGE ?? 1.32));
  const rules: Array<{ rule: string; passed: boolean; value: string; threshold: string; note?: string }> = [
    { rule: "universe membership", passed: true, value: core ? "core watch" : "discovery-eligible", threshold: "must be monitorable" },
    { rule: "burst velocity (10s live gate)", passed: bestRate1m >= minRate, value: `best 1-min ${bestRate1m.toFixed(2)}%/min`, threshold: `${minRate.toFixed(2)}%/min`, note: "live gate uses 10s windows; 1-min bars UNDERSTATE bursts and cannot fully reproduce them" },
    { rule: "volume surge", passed: (relVolNow ?? 0) >= minSurge, value: `bar RVOL ${relVolNow?.toFixed(2) ?? "n/a"}x`, threshold: `${minSurge}x (15s live window)` },
    { rule: "VWAP structure", passed: vwapDistPct != null && (dayMovePct >= 0 ? vwapDistPct > 0 : vwapDistPct < 0), value: `VWAP dist ${vwapDistPct?.toFixed(2) ?? "n/a"}%`, threshold: "on the move's side" },
    { rule: "HOD break", passed: hodBreakNow, value: hodBreakNow ? "breaking day high" : "below day high", threshold: "level break assists trigger" },
  ];

  // Day-timeframe major-move detector (exact reconstruction).
  const major = detectMajorMove({
    symbol: ticker, price: last.c, movePct: dayMovePct, volume: cumVol,
    relVol: relVolNow, aboveVwap: vwapDistPct != null ? vwapDistPct > 0 : null, core,
  });

  const burstWouldFire = rules.slice(1).every((r) => r.passed);
  const reason = burstWouldFire
    ? "burst gates likely passed at this resolution — if no alert fired live, check cooldowns/near-misses for this window"
    : major.detected
      ? `no 10-second burst (this was a grind move) — burst gates correctly stayed quiet, but the DAY-TIMEFRAME detector now flags it as "${major.status}"`
      : `neither a burst nor a qualifying day-timeframe move at this moment: ${rules.filter((r) => !r.passed).map((r) => r.rule).join(", ")} failed`;

  return NextResponse.json({
    ok: true,
    report: {
      ticker,
      timestamp: new Date(tsMs).toISOString(),
      session: marketSession(tsMs),
      priceChange: { day: +dayMovePct.toFixed(2), last1m: rate1m != null ? +rate1m.toFixed(3) : null, avg5m: rate5m != null ? +rate5m.toFixed(3) : null, best1mBurst: +bestRate1m.toFixed(3) },
      relativeVolume: relVolNow != null ? +relVolNow.toFixed(2) : null,
      volumeAcceleration: volAccel != null ? +volAccel.toFixed(2) : null,
      dollarVolume: +(cumVol * last.c).toFixed(0),
      distanceFromVwapPct: vwapDistPct != null ? +vwapDistPct.toFixed(2) : null,
      breakoutLevel: { dayHigh: +dayHigh.toFixed(2), breakingNow: hodBreakNow },
      spyRelativeStrengthPct: spyRelative,
      sectorRelativeStrength: "not wired in v1 (needs sector-ETF mapping)",
      optionsActivity: "not reconstructed in v1 (historical chain snapshots unavailable retroactively)",
      rulesPassed: rules.filter((r) => r.passed),
      rulesFailed: rules.filter((r) => !r.passed),
      majorMoveDetector: major,
      finalScore: null,
      reasonNoAlert: reason,
      honesty: "Live burst gates evaluate 10-second windows; 1-minute reconstruction understates bursts. Day-timeframe detection is exact.",
    },
  });
}
