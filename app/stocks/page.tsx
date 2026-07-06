"use client";

/**
 * /stocks — regular-stock momentum mode (premarket + after-hours).
 *
 * Shows the same 1s underlying tape the 0DTE loop maintains, but framed for
 * shares: direction (LONG/SHORT), live speed, volume surge, HOD/LOD/VWAP —
 * no option chains, no strikes, no DTE. Stock callouts fire ONLY in
 * premarket (4:00-9:30 ET) and after hours (16:00-20:00 ET); during regular
 * hours this page points you at the Options scanner.
 */

import { useEffect, useMemo, useState } from "react";
import { AppNav } from "@/components/AppNav";
import { fmtPct, fmtPrice, fmtInt } from "@/lib/format";

const dirColor: Record<string, string> = {
  bullish: "var(--green)",
  bearish: "var(--red)",
  choppy: "var(--amber)",
};

interface TapeRow {
  symbol: string; price: number | null; movePct: number | null; volume: number | null;
  shortRate: number | null; surge: number | null; efficiency: number | null;
  direction: string; confidence: number;
  hodBreak: boolean; lodBreak: boolean; aboveVwap: boolean | null; relVol: number | null;
  promoted?: boolean;
}

interface StockAlert {
  id: number; ticker: string; direction: string | null; session: string | null;
  alert_time: string; price_at_alert: number | null; percent_move_at_alert: number | null;
  signal_score: number | null; capture_action: string | null; capture_confidence: number | null;
  private_label: string | null; short_rate_at_alert: number | null; volume_surge_at_alert: number | null;
  latest_max_move: number | null; is_false_positive: number | null;
}

