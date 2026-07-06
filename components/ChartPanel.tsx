"use client";

/**
 * ChartPanel — right-side drawer with a candlestick + volume chart (TradingView
 * lightweight-charts), toggleable indicators (VWAP/EMA/SMA/RSI/MACD), and the
 * existing 0DTE reality-check contract cards. Opens on a mover or alert click.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  type IChartApi,
} from "lightweight-charts";
import { scanHeaders } from "@/hooks/useScanner";
import { fmtPrice, fmtPct, fmtInt, changeColor } from "@/lib/format";
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
  type Bar,
} from "@/lib/chart-indicators";

const INDICATOR_LABELS: Record<ChartIndicator, string> = {
  vwap: "VWAP",
  ema9: "EMA 9",
  ema21: "EMA 21",
  sma50: "SMA 50",
  rsi: "RSI",
  macd: "MACD",
};

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
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
  const [tf, setTf] = useState<ChartTimeframe>("5m");
  const [indicators, setIndicators] = useState<ChartIndicator[]>(DEFAULT_CHART_INDICATORS);
  const [bars, setBars] = useState<Bar[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reality, setReality] = useState<any>(null);

  const chartHostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    const p = loadDashboardPrefs();
    if (p.chartTimeframe && (CHART_TIMEFRAMES as readonly string[]).includes(p.chartTimeframe)) setTf(p.chartTimeframe);
    if (Array.isArray(p.chartIndicators)) {
      const valid = p.chartIndicators.filter((i): i is ChartIndicator => (CHART_INDICATORS as readonly string[]).includes(i));
      setIndicators(valid);
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

  // Fetch candles + reality check whenever the symbol/timeframe changes.
  useEffect(() => {
    if (!open || !symbol) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(`/api/candles/${encodeURIComponent(symbol)}?tf=${tf}`, {
          cache: "no-store",
          headers: scanHeaders(),
        });
        const d = await res.json();
        if (cancelled) return;
        if (!d.ok) {
          setError(d.error ?? "candles unavailable");
          setBars([]);
        } else {
          setBars(d.bars ?? []);
        }
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message ?? "failed to load candles");
          setBars([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, symbol, tf]);

  useEffect(() => {
    if (!open || !symbol) {
      setReality(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/options/${encodeURIComponent(symbol)}?zero=1`, {
          cache: "no-store",
          headers: scanHeaders(),
        });
        const d = await res.json();
        if (!cancelled) setReality(d.ok ? d : { error: d.error });
      } catch (e: any) {
        if (!cancelled) setReality({ error: e?.message ?? "failed" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, symbol]);

  // (Re)build the chart when data, indicators, or panel visibility change.
  useEffect(() => {
    if (!open || !chartHostRef.current || !bars.length) return;

    const host = chartHostRef.current;
    const txt = cssVar("--txt", "#e8edf2");
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
    chartRef.current = chart;

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

    const closes = bars.map((b) => b.c);

    if (indicators.includes("vwap")) {
      const s = chart.addSeries(LineSeries, { color: amber, lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
      s.setData(toLine(bars, vwapSeries(bars)) as any);
    }
    if (indicators.includes("ema9")) {
      const s = chart.addSeries(LineSeries, { color: cyan, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      s.setData(toLine(bars, emaSeries(closes, 9)) as any);
    }
    if (indicators.includes("ema21")) {
      const s = chart.addSeries(LineSeries, { color: violet, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      s.setData(toLine(bars, emaSeries(closes, 21)) as any);
    }
    if (indicators.includes("sma50")) {
      const s = chart.addSeries(LineSeries, { color: muted, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      s.setData(toLine(bars, smaSeries(closes, 50)) as any);
    }

    // Volume pane.
    const volPane = 1;
    const vol = chart.addSeries(
      HistogramSeries,
      { priceFormat: { type: "volume" }, priceScaleId: "" },
      volPane,
    );
    vol.setData(
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

    // Size panes: price gets the lion's share, sub-panes stay compact.
    try {
      const panes = chart.panes();
      if (panes[0]) panes[0].setHeight(260);
      for (let i = 1; i < panes.length; i++) panes[i].setHeight(90);
    } catch {
      /* pane sizing is best-effort */
    }

    chart.timeScale().fitContent();
    void txt;

    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [open, bars, indicators, tf]);

  const last = bars.length ? bars[bars.length - 1] : null;
  const first = bars.length ? bars[0] : null;
  const dayChangePct = last && first && first.c ? ((last.c - first.c) / first.c) * 100 : null;

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
            <div className="chart-sym">{symbol}</div>
            <div className="chart-price num">
              {last ? fmtPrice(last.c) : "—"}
              {dayChangePct != null ? (
                <span className="num" style={{ color: changeColor(dayChangePct), marginLeft: 8, fontSize: 13 }}>
                  {fmtPct(dayChangePct)}
                </span>
              ) : null}
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

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
          {loading ? <div className="chart-msg muted">Loading candles…</div> : null}
          {error ? <div className="chart-msg warn">⚠ {error}</div> : null}
          {!loading && !error && !bars.length ? <div className="chart-msg muted">No candle data.</div> : null}
          <div ref={chartHostRef} className="chart-host" />
        </div>

        <div className="chart-reality">
          <div className="chart-reality-title">0DTE reality check</div>
          {reality?.error ? (
            <div className="warn" style={{ fontSize: 12 }}>⚠ {reality.error}</div>
          ) : reality ? (
            <>
              <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
                Pressure: <strong>{reality.pressure?.label ?? "—"}</strong>
                {reality.pressure ? (
                  <>
                    {" · "}call vol {fmtInt(reality.pressure.callVolume)} vs put vol {fmtInt(reality.pressure.putVolume)}
                  </>
                ) : null}
                {reality.minsToClose != null ? ` · ${reality.minsToClose} min to close` : ""}
              </div>
              <div className="contract-cards">
                {bestCall ? <ContractRow c={bestCall} /> : null}
                {bestPut ? <ContractRow c={bestPut} /> : null}
                {!bestCall && !bestPut ? <div className="muted" style={{ fontSize: 12 }}>No qualifying 0DTE contracts.</div> : null}
              </div>
            </>
          ) : (
            <div className="muted" style={{ fontSize: 12 }}>Loading contracts…</div>
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
