"use client";

/**
 * Live 0DTE movers board — feeds off the every-second scanner loop (in-memory).
 * Click a row to open the chart panel (candles, indicators, reality check).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { scanHeaders } from "@/hooks/useScanner";
import { TickerIcon, ScoreBar } from "@/components/ui";
import { changeColor, fmtPct, fmtPrice } from "@/lib/format";

interface Mover {
  symbol: string;
  price: number | null;
  movePct: number | null;
  shortRate: number | null;
  accel: number | null;
  surge: number | null;
  efficiency: number | null;
  direction: string;
  confidence: number;
  hodBreak: boolean;
  lodBreak: boolean;
  aboveVwap: boolean | null;
}

const MOVE_STATUS_TEXT: Record<string, string> = {
  early: "Early",
  continuing: "Continuation",
  extended_tradable: "Extended OK",
  extended_risky: "Chase Risk",
  exhausted: "Exhausted",
};

function dirChip(d: string) {
  if (d === "bullish") return <span className="dir-bull">▲ BULL</span>;
  if (d === "bearish") return <span className="dir-bear">▼ BEAR</span>;
  return <span className="dir-chop">◆ CHOP</span>;
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

  const pollLoop = useCallback(async () => {
    try {
      const res = await fetch("/api/scanner/live?realtimeOnly=1", { cache: "no-store", headers: scanHeaders() });
      const d = await res.json();
      if (d?.ok) {
        setMovers(d.realtime?.movers ?? []);
        setLoop(d.realtime);
        loopStatus?.(Boolean(d.realtime?.running), d.realtime?.note);
      }
    } catch {
      /* best effort */
    }
  }, [loopStatus]);

  const pollAlerts = useCallback(async () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const res = await fetch(`/api/alerts?date=${today}&limit=100`, { cache: "no-store", headers: scanHeaders() });
      const d = await res.json();
      const map = new Map<string, any>();
      for (const a of d.alerts ?? []) if (!map.has(a.ticker)) map.set(a.ticker, a);
      setAlerts(map);
    } catch {
      /* best effort */
    }
  }, []);

  useEffect(() => {
    pollLoop();
    pollAlerts();
    const a = setInterval(pollLoop, 1500);
    const b = setInterval(pollAlerts, 15000);
    return () => {
      clearInterval(a);
      clearInterval(b);
    };
  }, [pollLoop, pollAlerts]);

  const rows = useMemo(() => movers.map((m) => ({ m, a: alerts.get(m.symbol) ?? null })), [movers, alerts]);

  return (
    <section className="panel main section-live">
      <div className="section-header">
        <div>
          <h2 className="section-title">Live movers</h2>
          <p className="section-sub">Real-time tape · click any row for the chart</p>
        </div>
        <div className="status-group">
          <span className={`status-dot ${loop?.running ? "live" : ""}`} />
          <span className="status-text">{loop?.running ? "Loop live" : "Loop offline"}</span>
          {loop?.note ? <span className="status-warn">{String(loop.note).slice(0, 50)}</span> : null}
        </div>
      </div>

      {!rows.length ? (
        <div className="empty">
          <div className="big">{loop?.running ? "Watching the tape…" : "Scanner is off"}</div>
          {loop?.note ? String(loop.note) : loop?.running ? "Names show up here as they start moving." : "Start the app during market hours to see live movers."}
        </div>
      ) : (
        <div className="tablewrap live-table">
          <table>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Price</th>
                <th>Move</th>
                <th>Dir</th>
                <th>Speed</th>
                <th>Vol</th>
                <th>VWAP</th>
                <th>Level</th>
                <th>Call</th>
                <th>Put</th>
                <th>0DTE</th>
                <th>Status</th>
                <th>Label</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ m, a }) => (
                <tr
                  key={m.symbol}
                  data-sym={m.symbol}
                  className="clickable"
                  onClick={() => onOpenChart?.(m.symbol)}
                  title="Open chart"
                >
                  <td>
                    <div className="tkr">
                      <TickerIcon symbol={m.symbol} />
                      <div>
                        <div className="tname">{m.symbol}</div>
                        <div className="tsub">
                          {m.accel != null && m.accel > 0 ? "accelerating" : m.accel != null && m.accel < 0 ? "decelerating" : "steady"}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="num live-num">{fmtPrice(m.price)}</td>
                  <td className="num live-num" style={{ color: changeColor(m.movePct) }}>{fmtPct(m.movePct)}</td>
                  <td>{dirChip(m.direction)}</td>
                  <td className="num">{m.shortRate != null ? `${m.shortRate > 0 ? "+" : ""}${m.shortRate.toFixed(2)}%/m` : "—"}</td>
                  <td className="num">{m.surge != null ? `${m.surge}x` : "—"}</td>
                  <td className={m.aboveVwap == null ? "dim" : m.aboveVwap ? "pos" : "neg"} style={{ fontSize: 12 }}>
                    {m.aboveVwap == null ? "—" : m.aboveVwap ? "Above" : "Below"}
                  </td>
                  <td>{m.hodBreak ? <span className="tag t-call">HOD</span> : m.lodBreak ? <span className="tag t-put">LOD</span> : "—"}</td>
                  <td className="num" style={{ color: (a?.long_call_score ?? 0) >= 70 ? "var(--green)" : undefined }}>
                    {a?.long_call_score != null ? Math.round(a.long_call_score) : "—"}
                  </td>
                  <td className="num" style={{ color: (a?.long_put_score ?? 0) >= 70 ? "var(--red)" : undefined }}>
                    {a?.long_put_score != null ? Math.round(a.long_put_score) : "—"}
                  </td>
                  <td>{a?.zero_dte_contract_score != null ? <ScoreBar score={a.zero_dte_contract_score} /> : "—"}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{a?.move_status ? MOVE_STATUS_TEXT[a.move_status] ?? a.move_status : "—"}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{a?.private_label ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
