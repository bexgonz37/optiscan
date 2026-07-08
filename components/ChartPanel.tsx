"use client";

/**
 * ChartPanel — right-side drawer with one live chart (1m/5m/15m/1D tabs).
 * Candles refresh every 1s while open; price header uses the live scanner tape.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
} from "lightweight-charts";
import { scanHeaders } from "@/hooks/useScanner";
import { liveCtxFor, useLiveTapeMap } from "@/hooks/useLiveTapeMap";
import { VerdictPreviewBlock } from "@/components/VerdictPreviewBlock";
import { fmtPrice, fmtPct, fmtInt, pctClass, fmtPremium, fmtNum } from "@/lib/format";
import {
  CHART_TIMEFRAMES,
  CHART_INDICATORS,
  DEFAULT_CHART_INDICATORS,
  loadDashboardPrefs,
  saveDashboardPrefs,
  type ChartTimeframe,
  type ChartIndicator,
} from "@/lib/dashboard-prefs";
import {
  emaSeries,
  smaSeries,
  rsiSeries,
  macdSeries,
  vwapSeries,
  toLine,
  keyLevels,
  type Bar,
  type KeyLevel,
} from "@/lib/chart-indicators";

const INDICATOR_LABELS: Record<ChartIndicator, string> = {
  vwap: "VWAP",
  ema9: "EMA 9",
  ema21: "EMA 21",
  sma50: "SMA 50",
  rsi: "RSI",
  macd: "MACD",
};

const CHART_LIVE_POLL_MS = 1000;
const VERDICT_DEFER_MS = 700;
const VERDICT_POLL_MS = 5000;
const OPTIONS_DEFER_MS = 500;

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function chartLevels(bars: Bar[], indicators: ChartIndicator[]): KeyLevel[] {
  const levels = keyLevels(bars);
  if (indicators.includes("vwap")) return levels.filter((l) => l.id !== "vwap");
  return levels;
}

function applyKeyLevelLines(candle: ISeriesApi<"Candlestick">, levels: KeyLevel[]) {
  const amber = cssVar("--amber", "#ffb020");
  const cyan = cssVar("--cyan", "#3ad0ff");
  const muted = cssVar("--muted", "#8798a8");
  const colorFor = (id: string) => (id === "vwap" ? amber : id === "hod" || id === "lod" ? cyan : muted);
  for (const lvl of levels) {
    const showAxis = lvl.id === "hod" || lvl.id === "lod";
    candle.createPriceLine({
      price: lvl.price,
      color: colorFor(lvl.id),
      lineWidth: lvl.id === "hod" || lvl.id === "lod" ? 2 : 1,
      lineStyle: lvl.lineStyle === "dashed" ? 2 : 0,
      axisLabelVisible: showAxis,
      title: showAxis ? lvl.label : "",
    });
  }
}

interface ChartBundle {
  chart: IChartApi;
  candle: ISeriesApi<"Candlestick">;
  volume: ISeriesApi<"Histogram">;
  lines: ISeriesApi<"Line">[];
}

function mountChart(host: HTMLDivElement, bars: Bar[], indicators: ChartIndicator[], tf: ChartTimeframe): ChartBundle {
  const muted = cssVar("--muted", "#8798a8");
  const line = cssVar("--line", "#1f2a37");
  const green = cssVar("--green", "#00d68f");
  const red = cssVar("--red", "#ff5a72");
  const violet = cssVar("--violet", "#8b7dff");
  const cyan = cssVar("--cyan", "#3ad0ff");
  const amber = cssVar("--amber", "#ffb020");

  const chart = createChart(host, {
    layout: { background: { color: "transparent" }, textColor: muted, attributionLogo: false },
    grid: { vertLines: { color: line }, horzLines: { color: line } },
    rightPriceScale: { borderColor: line },
    timeScale: { borderColor: line, timeVisible: tf !== "1D", secondsVisible: false },
    crosshair: { mode: 0 },
    autoSize: true,
  });

  const candle = chart.addSeries(CandlestickSeries, {
    upColor: green,
    downColor: red,
    borderUpColor: green,
    borderDownColor: red,
    wickUpColor: green,
    wickDownColor: red,
  });
  candle.setData(
    bars.map((b) => ({ time: Math.floor(b.t / 1000) as any, open: b.o, high: b.h, low: b.l, close: b.c })),
  );
  applyKeyLevelLines(candle, chartLevels(bars, indicators));

  const closes = bars.map((b) => b.c);
  const lines: ISeriesApi<"Line">[] = [];

  if (indicators.includes("vwap")) {
    const s = chart.addSeries(LineSeries, { color: amber, lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
    s.setData(toLine(bars, vwapSeries(bars)) as any);
    lines.push(s);
  }
  if (indicators.includes("ema9")) {
    const s = chart.addSeries(LineSeries, { color: cyan, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    s.setData(toLine(bars, emaSeries(closes, 9)) as any);
    lines.push(s);
  }
  if (indicators.includes("ema21")) {
    const s = chart.addSeries(LineSeries, { color: violet, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    s.setData(toLine(bars, emaSeries(closes, 21)) as any);
    lines.push(s);
  }
  if (indicators.includes("sma50")) {
    const s = chart.addSeries(LineSeries, { color: muted, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    s.setData(toLine(bars, smaSeries(closes, 50)) as any);
    lines.push(s);
  }

  const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "" }, 1);
  volume.setData(
    bars.map((b) => ({
      time: Math.floor(b.t / 1000) as any,
      value: b.v,
      color: b.c >= b.o ? green : red,
    })),
  );

  let nextPane = 2;
  if (indicators.includes("rsi")) {
    const pane = nextPane++;
    const s = chart.addSeries(LineSeries, { color: violet, lineWidth: 1, lastValueVisible: true }, pane);
    s.setData(toLine(bars, rsiSeries(closes)) as any);
    s.createPriceLine({ price: 70, color: red, lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: "" });
    s.createPriceLine({ price: 30, color: green, lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: "" });
  }
  if (indicators.includes("macd")) {
    const pane = nextPane++;
    const m = macdSeries(closes);
    const hist = chart.addSeries(HistogramSeries, {}, pane);
    hist.setData(
      bars
        .map((b, i) => ({ time: Math.floor(b.t / 1000) as any, value: m.hist[i], i }))
        .filter((p) => p.value != null)
        .map((p) => ({ time: p.time, value: p.value as number, color: (p.value as number) >= 0 ? green : red })),
    );
    const macdLine = chart.addSeries(LineSeries, { color: cyan, lineWidth: 1, lastValueVisible: false }, pane);
    macdLine.setData(toLine(bars, m.macd) as any);
    const sig = chart.addSeries(LineSeries, { color: amber, lineWidth: 1, lastValueVisible: false }, pane);
    sig.setData(toLine(bars, m.signal) as any);
  }

  try {
    const panes = chart.panes();
    if (panes[0]) panes[0].setHeight(tf === "1D" ? 280 : 220);
    for (let i = 1; i < panes.length; i++) panes[i].setHeight(70);
  } catch { /* best effort */ }

  chart.timeScale().fitContent();
  return { chart, candle, volume, lines };
}

