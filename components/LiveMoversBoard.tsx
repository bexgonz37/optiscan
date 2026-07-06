"use client";

/**
 * Live movers — organized call/put panels. Re-checks live speed so BUY CALL
 * downgrades if the stock stopped moving.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { scanHeaders } from "@/hooks/useScanner";
import { TickerIcon } from "@/components/ui";
import { TradeVerdictHero } from "@/components/TradeVerdictHero";
import { computeTradeVerdict, MIN_SPEED_PCT_PER_MIN } from "@/lib/trade-verdict";
import { changeColor, fmtPct, fmtPrice } from "@/lib/format";

interface Mover {
  symbol: string;
  price: number | null;
  movePct: number | null;
  shortRate: number | null;
  accel: number | null;
  surge: number | null;
  direction: string;
  hodBreak: boolean;
  lodBreak: boolean;
  aboveVwap: boolean | null;
}

type ViewFilter = "tradable" | "calls" | "puts" | "all";

function liveCtx(m: Mover) {
  return { shortRate: m.shortRate, surge: m.surge };
}

function MoverCard({
  m,
  alert,
  onOpenChart,
}: {
  m: Mover;
  alert: any | null;
  onOpenChart?: (symbol: string) => void;
}) {
  const live = liveCtx(m);
  const v = alert
    ? computeTradeVerdict(alert, live)
    : null;
  const speed = m.shortRate != null ? `${m.shortRate > 0 ? "+" : ""}${m.shortRate.toFixed(2)}%/m` : "—";

  return (
    <button type="button" className="mover-card" onClick={() => onOpenChart?.(m.symbol)}>
      <div className="mover-card-top">
        <TickerIcon symbol={m.symbol} />
        <span className="tname">{m.symbol}</span>
        <span className="num" style={{ color: changeColor(m.movePct) }}>{fmtPct(m.movePct)}</span>
      </div>
      <div className="mover-card-mid">
        <span className="num">{fmtPrice(m.price)}</span>
        <span className="muted">Speed {speed}</span>
        {m.surge != null ? <span className="muted">Vol {m.surge}x</span> : null}
      </div>
      <div className="mover-card-action">
        {alert ? (
          <TradeVerdictHero alert={alert} live={live} compact />
        ) : Math.abs(m.shortRate ?? 0) >= MIN_SPEED_PCT_PER_MIN ? (
          <span className={`verdict-pill verdict-wait`}>
            {m.direction === "bullish" ? "MOVING — CALL SIDE" : m.direction === "bearish" ? "MOVING — PUT SIDE" : "MOVING"}
          </span>
        ) : (
          <span className="verdict-pill verdict-skip">TOO SLOW</span>
        )}
      </div>
      {v?.action === "TRADE" ? null : v?.reason ? (
        <div className="mover-card-why muted">{v.reason}</div>
      ) : null}
    </button>
  );
}

export function LiveMoversBoard({
  loopStatus,
  onOpenChart,
}: {
  loopStatus?: (running: boolean, note?: string) => void;
  onOpenChart?: (symbol: string) => void;
}) {
  const [movers, setMovers] = useState<Mover[]>([]);
  const [loop, setLoop] = useState<any>(null);
  const [alerts, setAlerts] = useState<Map<string, any>>(new Map());
  const [filter, setFilter] = useState<ViewFilter>("tradable");

  const pollLoop = useCallback(async () => {
    try {
      const res = await fetch("/api/scanner/live?realtimeOnly=1", { cache: "no-store", headers: scanHeaders() });
      const d = await res.json();
      if (d?.ok) {
        setMovers(d.realtime?.movers ?? []);
        setLoop(d.realtime);
        loopStatus?.(Boolean(d.realtime?.running), d.realtime?.note);
      }
    } catch { /* best effort */ }
  }, [loopStatus]);

  const pollAlerts = useCallback(async () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const res = await fetch(`/api/alerts?date=${today}&limit=100`, { cache: "no-store", headers: scanHeaders() });
      const d = await res.json();
      const map = new Map<string, any>();
      for (const a of d.alerts ?? []) if (!map.has(a.ticker)) map.set(a.ticker, a);
      setAlerts(map);
    } catch { /* best effort */ }
  }, []);

  useEffect(() => {
    pollLoop();
    pollAlerts();
    const a = setInterval(pollLoop, 3000);
    const b = setInterval(pollAlerts, 20000);
    return () => { clearInterval(a); clearInterval(b); };
  }, [pollLoop, pollAlerts]);

  const rows = useMemo(() => {
    return movers.map((m) => {
      const a = alerts.get(m.symbol) ?? null;
      const v = a ? computeTradeVerdict(a, liveCtx(m)) : null;
      const fast = Math.abs(m.shortRate ?? 0) >= MIN_SPEED_PCT_PER_MIN;
      const isCall = m.direction === "bullish" || v?.side === "CALL";
      const isPut = m.direction === "bearish" || v?.side === "PUT";
      const tradable = v?.action === "TRADE" || (fast && (isCall || isPut));
      return { m, a, v, fast, isCall, isPut, tradable };
    });
  }, [movers, alerts]);

  const calls = useMemo(() =>
    rows.filter((r) => r.isCall && (filter === "all" || filter === "calls" || (filter === "tradable" && r.tradable)))
      .sort((a, b) => Math.abs(b.m.shortRate ?? 0) - Math.abs(a.m.shortRate ?? 0))
      .slice(0, 8),
  [rows, filter]);

  const puts = useMemo(() =>
    rows.filter((r) => r.isPut && (filter === "all" || filter === "puts" || (filter === "tradable" && r.tradable)))
      .sort((a, b) => Math.abs(b.m.shortRate ?? 0) - Math.abs(a.m.shortRate ?? 0))
      .slice(0, 8),
  [rows, filter]);

  const chip = (id: ViewFilter, label: string) => (
    <button
      type="button"
      className={`pill btn${filter === id ? " btn-primary" : ""}`}
      style={{ fontSize: 12, padding: "5px 12px" }}
      onClick={() => setFilter(id)}
    >
      {label}
    </button>
  );

  return (
    <section className="panel main section-live">
      <div className="section-header">
        <div>
          <h2 className="section-title">Top momentum movers</h2>
          <p className="section-sub">Calls left · Puts right · updates every 3s · click for chart</p>
        </div>
        <div className="status-group">
          <span className={`status-dot ${loop?.running ? "live" : ""}`} />
          <span className="status-text">{loop?.running ? "Loop live" : "Loop offline"}</span>
        </div>
      </div>

      <div className="mover-filters">
        {chip("tradable", "Worth watching")}
        {chip("calls", "Calls only")}
        {chip("puts", "Puts only")}
        {chip("all", "All movers")}
      </div>

      {!rows.length ? (
        <div className="empty">
          <div className="big">{loop?.running ? "Watching the tape…" : "Scanner is off"}</div>
          {loop?.running ? "Names appear when speed ≥ 0.15%/min." : "Start during market hours."}
        </div>
      ) : (
        <div className="mover-panels">
          <div className="mover-panel mover-panel-calls">
            <h3 className="mover-panel-title">▲ Buy calls</h3>
            {!calls.length ? <div className="empty small">No call setups right now.</div> : (
              <div className="mover-card-grid">
                {calls.map(({ m, a }) => (
                  <MoverCard key={m.symbol} m={m} alert={a} onOpenChart={onOpenChart} />
                ))}
              </div>
            )}
          </div>
          <div className="mover-panel mover-panel-puts">
            <h3 className="mover-panel-title">▼ Buy puts</h3>
            {!puts.length ? <div className="empty small">No put setups right now.</div> : (
              <div className="mover-card-grid">
                {puts.map(({ m, a }) => (
                  <MoverCard key={m.symbol} m={m} alert={a} onOpenChart={onOpenChart} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
