"use client";

/**
 * ChartPanel — right-side drawer with stacked synced 1m/5m/15m charts (desktop)
 * or a single chart on mobile (≤768px). Toggleable indicators per timeframe.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type LogicalRange,
} from "lightweight-charts";
import { scanHeaders } from "@/hooks/useScanner";
import { fmtPrice, fmtPct, fmtInt, pctClass } from "@/lib/format";
import {
  CHART_TIMEFRAMES,
  CHART_INDICATORS,
  CHART_STACK_TIMEFRAMES,
  DEFAULT_CHART_INDICATORS,
  DEFAULT_STACK_INDICATORS,
  loadDashboardPrefs,
  saveDashboardPrefs,
  type ChartTimeframe,
  type ChartIndicator,
  type ChartStackTimeframe,
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

const MOBILE_MAX = 768;

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function useMobileChart(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_MAX}px)`);
    const update = () => setMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return mobile;
}

function applyKeyLevelLines(candle: ReturnType<IChartApi["addSeries"]>, levels: KeyLevel[]) {
  const amber = cssVar("--amber", "#ffb020");
  const cyan = cssVar("--cyan", "#3ad0ff");
  const muted = cssVar("--muted", "#8798a8");
  const colorFor = (id: string) => (id === "vwap" ? amber : id === "hod" || id === "lod" ? cyan : muted);
  for (const lvl of levels) {
    candle.createPriceLine({
      price: lvl.price,
      color: colorFor(lvl.id),
      lineWidth: 1,
      lineStyle: lvl.lineStyle === "dashed" ? 2 : 0,
      axisLabelVisible: true,
      title: lvl.label,
    });
  }
}

function applyIndicators(chart: IChartApi, bars: Bar[], indicators: ChartIndicator[], tf: ChartTimeframe) {
  const muted = cssVar("--muted", "#8798a8");
  const green = cssVar("--green", "#00d68f");
  const red = cssVar("--red", "#ff5a72");
  const violet = cssVar("--violet", "#8b7dff");
  const cyan = cssVar("--cyan", "#3ad0ff");
  const amber = cssVar("--amber", "#ffb020");

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
  applyKeyLevelLines(candle, keyLevels(bars));

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

  const vol = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "" }, 1);
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

  try {
    const panes = chart.panes();
    if (panes[0]) panes[0].setHeight(tf === "1D" ? 260 : 180);
    for (let i = 1; i < panes.length; i++) panes[i].setHeight(70);
  } catch { /* best effort */ }

  chart.timeScale().fitContent();
}

