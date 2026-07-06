"use client";

/**
 * Live 0DTE movers board — feeds off the every-second scanner loop (in-memory).
 * Click a row to expand contract reality check (chains fetch on open only).
 */

import { useCallback, useEffect, useMemo, useState, Fragment } from "react";
import { scanHeaders } from "@/hooks/useScanner";
import { TickerIcon, ScoreBar } from "@/components/ui";
import { changeColor, fmtPct, fmtPrice, fmtInt, fmtNum } from "@/lib/format";

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

function riskColor(v: string | null | undefined) {
  return v === "High" ? "var(--red)" : v === "Medium" ? "var(--amber)" : "var(--green)";
}

function ContractCard({ c }: { c: any }) {
  return (
    <div className="contract-card">
      <div className="contract-card-title">
        {c.strike}
        {String(c.side).toUpperCase().slice(0, 1)} {c.expiration} · score {c.contractScore}/100
      </div>
      <div>Bid {fmtPrice(c.bid)} · Ask {fmtPrice(c.ask)} · Mid {fmtPrice(c.mid)} · Spread {c.spreadPct ?? "—"}% ({c.spreadRating})</div>
      <div>Vol {fmtInt(c.volume)} · OI {fmtInt(c.openInterest)} · Liquidity {c.liquidityRating} · Δ {fmtNum(c.delta, 2)} · θ {fmtNum(c.theta, 3)}</div>
      <div>Breakeven {fmtPrice(c.breakeven)} · needs {c.estMoveNeededPct ?? "—"}% vs ~{c.expectedRemainingMovePct}% est. left</div>
      <div>
        Premium <span style={{ color: riskColor(c.premiumRisk) }}>{c.premiumRisk}</span>
        {" · "}Theta <span style={{ color: riskColor(c.thetaRisk) }}>{c.thetaRisk}</span>
        {" · "}IV <span style={{ color: riskColor(c.ivRisk) }}>{c.ivRisk}</span>
      </div>
    </div>
  );
}

export function LiveMoversBoard({ loopStatus }: { loopStatus?: (running: boolean, note?: string) => void }) {
  const [movers, setMovers] = useState<Mover[]>([]);
  const [loop, setLoop] = useState<any>(null);
  const [alerts, setAlerts] = useState<Map<string, any>>(new Map());
  const [open, setOpen] = useState<string | null>(null);
  const [reality, setReality] = useState<any>(null);
  const [realityLoading, setRealityLoading] = useState(false);

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

  async function openReality(sym: string) {
    if (open === sym) {
      setOpen(null);
      setReality(null);
      return;
    }
    setOpen(sym);
    setReality(null);
    setRealityLoading(true);
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

  return (
    <section className="panel main section-live">
      <div className="section-header">
        <div>
          <h2 className="section-title">Live movers</h2>
          <p className="section-sub">0DTE tape · updates every ~1.5s · chains on trigger only</p>
        </div>
        <div className="status-group">
          <span className={`status-dot ${loop?.running ? "live" : ""}`} />
          <span className="status-text">{loop?.running ? "Loop live" : "Loop offline"}</span>
          {loop?.note ? <span className="status-warn">{String(loop.note).slice(0, 50)}</span> : null}
        </div>
      </div>

      {!rows.length ? (
        <div className="empty">
          <div className="big">{loop?.running ? "Warming up — needs ~10s of ticks per symbol." : "Realtime loop is offline."}</div>
          {loop?.note ?? "Movers appear as velocity builds. Quiet tape = quiet board."}
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
                  <Fragment key={m.symbol}>
                    <tr data-sym={m.symbol} className={open === m.symbol ? "sel" : ""} onClick={() => openReality(m.symbol)}>
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
                    {open === m.symbol ? (
                      <tr className="expand-row">
                        <td colSpan={13}>
                          {realityLoading ? (
                            <div className="muted expand-pad">Loading 0DTE reality check…</div>
                          ) : reality?.error ? (
                            <div className="warn expand-pad">⚠ {reality.error}</div>
                          ) : reality ? (
                            <div className="expand-pad">
                              <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
                                Options pressure: <strong>{reality.pressure?.label}</strong>
                                {" · "}call vol {fmtInt(reality.pressure?.callVolume)} vs put vol {fmtInt(reality.pressure?.putVolume)}
                                {" · "}{reality.minsToClose} min to close
                              </div>
                              <div className="contract-cards">
                                {(reality.bestCalls ?? []).slice(0, 1).map((c: any) => (
                                  <ContractCard key={c.optionSymbol} c={c} />
                                ))}
                                {(reality.bestPuts ?? []).slice(0, 1).map((c: any) => (
                                  <ContractCard key={c.optionSymbol} c={c} />
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