const fmtSpeed = (v: number | null | undefined) =>
  v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%/min`;

export default function StocksPage() {
  const [session, setSession] = useState<string | null>(null);
  const [tape, setTape] = useState<TapeRow[]>([]);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<StockAlert[]>([]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/scanner/live?realtimeOnly=1", { cache: "no-store" });
        const d = await res.json();
        if (cancelled || !d?.realtime) return;
        setSession(d.realtime.session ?? null);
        setRunning(Boolean(d.realtime.running));
        setNote(d.realtime.note ?? null);
        setTape(Array.isArray(d.realtime.tape) ? d.realtime.tape : []);
      } catch { /* keep last */ }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/alerts?asset=stock&limit=50", { cache: "no-store" });
        const d = await res.json();
        if (!cancelled && Array.isArray(d?.alerts)) setAlerts(d.alerts);
      } catch { /* keep last */ }
    };
    poll();
    const id = setInterval(poll, 15000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const isStockHours = session === "premarket" || session === "afterhours";
  const ranked = useMemo(
    () => [...tape].sort((a, b) => Math.abs(b.shortRate ?? 0) - Math.abs(a.shortRate ?? 0)).slice(0, 30),
    [tape],
  );

  return (
    <div className="app">
      <AppNav
        status={[
          { label: running ? "loop live" : "loop off", live: running },
          { label: session ? `session: ${session}` : "session: —", warn: !isStockHours },
        ]}
      />
      <main style={{ padding: "16px 20px" }}>
        <div className="panel main" style={{ padding: 14, marginBottom: 14 }}>
          <h1 style={{ margin: "0 0 6px", fontSize: 16 }}>Stock Scanner — premarket &amp; after-hours momentum</h1>
          <p style={{ margin: 0, fontSize: 13, color: "var(--muted)" }}>
            {isStockHours
              ? `Stock callouts are LIVE (${session}). BUY LONG / BUY SHORT fires on direction-aligned speed with real volume — shares only, no option contracts.`
              : session === "regular"
                ? "Regular hours: the 0DTE options system is live — stock callouts resume after 4:00 PM ET. See the Options scanner."
                : "Market closed. Stock callouts run 4:00-9:30 AM and 4:00-8:00 PM ET; open alerts keep tracking."}
            {note ? ` · ${note}` : ""}
          </p>
        </div>

        <div className="panel main" style={{ padding: 14, marginBottom: 14 }}>
          <h2 style={{ margin: "0 0 8px", fontSize: 14 }}>Live tape — fastest movers</h2>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Symbol</th>
                  <th>Price</th>
                  <th>Day %</th>
                  <th>Speed</th>
                  <th>Vol surge</th>
                  <th>Direction</th>
                  <th>Levels</th>
                  <th>VWAP</th>
                  <th>Volume</th>
                </tr>
              </thead>
              <tbody>
                {ranked.length === 0 ? (
                  <tr><td colSpan={9} className="table-empty">No tape yet — the loop warms up in ~10 seconds once a session is open.</td></tr>
                ) : ranked.map((r) => (
                  <tr key={r.symbol}>
                    <td style={{ textAlign: "left", fontWeight: 600 }}>{r.symbol}{r.promoted ? " ·d" : ""}</td>
                    <td>{fmtPrice(r.price)}</td>
                    <td style={{ color: (r.movePct ?? 0) >= 0 ? "var(--green)" : "var(--red)" }}>{fmtPct(r.movePct)}</td>
                    <td>{fmtSpeed(r.shortRate)}</td>
                    <td>{r.surge != null ? `${r.surge.toFixed(1)}x` : "—"}</td>
                    <td style={{ color: dirColor[r.direction] ?? "var(--muted)" }}>
                      {r.direction === "bullish" ? "LONG" : r.direction === "bearish" ? "SHORT" : "—"}
                    </td>
                    <td>{r.hodBreak ? "HOD break" : r.lodBreak ? "LOD break" : "—"}</td>
                    <td>{r.aboveVwap == null ? "—" : r.aboveVwap ? "above" : "below"}</td>
                    <td>{r.volume != null ? fmtInt(r.volume) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel main" style={{ padding: 14 }}>
          <h2 style={{ margin: "0 0 8px", fontSize: 14 }}>Stock callouts (latest 50)</h2>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Ticker</th>
                  <th>Callout</th>
                  <th>Session</th>
                  <th>Time</th>
                  <th>Price</th>
                  <th>Move @ alert</th>
                  <th>Speed @ alert</th>
                  <th>Score</th>
                  <th>Conf</th>
                  <th>Best since</th>
                </tr>
              </thead>
              <tbody>
                {alerts.length === 0 ? (
                  <tr><td colSpan={10} className="table-empty">No stock callouts yet — they fire premarket and after hours only.</td></tr>
                ) : alerts.map((a) => (
                  <tr key={a.id}>
                    <td style={{ textAlign: "left", fontWeight: 600 }}>
                      <a href={`/alert-lab?ticker=${a.ticker}`} style={{ color: "inherit" }}>{a.ticker}</a>
                    </td>
                    <td style={{ color: a.direction === "bearish" ? "var(--red)" : "var(--green)", fontWeight: 600 }}>
                      {a.private_label ?? (a.direction === "bearish" ? "SHORT setup" : "LONG setup")}
                    </td>
                    <td>{a.session ?? "—"}</td>
                    <td>{new Date(a.alert_time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
                    <td>{fmtPrice(a.price_at_alert)}</td>
                    <td>{fmtPct(a.percent_move_at_alert)}</td>
                    <td>{fmtSpeed(a.short_rate_at_alert)}</td>
                    <td>{a.signal_score != null ? Math.round(a.signal_score) : "—"}</td>
                    <td>{a.capture_confidence != null ? `${a.capture_confidence}%` : "—"}</td>
                    <td style={{ color: (a.latest_max_move ?? 0) >= 0 ? "var(--green)" : "var(--red)" }}>
                      {a.latest_max_move != null ? fmtPct(a.latest_max_move) : "tracking…"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ margin: "10px 0 0", fontSize: 11, color: "var(--dim)" }}>
            Research signals only — never orders. Extended-hours spreads are wider and fills are worse than the tape suggests. Not financial advice.
          </p>
        </div>
      </main>
    </div>
  );
}