function StackedCharts({
  barsByTf,
  indicatorsByTf,
  onToggleIndicator,
}: {
  barsByTf: Partial<Record<ChartStackTimeframe, Bar[]>>;
  indicatorsByTf: Record<ChartStackTimeframe, ChartIndicator[]>;
  onToggleIndicator: (tf: ChartStackTimeframe, id: ChartIndicator) => void;
}) {
  const hostsRef = useRef<Partial<Record<ChartStackTimeframe, HTMLDivElement | null>>>({});
  const chartsRef = useRef<Partial<Record<ChartStackTimeframe, IChartApi>>>({});
  const syncing = useRef(false);

  useEffect(() => {
    const muted = cssVar("--muted", "#8798a8");
    const line = cssVar("--line", "#1f2a37");
    const charts: Partial<Record<ChartStackTimeframe, IChartApi>> = {};

    for (const tf of CHART_STACK_TIMEFRAMES) {
      const host = hostsRef.current[tf];
      const bars = barsByTf[tf];
      if (!host || !bars?.length) continue;
      const chart = createChart(host, {
        layout: { background: { color: "transparent" }, textColor: muted, attributionLogo: false },
        grid: { vertLines: { color: line }, horzLines: { color: line } },
        rightPriceScale: { borderColor: line },
        timeScale: { borderColor: line, timeVisible: true, secondsVisible: false },
        crosshair: { mode: 0 },
        autoSize: true,
      });
      applyIndicators(chart, bars, indicatorsByTf[tf] ?? DEFAULT_STACK_INDICATORS[tf], tf);
      charts[tf] = chart;
    }
    chartsRef.current = charts;

    const syncRange = (source: ChartStackTimeframe, range: LogicalRange | null) => {
      if (syncing.current || !range) return;
      syncing.current = true;
      for (const stackTf of CHART_STACK_TIMEFRAMES) {
        if (stackTf === source) continue;
        chartsRef.current[stackTf]?.timeScale().setVisibleLogicalRange(range);
      }
      syncing.current = false;
    };

    for (const stackTf of CHART_STACK_TIMEFRAMES) {
      const chart = charts[stackTf];
      if (!chart) continue;
      chart.timeScale().subscribeVisibleLogicalRangeChange((range) => syncRange(stackTf, range));
    }

    return () => {
      for (const c of Object.values(chartsRef.current)) c?.remove();
      chartsRef.current = {};
    };
  }, [barsByTf, indicatorsByTf]);

  return (
    <div className="chart-stack">
      {CHART_STACK_TIMEFRAMES.map((stackTf) => {
        const bars = barsByTf[stackTf] ?? [];
        const inds = indicatorsByTf[stackTf] ?? DEFAULT_STACK_INDICATORS[stackTf];
        return (
          <div key={stackTf} className="chart-stack-pane">
            <div className="chart-stack-head">
              <span className="chart-stack-label">{stackTf}</span>
              <div className="ind-group">
                {CHART_INDICATORS.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className={`chip${inds.includes(id) ? " on" : ""}`}
                    onClick={() => onToggleIndicator(stackTf, id)}
                  >
                    {INDICATOR_LABELS[id]}
                  </button>
                ))}
              </div>
            </div>
            {!bars.length ? <div className="chart-msg muted">No {stackTf} data.</div> : null}
            <div ref={(el) => { hostsRef.current[stackTf] = el; }} className="chart-host chart-host-stack" />
          </div>
        );
      })}
    </div>
  );
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
  const mobile = useMobileChart();
  const [tf, setTf] = useState<ChartTimeframe>("5m");
  const [indicators, setIndicators] = useState<ChartIndicator[]>(DEFAULT_CHART_INDICATORS);
  const [indicatorsByTf, setIndicatorsByTf] = useState<Record<ChartStackTimeframe, ChartIndicator[]>>(DEFAULT_STACK_INDICATORS);
  const [barsByTf, setBarsByTf] = useState<Partial<Record<ChartTimeframe, Bar[]>>>({});
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
      if (valid.length) setIndicators(valid);
    }
    if (p.chartIndicatorsByTf) {
      setIndicatorsByTf((cur) => {
        const next = { ...cur };
        for (const stackTf of CHART_STACK_TIMEFRAMES) {
          const saved = p.chartIndicatorsByTf?.[stackTf];
          if (Array.isArray(saved)) {
            next[stackTf] = saved.filter((i): i is ChartIndicator => (CHART_INDICATORS as readonly string[]).includes(i));
          }
        }
        return next;
      });
    }
  }, []);

  const toggleIndicator = useCallback((id: ChartIndicator) => {
    setIndicators((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      saveDashboardPrefs({ chartIndicators: next });
      return next;
    });
  }, []);

  const toggleStackIndicator = useCallback((stackTf: ChartStackTimeframe, id: ChartIndicator) => {
    setIndicatorsByTf((cur) => {
      const list = cur[stackTf] ?? DEFAULT_STACK_INDICATORS[stackTf];
      const nextList = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
      const next = { ...cur, [stackTf]: nextList };
      saveDashboardPrefs({ chartIndicatorsByTf: next });
      return next;
    });
  }, []);

  const changeTf = useCallback((next: ChartTimeframe) => {
    setTf(next);
    saveDashboardPrefs({ chartTimeframe: next });
  }, []);

  const fetchTfs = mobile ? [tf] : [...CHART_STACK_TIMEFRAMES];

  useEffect(() => {
    if (!open || !symbol) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const results = await Promise.all(
          fetchTfs.map(async (t) => {
            const res = await fetch(`/api/candles/${encodeURIComponent(symbol)}?tf=${t}`, {
              cache: "no-store",
              headers: scanHeaders(),
            });
            const d = await res.json();
            return { tf: t, ok: d.ok, bars: d.bars ?? [], error: d.error };
          }),
        );
        if (cancelled) return;
        const failed = results.find((r) => !r.ok);
        if (failed && mobile) {
          setError(failed.error ?? "candles unavailable");
          setBarsByTf({});
        } else {
          const map: Partial<Record<ChartTimeframe, Bar[]>> = {};
          for (const r of results) map[r.tf as ChartTimeframe] = r.bars;
          setBarsByTf(map);
          if (failed) setError(failed.error ?? null);
        }
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message ?? "failed to load candles");
          setBarsByTf({});
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, symbol, mobile, tf]);

  const bars = mobile ? (barsByTf[tf] ?? []) : (barsByTf["5m"] ?? barsByTf["1m"] ?? []);

  useEffect(() => {
    if (!open || !symbol) {
      setReality(null);
      return;
    }
    let cancelled = false;
    const lastBar = bars.length ? bars[bars.length - 1] : null;
    const firstBar = bars.length ? bars[0] : null;
    const dayChg =
      lastBar && firstBar && firstBar.c ? ((lastBar.c - firstBar.c) / firstBar.c) * 100 : null;
    const dir =
      dayChg == null ? undefined : dayChg > 0.08 ? "bullish" : dayChg < -0.08 ? "bearish" : undefined;
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
    return () => { cancelled = true; };
  }, [open, symbol, bars]);

  useEffect(() => {
    if (mobile && open && chartHostRef.current && bars.length) {
      const host = chartHostRef.current;
      const muted = cssVar("--muted", "#8798a8");
      const line = cssVar("--line", "#1f2a37");
      const chart = createChart(host, {
        layout: { background: { color: "transparent" }, textColor: muted, attributionLogo: false },
        grid: { vertLines: { color: line }, horzLines: { color: line } },
        rightPriceScale: { borderColor: line },
        timeScale: { borderColor: line, timeVisible: tf !== "1D", secondsVisible: false },
        crosshair: { mode: 0 },
        autoSize: true,
      });
      chartRef.current = chart;
      applyIndicators(chart, bars, indicators, tf);
      return () => {
        chart.remove();
        chartRef.current = null;
      };
    }
    return undefined;
  }, [mobile, open, bars, indicators, tf]);

  const last = bars.length ? bars[bars.length - 1] : null;
  const first = bars.length ? bars[0] : null;
  const dayChangePct = last && first && first.c ? ((last.c - first.c) / first.c) * 100 : null;
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
            <div className="chart-sym">{symbol}</div>
            <div className="chart-price num">
              {last ? fmtPrice(last.c) : "—"}
              {dayChangePct != null ? (
                <span className={`num chart-change-inline ${pctClass(dayChangePct)}`}>
                  {fmtPct(dayChangePct)}
                </span>
              ) : null}
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {mobile ? (
          <>
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
          </>
        ) : (
          <div className="chart-host-wrap chart-host-wrap-stack">
            {loading ? <div className="chart-msg muted">Loading stacked charts…</div> : null}
            {error ? <div className="chart-msg warn">⚠ {error}</div> : null}
            <StackedCharts
              barsByTf={barsByTf as Partial<Record<ChartStackTimeframe, Bar[]>>}
              indicatorsByTf={indicatorsByTf}
              onToggleIndicator={toggleStackIndicator}
            />
          </div>
        )}

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
