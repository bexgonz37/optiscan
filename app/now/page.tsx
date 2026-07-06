"use client";

/**
 * /now — the Right Now Dashboard (0DTE command center).
 *
 * Feeds off the every-second loop's in-memory state via
 * /api/scanner/live?realtimeOnly=1 (no extra provider cost), joined with
 * today's alerts for contract-side data (chains only exist for triggered
 * tickers — untriggered rows honestly show "—"). Click a row for the
 * Contract Reality Check (fetched on open only, per the smart-refresh rule).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { scanHeaders } from "@/hooks/useScanner";
import { TickerIcon, ScoreBar } from "@/components/ui";
import { changeColor, fmtPct, fmtPrice, fmtInt, fmtNum } from "@/lib/format";

interface Mover {
  symbol: string; price: number | null; movePct: number | null;
  shortRate: number | null; accel: number | null; surge: number | null;
  efficiency: number | null; direction: string; confidence: number;
  hodBreak: boolean; lodBreak: boolean; aboveVwap: boolean | null;
}

const MOVE_STATUS_TEXT: Record<string, string> = {
  early: "Early", continuing: "Continuation", extended_tradable: "Extended OK",
  extended_risky: "Chase Risk", exhausted: "Exhausted",
};

function dirChip(d: string) {
  if (d === "bullish") return <span style={{ color: "var(--green)", fontWeight: 700 }}>▲ BULL</span>;
  if (d === "bearish") return <span style={{ color: "var(--red)", fontWeight: 700 }}>▼ BEAR</span>;
  return <span style={{ color: "var(--amber)", fontWeight: 700 }}>◆ CHOP</span>;
}

function riskColor(v: string | null | undefined) {
  return v === "High" ? "var(--red)" : v === "Medium" ? "var(--amber)" : "var(--green)";
}

export default function NowPage() {
  const [movers, setMovers] = useState<Mover[]>([]);
  const [loop, setLoop] = useState<any>(null);
  const [alerts, setAlerts] = useState<Map<string, any>>(new Map());
  const [open, setOpen] = useState<string | null>(null);
  const [reality, setReality] = useState<any>(null);
  const [realityLoading, setRealityLoading] = useState(false);

  // 1s-ish realtime poll (in-memory server state — cheap)
  const pollLoop = useCallback(async () => {
    try {
      const res = await fetch("/api/scanner/live?realtimeOnly=1", { cache: "no-store", headers: scanHeaders() });
      const d = await res.json();
      if (d?.ok) { setMovers(d.realtime?.movers ?? []); setLoop(d.realtime); }
    } catch { /* best effort */ }
  }, []);

  // Today's alerts join (contract-side data), every 15s
  const pollAlerts = useCallback(async () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const res = await fetch(`/api/alerts?date=${today}&limit=100`, { cache: "no-store", headers: scanHeaders() });
      const d = await res.json();
      const map = new Map<string, any>();
      for (const a of d.alerts ?? []) if (!map.has(a.ticker)) map.set(a.ticker, a); // newest first already
      setAlerts(map);
    } catch { /* best effort */ }
  }, []);

  useEffect(() => {
    pollLoop(); pollAlerts();
    const a = setInterval(pollLoop, 1500);
    const b = setInterval(pollAlerts, 15000);
    return () => { clearInterval(a); clearInterval(b); };
  }, [pollLoop, pollAlerts]);

  async function openReality(sym: string) {
    if (open === sym) { setOpen(null); setReality(null); return; }
    setOpen(sym); setReality(null); setRealityLoading(true);
    try {
      const res = await fetch(`/api/options/${encodeURIComponent(sym)}?zero=1`, { cache: "no-store", headers: scanHeaders() });
      const d = await res.json();
      setReality(d.ok ? d : { error: d.error });
    } catch (e: any) {
      setReality({ error: e?.message ?? "failed" });
    } finally {
      setRealityLoading(false);
    }
  }

  const rows = useMemo(() => movers.map((m) => ({ m, a: alerts.get(m.symbol) ?? null })), [movers, alerts]);

  const RC = ({ c }: { c: any }) => (
    <div style={{ border: "1px solid rgba(120,140,160,.2)", borderRadius: 8, padding: 10, minWidth: 250, fontSize: 11, lineHeight: 1.6 }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>
        {c.strike}{String(c.side).toUpperCase().slice(0, 1)} {c.expiration} · score {c.contractScore}/100
      </div>
      <div>Bid {fmtPrice(c.bid)} · Ask {fmtPrice(c.ask)} · Mid {fmtPrice(c.mid)} · Spread {c.spreadPct ?? "—"}% ({c.spreadRating})</div>
      <div>Vol {fmtInt(c.volume)} · OI {fmtInt(c.openInterest)} · Liquidity {c.liquidityRating} · Δ {fmtNum(c.delta, 2)} · θ {fmtNum(c.theta, 3)}</div>
      <div>Breakeven {fmtPrice(c.breakeven)} · needs {c.estMoveNeededPct ?? "—"}% vs ~{c.expectedRemainingMovePct}% est. left</div>
      <div>
        Premium <span style={{ color: riskColor(c.premiumRisk) }}>{c.premiumRisk}</span> ·
        Theta <span style={{ color: riskColor(c.thetaRisk) }}> {c.thetaRisk}</span> ·
        IV <span style={{ color: riskColor(c.ivRisk) }}> {c.ivRisk}</span>
      </div>
    </div>
  );

  return (
    <div className="app">
      <div className="topbar">
        <div className="logo"><span className="mark">O</span>OptiScan<small>right now · 0DTE command center</small></div>
        <div className="spacer" />
        <div className="pill">
          <span className={`dot ${loop?.running ? "" : "off"}`} />
          {loop?.running ? `Loop ${loop.intervalMs}ms · ${loop.ticks} ticks · ${loop.alerts} alerts` : "Loop offline"}
        </div>
        {loop?.note ? <div className="pill" style={{ color: "var(--amber)" }}>{String(loop.note).slice(0, 60)}</div> : null}
        <a className="pill btn" href="/">Scanner</a>
        <a className="pill btn" href="/alert-lab">Alert Lab</a>
        <a className="pill btn" href="/settings">⚙</a>
      </div>

      <div className="panel main">
        <div className="toolbar"><h2>Fast movers — updating live</h2><div className="right muted" style={{ fontSize: 11 }}>chains fetch on trigger/open only</div></div>
        {!rows.length ? (
          <div className="empty">
            <div className="big">{loop?.running ? "Warming up — the loop needs ~10s of ticks per symbol." : "Realtime loop is offline."}</div>
            {loop?.note ?? "Movers appear here as velocity builds. Quiet tape = quiet board."}
          </div>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Ticker</th><th>Price</th><th>Move</th><th>Dir</th><th>Speed</th><th>Vol surge</th>
                  <th>VWAP</th><th>HOD/LOD</th><th>Call W</th><th>Put W</th><th>0DTE</th>
                  <th>Spread</th><th>Prem</th><th>θ</th><th>Status</th><th>Label</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ m, a }) => {
                  const flags: string[] = a?.risk_flags ? (() => { try { return JSON.parse(a.risk_flags); } catch { return []; } })() : [];
                  return (
                    <>
                      <tr key={m.symbol} data-sym={m.symbol} className={open === m.symbol ? "sel" : ""} onClick={() => openReality(m.symbol)}>
                        <td><div className="tkr"><TickerIcon symbol={m.symbol} /><div><div className="tname">{m.symbol}</div><div className="tsub">{m.accel != null && m.accel > 0 ? "accelerating" : m.accel != null && m.accel < 0 ? "decelerating" : "steady"}</div></div></div></td>
                        <td className="num">{fmtPrice(m.price)}</td>
                        <td className="num" style={{ color: changeColor(m.movePct) }}>{fmtPct(m.movePct)}</td>
                        <td>{dirChip(m.direction)}</td>
                        <td className="num">{m.shortRate != null ? `${m.shortRate > 0 ? "+" : ""}${m.shortRate.toFixed(2)}%/m` : "—"}</td>
                        <td className="num">{m.surge != null ? `${m.surge}x` : "—"}</td>
                        <td style={{ color: m.aboveVwap == null ? "var(--dim)" : m.aboveVwap ? "var(--green)" : "var(--red)", fontSize: 11 }}>
                          {m.aboveVwap == null ? "—" : m.aboveVwap ? "Above" : "Below"}
                        </td>
                        <td style={{ fontSize: 11 }}>{m.hodBreak ? <span className="tag t-call">HOD</span> : m.lodBreak ? <span className="tag t-put">LOD</span> : "—"}</td>
                        <td className="num" style={{ color: (a?.long_call_score ?? 0) >= 70 ? "var(--green)" : "var(--txt)" }}>{a?.long_call_score != null ? Math.round(a.long_call_score) : "—"}</td>
                        <td className="num" style={{ color: (a?.long_put_score ?? 0) >= 70 ? "var(--red)" : "var(--txt)" }}>{a?.long_put_score != null ? Math.round(a.long_put_score) : "—"}</td>
                        <td>{a?.zero_dte_contract_score != null ? <ScoreBar score={a.zero_dte_contract_score} /> : "—"}</td>
                        <td style={{ color: riskColor(a?.spread_risk), fontSize: 11 }}>{a?.spread_risk ?? "—"}</td>
                        <td style={{ color: riskColor(flags.includes("Premium Too Expensive") ? "High" : a ? "Low" : null), fontSize: 11 }}>{a ? (flags.includes("Premium Too Expensive") ? "High" : "OK") : "—"}</td>
                        <td style={{ color: riskColor(flags.includes("Theta Risk High") ? "High" : a ? "Low" : null), fontSize: 11 }}>{a ? (flags.includes("Theta Risk High") ? "High" : "OK") : "—"}</td>
                        <td style={{ fontSize: 11 }}>{a?.move_status ? MOVE_STATUS_TEXT[a.move_status] ?? a.move_status : "—"}</td>
                        <td style={{ fontSize: 11 }}>{a?.private_label ?? "—"}</td>
                      </tr>
                      {open === m.symbol ? (
                        <tr key={`${m.symbol}-rc`}>
                          <td colSpan={16} style={{ background: "rgba(120,140,160,.04)" }}>
                            {realityLoading ? <div className="muted" style={{ padding: 10, fontSize: 12 }}>Loading 0DTE reality check…</div>
                              : reality?.error ? <div className="warn" style={{ padding: 10 }}>⚠ {reality.error}</div>
                              : reality ? (
                                <div style={{ padding: 10 }}>
                                  <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
                                    Options pressure: <strong>{reality.pressure?.label}</strong>
                                    {" · "}call vol {fmtInt(reality.pressure?.callVolume)} vs put vol {fmtInt(reality.pressure?.putVolume)}
                                    {" · "}{reality.minsToClose} min to close · confirmation context, not certainty
                                  </div>
                                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                                    {(reality.bestCalls ?? []).slice(0, 1).map((c: any) => <RC key={c.optionSymbol} c={c} />)}
                                    {(reality.bestPuts ?? []).slice(0, 1).map((c: any) => <RC key={c.optionSymbol} c={c} />)}
                                  </div>
                                </div>
                              ) : null}
                          </td>
                        </tr>
                      ) : null}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="footer">
        Right Now · every-second tape read · scanner alerts are research signals, never recommendations · not financial advice
      </div>
    </div>
  );
}