function refreshChartData(bundle: ChartBundle, bars: Bar[], indicators: ChartIndicator[]) {
  bundle.candle.setData(
    bars.map((b) => ({ time: Math.floor(b.t / 1000) as any, open: b.o, high: b.h, low: b.l, close: b.c })),
  );
  const closes = bars.map((b) => b.c);
  const green = cssVar("--green", "#00d68f");
  const red = cssVar("--red", "#ff5a72");
  bundle.volume.setData(
    bars.map((b) => ({
      time: Math.floor(b.t / 1000) as any,
      value: b.v,
      color: b.c >= b.o ? green : red,
    })),
  );
  let lineIdx = 0;
  if (indicators.includes("vwap") && bundle.lines[lineIdx]) {
    bundle.lines[lineIdx].setData(toLine(bars, vwapSeries(bars)) as any);
    lineIdx++;
  }
  if (indicators.includes("ema9") && bundle.lines[lineIdx]) {
    bundle.lines[lineIdx].setData(toLine(bars, emaSeries(closes, 9)) as any);
    lineIdx++;
  }
  if (indicators.includes("ema21") && bundle.lines[lineIdx]) {
    bundle.lines[lineIdx].setData(toLine(bars, emaSeries(closes, 21)) as any);
    lineIdx++;
  }
  if (indicators.includes("sma50") && bundle.lines[lineIdx]) {
    bundle.lines[lineIdx].setData(toLine(bars, smaSeries(closes, 50)) as any);
  }
}

export function ChartPanel({
  symbol,
  open,
  onClose,
}: {
  symbol: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const [tf, setTf] = useState<ChartTimeframe>("1m");
  const [indicators, setIndicators] = useState<ChartIndicator[]>(DEFAULT_CHART_INDICATORS);
  const [bars, setBars] = useState<Bar[]>([]);
  const [initialLoading, setInitialLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reality, setReality] = useState<any>(null);
  const [verdictPreview, setVerdictPreview] = useState<any>(null);
  const [candleUpdatedAt, setCandleUpdatedAt] = useState<number | null>(null);
  const tape = useLiveTapeMap();
  const liveRow = symbol ? tape.map.get(symbol) : undefined;

  const chartHostRef = useRef<HTMLDivElement | null>(null);
  const bundleRef = useRef<ChartBundle | null>(null);
  const chartConfigRef = useRef("");

  const loadVerdict = useCallback(async (sym: string, cancelled: () => boolean) => {
    try {
      const res = await fetch(`/api/scan/${encodeURIComponent(sym)}`, { cache: "no-store", headers: scanHeaders() });
      const d = await res.json();
      if (!cancelled()) setVerdictPreview(d?.verdictPreview ?? null);
    } catch {
      if (!cancelled()) setVerdictPreview(null);
    }
  }, []);

  useEffect(() => {
    if (!open || !symbol) {
      setVerdictPreview(null);
      return;
    }
    let cancelled = false;
    const defer = setTimeout(() => {
      if (cancelled) return;
      loadVerdict(symbol, () => cancelled);
    }, VERDICT_DEFER_MS);
    const id = setInterval(() => loadVerdict(symbol, () => cancelled), VERDICT_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(defer);
      clearInterval(id);
    };
  }, [open, symbol, loadVerdict]);

  useEffect(() => {
    const p = loadDashboardPrefs();
    if (p.chartTimeframe && (CHART_TIMEFRAMES as readonly string[]).includes(p.chartTimeframe)) setTf(p.chartTimeframe);
    if (Array.isArray(p.chartIndicators)) {
      const valid = p.chartIndicators.filter((i): i is ChartIndicator => (CHART_INDICATORS as readonly string[]).includes(i));
      if (valid.length) setIndicators(valid);
    }
  }, []);

  const toggleIndicator = useCallback((id: ChartIndicator) => {
    setIndicators((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      saveDashboardPrefs({ chartIndicators: next });
      return next;
    });
  }, []);

  const changeTf = useCallback((next: ChartTimeframe) => {
    setTf(next);
    saveDashboardPrefs({ chartTimeframe: next });
  }, []);

  const loadCandles = useCallback(
    async (cancelled: () => boolean, silent: boolean) => {
      if (!symbol) return;
      if (!silent) {
        setInitialLoading(true);
        setError(null);
      }
      try {
        const res = await fetch(`/api/candles/${encodeURIComponent(symbol)}?tf=${tf}`, {
          cache: "no-store",
          headers: scanHeaders(),
        });
        const d = await res.json();
        if (cancelled()) return;
        if (!d.ok) {
          if (!silent) {
            setError(d.error ?? "candles unavailable");
            setBars([]);
          }
        } else {
          setBars(d.bars ?? []);
          setError(null);
          setCandleUpdatedAt(Date.now());
        }
      } catch (e: any) {
        if (!cancelled() && !silent) {
          setError(e?.message ?? "failed to load candles");
          setBars([]);
        }
      } finally {
        if (!cancelled() && !silent) setInitialLoading(false);
      }
    },
    [symbol, tf],
  );

  useEffect(() => {
    if (!open || !symbol) {
      setBars([]);
      setInitialLoading(false);
      return;
    }
    let cancelled = false;
    loadCandles(() => cancelled, false);
    const id = setInterval(() => loadCandles(() => cancelled, true), CHART_LIVE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [open, symbol, tf, loadCandles]);

  const configKey = useMemo(() => `${tf}|${indicators.join(",")}`, [tf, indicators]);

  useEffect(() => {
    bundleRef.current?.chart.remove();
    bundleRef.current = null;
    chartConfigRef.current = "";
  }, [symbol, tf]);

  useEffect(() => {
    if (!open || !symbol) return;
    const host = chartHostRef.current;
    if (!host || !bars.length) return;

    if (configKey !== chartConfigRef.current || !bundleRef.current) {
      bundleRef.current?.chart.remove();
      bundleRef.current = mountChart(host, bars, indicators, tf);
      chartConfigRef.current = configKey;
    } else {
      refreshChartData(bundleRef.current, bars, indicators);
    }
  }, [open, symbol, bars, indicators, tf, configKey]);

  useEffect(() => {
    if (!open) {
      bundleRef.current?.chart.remove();
      bundleRef.current = null;
      chartConfigRef.current = "";
    }
  }, [open]);

  useEffect(() => {
    if (!open || !symbol) {
      setReality(null);
      return;
    }
    if (!bars.length) return;
    let cancelled = false;
    const lastBar = bars[bars.length - 1];
    const firstBar = bars[0];
    const dayChg =
      lastBar && firstBar && firstBar.c ? ((lastBar.c - firstBar.c) / firstBar.c) * 100 : null;
    const dir =
      dayChg == null ? undefined : dayChg > 0.08 ? "bullish" : dayChg < -0.08 ? "bearish" : undefined;
    const defer = setTimeout(() => {
      if (cancelled) return;
      (async () => {
        try {
          const dirQ = dir ? `&dir=${dir}` : "";
          const res = await fetch(`/api/options/${encodeURIComponent(symbol)}?zero=1${dirQ}`, {
            cache: "no-store",
            headers: scanHeaders(),
          });
          const d = await res.json();
          if (!cancelled) setReality(d.ok ? d : { error: d.error });
        } catch (e: any) {
          if (!cancelled) setReality({ error: e?.message ?? "failed" });
        }
      })();
    }, OPTIONS_DEFER_MS);
    return () => {
      cancelled = true;
      clearTimeout(defer);
    };
  }, [open, symbol, bars]);

  const last = bars.length ? bars[bars.length - 1] : null;
  const first = bars.length ? bars[0] : null;
  const livePrice = liveRow?.price ?? last?.c ?? null;
  const dayChangePct = liveRow?.movePct ?? (last && first && first.c ? ((last.c - first.c) / first.c) * 100 : null);
  const stockDirection =
    dayChangePct == null ? undefined : dayChangePct > 0.08 ? "bullish" : dayChangePct < -0.08 ? "bearish" : undefined;

  const bestCall = reality?.bestCalls?.[0] ?? null;
  const bestPut = reality?.bestPuts?.[0] ?? null;

  const indicatorChips = useMemo(
    () =>
      CHART_INDICATORS.map((id) => (
        <button
          key={id}
          type="button"
          className={`chip${indicators.includes(id) ? " on" : ""}`}
          onClick={() => toggleIndicator(id)}
        >
          {INDICATOR_LABELS[id]}
        </button>
      )),
    [indicators, toggleIndicator],
  );

  if (!open) return null;

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="chart-drawer" role="dialog" aria-label={`${symbol} chart`}>
        <header className="chart-drawer-head">
          <div>
            <div className="chart-sym">
              {symbol}
              {liveRow && tape.running ? (
                <span className={`chart-live-badge stream-fresh-${tape.freshness}`} title="Price from live scanner tape">
                  LIVE
                </span>
              ) : null}
            </div>
            <div className="chart-price num">
              {livePrice != null ? fmtPrice(livePrice) : "—"}
              {dayChangePct != null ? (
                <span className={`num chart-change-inline ${pctClass(dayChangePct)}`}>
                  {fmtPct(dayChangePct)}
                </span>
              ) : null}
            </div>
            {candleUpdatedAt ? (
              <div className="muted text-xs chart-candle-meta">
                Candles refresh every {CHART_LIVE_POLL_MS / 1000}s
                {tape.transport === "sse" ? " · tape SSE" : " · tape poll"}
              </div>
            ) : null}
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {verdictPreview?.alertInput ? (
          <div className="chart-verdict-strip">
            <VerdictPreviewBlock
              alertInput={verdictPreview.alertInput}
              entryPremium={verdictPreview.entryPremium}
              live={symbol ? liveCtxFor(tape, symbol) : undefined}
              compact
              onCopyTicket={() => {
                const c = verdictPreview.alertInput;
                if (!symbol || !c?.strike) return;
                const side = String(c.option_side ?? "call").toUpperCase().slice(0, 1);
                const line = `BUY 1 ${symbol} ${fmtNum(c.strike, 0)}${side} ${c.expiration ?? "0DTE"} @ ${fmtPremium(verdictPreview.entryPremium)} (mid)`;
                navigator.clipboard?.writeText(line);
              }}
            />
          </div>
        ) : null}

        <div className="chart-controls">
          <div className="tf-group">
            {CHART_TIMEFRAMES.map((t) => (
              <button key={t} type="button" className={`chip${tf === t ? " on" : ""}`} onClick={() => changeTf(t)}>
                {t}
              </button>
            ))}
          </div>
          <div className="ind-group">{indicatorChips}</div>
        </div>

        <div className="chart-host-wrap">
          {initialLoading ? <div className="chart-msg muted">Loading candles…</div> : null}
          {error ? <div className="chart-msg warn">⚠ {error}</div> : null}
          {!initialLoading && !error && !bars.length ? <div className="chart-msg muted">No candle data.</div> : null}
          <div ref={chartHostRef} className="chart-host" />
        </div>

        <div className="chart-reality">
          <div className="chart-reality-title">0DTE reality check</div>
          {reality?.error ? (
            <div className="warn text-sm">⚠ {reality.error}</div>
          ) : reality ? (
            <>
              <div className="muted chart-reality-meta">
                <div>
                  Stock today:{" "}
                  <strong className={pctClass(dayChangePct)}>
                    {dayChangePct != null ? fmtPct(dayChangePct) : "—"}
                  </strong>
                  {stockDirection ? ` (${stockDirection === "bullish" ? "up" : "down"})` : ""}
                </div>
                <div className="mt-1">
                  Options flow: <strong>{reality.pressure?.label ?? "—"}</strong>
                  {reality.pressure ? (
                    <>
                      {" · "}call vol {fmtInt(reality.pressure.callVolume)} vs put vol {fmtInt(reality.pressure.putVolume)}
                    </>
                  ) : null}
                  {reality.minsToClose != null ? ` · ${reality.minsToClose} min to close` : ""}
                </div>
              </div>
              <div className="contract-cards">
                {bestCall ? <ContractRow c={bestCall} /> : null}
                {bestPut ? <ContractRow c={bestPut} /> : null}
                {!bestCall && !bestPut ? <div className="muted text-sm">No qualifying 0DTE contracts.</div> : null}
              </div>
            </>
          ) : (
            <div className="muted text-sm">Loading contracts…</div>
          )}
        </div>
      </aside>
    </>
  );
}

function ContractRow({ c }: { c: any }) {
  return (
    <div className="contract-card">
      <div className="contract-card-title">
        {c.strike}
        {String(c.side).toUpperCase().slice(0, 1)} {c.expiration} · score {c.contractScore}/100
      </div>
      <div>
        Bid {fmtPrice(c.bid)} · Ask {fmtPrice(c.ask)} · Mid {fmtPrice(c.mid)} · Spread {c.spreadPct ?? "—"}% ({c.spreadRating})
      </div>
      <div>
        Vol {fmtInt(c.volume)} · OI {fmtInt(c.openInterest)} · Liquidity {c.liquidityRating} · Breakeven {fmtPrice(c.breakeven)}
      </div>
      <div>
        needs {c.estMoveNeededPct ?? "—"}% vs ~{c.expectedRemainingMovePct}% est. left · Premium {c.premiumRisk} · Theta {c.thetaRisk} · IV {c.ivRisk}
      </div>
    </div>
  );
}
