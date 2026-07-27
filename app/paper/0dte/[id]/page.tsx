"use client";

/**
 * /paper/0dte/[id] — visual trade dossier for Aggressive 0DTE Research.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useParams } from "next/navigation";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { scanHeaders } from "@/hooks/useScanner";
import { TermHBar } from "@/components/terminal/TermViz";

function fmtMoney(v: unknown, digits = 2): string {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(digits)}`;
}

function fmtPct(v: unknown, digits = 1): string {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  return `${Number(v).toFixed(digits)}%`;
}

function toneSigned(v: unknown): string {
  if (v == null || !Number.isFinite(Number(v))) return "muted";
  const n = Number(v);
  if (n > 0) return "ok";
  if (n < 0) return "bad";
  return "muted";
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className={`cc-term-kpi ${tone ?? "muted"}`}>
      <span className="cc-term-kpi-label">{label}</span>
      <span className="cc-term-kpi-value">{value}</span>
    </div>
  );
}

function Panel({ title, children, badge }: { title: string; children: ReactNode; badge?: ReactNode }) {
  return (
    <section className="cc-term-panel">
      <header className="cc-term-panel-head">
        <span className="cc-term-panel-title">{title}</span>
        <div className="cc-term-panel-right">{badge}</div>
      </header>
      <div className="cc-term-panel-body">{children}</div>
    </section>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 8, padding: "4px 0", fontSize: "0.82rem" }}>
      <span style={{ color: "#6f8078", letterSpacing: "0.06em", textTransform: "uppercase", fontSize: "0.62rem" }}>{k}</span>
      <span className="cc-term-mono" style={{ color: "#cfe6da", fontSize: "0.82rem" }}>{v ?? "—"}</span>
    </div>
  );
}

export default function ZeroDteTradeDetailPage() {
  const params = useParams();
  const id = String(params?.id ?? "");
  const [trade, setTrade] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setRefreshing(true);
    try {
      const res = await fetch(`/api/research/options/zero-dte-research/${id}`, {
        cache: "no-store",
        headers: scanHeaders(),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        setError(json?.error ?? `HTTP ${res.status}`);
        setTrade(null);
        return;
      }
      setTrade(json.trade);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? "load failed");
    } finally {
      setRefreshing(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const sym = trade?.symbol;
  const spyQqq = sym === "SPY" || sym === "QQQ";

  const premiumPath = useMemo(() => {
    const marks = Array.isArray(trade?.marks) ? trade.marks : [];
    return marks
      .slice()
      .reverse()
      .map((m: any, i: number) => ({
        i,
        t: m.markAtMs,
        premium: m.exitFill ?? ((m.bid != null && m.ask != null) ? (Number(m.bid) + Number(m.ask)) / 2 : null),
        ret: m.returnPct,
      }))
      .filter((p: any) => p.premium != null || p.ret != null);
  }, [trade]);

  const returnPath = useMemo(() => {
    if (premiumPath.length) return premiumPath.map((p: any) => ({ i: p.i, ret: p.ret ?? 0 }));
    const entry = 0;
    const mae = Number(trade?.maePct ?? 0);
    const cur = Number(trade?.returnPct ?? trade?.lastMarkReturnPct ?? 0);
    const mfe = Number(trade?.mfePct ?? 0);
    return [
      { i: 0, ret: entry },
      { i: 1, ret: mae },
      { i: 2, ret: cur },
      { i: 3, ret: mfe },
    ];
  }, [premiumPath, trade]);

  const alts = Array.isArray(trade?.contractAlts) ? trade.contractAlts : [];

  return (
    <div className="ui-page cc-term">
      <div className="cc-term-strip">
        <div className="cc-term-strip-chips">
          <Link href="/paper/0dte" className="cc-term-chip muted" style={{ textDecoration: "none" }}>
            <span className="cc-term-chip-label">Back</span>
            <span className="cc-term-chip-state">0DTE terminal</span>
          </Link>
          {trade ? (
            <>
              <div className={`cc-term-chip ${spyQqq ? "ok" : "muted"}`}>
                <span className="cc-term-chip-label">Symbol</span>
                <span className="cc-term-chip-state">{sym ?? "—"}</span>
              </div>
              <div className={`cc-term-chip ${trade.status === "ENTERED" ? "ok" : "muted"}`}>
                <span className="cc-term-chip-label">Status</span>
                <span className="cc-term-chip-state">{trade.status}</span>
              </div>
            </>
          ) : null}
        </div>
        <div className="cc-term-strip-meta">
          <button type="button" className="cc-term-refresh" disabled={refreshing} onClick={() => void load()}>
            {refreshing ? "…" : "Refresh"}
          </button>
        </div>
      </div>

      <p className="cc-term-disclaimer" style={{ margin: "0 0 12px" }}>
        Aggressive 0DTE Research — simulated only · trade #{id}
      </p>

      {error ? <div className="cc-term-banner bad" style={{ marginBottom: 12 }}>{error}</div> : null}
      {!trade && !error ? <p className="cc-term-empty">Loading dossier…</p> : null}

      {trade ? (
        <>
          <Panel title="Levels">
            <div className="cc-term-kpi-scroll">
              <Kpi label="Entry" value={fmtMoney(trade.entry)} />
              <Kpi label="Stop" value={fmtMoney(trade.stop)} tone="bad" />
              <Kpi label="T1" value={fmtMoney(trade.t1)} tone="ok" />
              <Kpi label="T2" value={fmtMoney(trade.t2)} tone="ok" />
              <Kpi label="MFE" value={fmtPct(trade.mfePct)} tone={toneSigned(trade.mfePct)} />
              <Kpi label="MAE" value={fmtPct(trade.maePct)} tone={toneSigned(trade.maePct)} />
              <Kpi label="Return" value={fmtPct(trade.returnPct ?? trade.lastMarkReturnPct)} tone={toneSigned(trade.returnPct ?? trade.lastMarkReturnPct)} />
              <Kpi label="P&L" value={fmtMoney(trade.pnl)} tone={toneSigned(trade.pnl)} />
            </div>
          </Panel>

          <div className="cc-term-two-col" style={{ marginTop: 14 }}>
            <Panel title="Option premium path" badge={<span className="cc-term-pill muted">marks</span>}>
              <div className="cc-term-chart">
                {premiumPath.length >= 2 ? (
                  <ResponsiveContainer width="100%" height={160}>
                    <LineChart data={premiumPath}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(80,120,100,0.12)" />
                      <XAxis dataKey="i" hide />
                      <YAxis tick={{ fontSize: 9, fill: "#6b7a72" }} width={36} domain={["auto", "auto"]} />
                      <Tooltip contentStyle={{ background: "#0a0c0b", border: "1px solid rgba(80,200,120,0.25)", fontSize: 11 }} />
                      {trade.entry != null ? <ReferenceLine y={Number(trade.entry)} stroke="#5aa9ff" strokeDasharray="4 4" /> : null}
                      {trade.stop != null ? <ReferenceLine y={Number(trade.stop)} stroke="#f2607a" strokeDasharray="3 3" /> : null}
                      {trade.t1 != null ? <ReferenceLine y={Number(trade.t1)} stroke="#34d399" strokeDasharray="3 3" /> : null}
                      {trade.t2 != null ? <ReferenceLine y={Number(trade.t2)} stroke="#f6c454" strokeDasharray="3 3" /> : null}
                      <Line type="monotone" dataKey="premium" stroke="#34d399" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="cc-term-empty">Need ≥2 persisted marks for premium chart</p>
                )}
                <p className="cc-term-footnote">Blue=entry · Red=stop · Green=T1 · Amber=T2</p>
              </div>
            </Panel>
            <Panel title="Return / MFE·MAE path">
              <div className="cc-term-chart">
                <ResponsiveContainer width="100%" height={160}>
                  <LineChart data={returnPath}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(80,120,100,0.12)" />
                    <XAxis dataKey="i" hide />
                    <YAxis tick={{ fontSize: 9, fill: "#6b7a72" }} width={32} />
                    <Tooltip contentStyle={{ background: "#0a0c0b", border: "1px solid rgba(80,200,120,0.25)", fontSize: 11 }} />
                    <ReferenceLine y={0} stroke="#6f8078" />
                    <Line type="monotone" dataKey="ret" stroke="#5aa9ff" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          </div>

          <div className="cc-term-two-col" style={{ marginTop: 14 }}>
            <Panel title="Thesis">
              <Row k="Entered" v={trade.whyEntered} />
              <Row k="Current" v={trade.status === "ENTERED" ? "Position still open — thesis = family + exit policy" : trade.whyExited} />
              <Row k="Invalidates" v={`Stop ${fmtMoney(trade.stop)} · policy ${trade.exitPolicy ?? "—"}`} />
              <Row k="Trigger" v={trade.entryTrigger} />
              <Row k="Family" v={trade.family} />
            </Panel>
            <Panel title="Exit-policy progress">
              <div className="term-policy-meter">
                <div className="term-policy-labels">
                  <span>Stop</span><span>Entry</span><span>T1</span><span>T2</span>
                </div>
                <div className="term-progress-mini" style={{ height: 10 }}>
                  <i
                    className="term-progress-fill"
                    style={{
                      width: `${Math.max(5, Math.min(100, 50 + Number(trade.returnPct ?? trade.lastMarkReturnPct ?? 0)))}%`,
                    }}
                  />
                </div>
                <p className="cc-term-footnote">Policy: {trade.exitPolicy ?? "—"} · Exit: {trade.exitReason ?? "still open"}</p>
              </div>
              <Row k="OCC" v={trade.optionSymbol} />
              <Row k="Moneyness" v={trade.moneyness} />
              <Row k="Risk $" v={fmtMoney(trade.accountRiskUsd, 0)} />
            </Panel>
          </div>

          <Panel title="Event timeline">
            <ul className="term-timeline">
              <li><b>Entry</b> · {trade.enteredAtMs ? new Date(Number(trade.enteredAtMs)).toLocaleString() : "—"} · {trade.whyEntered}</li>
              {(trade.marks ?? []).slice(0, 5).map((m: any, i: number) => (
                <li key={i}>
                  <b>Mark</b> · {m.markAtMs ? new Date(Number(m.markAtMs)).toLocaleTimeString() : "—"} · ret {fmtPct(m.returnPct)}
                </li>
              ))}
              <li><b>Exit</b> · {trade.exitAtMs ? new Date(Number(trade.exitAtMs)).toLocaleString() : "open"} · {trade.whyExited ?? "—"}</li>
            </ul>
          </Panel>

          <Panel title="Contract alternatives">
            {alts.length ? (
              <TermHBar
                rows={alts.slice(0, 6).map((a: any, i: number) => ({
                  key: String(a.moneyness ?? a.strike ?? i),
                  label: `${a.moneyness ?? "alt"} ${a.strike ?? ""}`,
                  value: Number(a.strike ?? i + 1),
                  tone: "info",
                }))}
              />
            ) : (
              <p className="cc-term-empty">No contract_alts_json</p>
            )}
          </Panel>

          <button type="button" className="cc-term-collapse" onClick={() => setAdvanced((v) => !v)}>
            Advanced evidence {advanced ? "▾" : "▸"}
          </button>
          {advanced ? (
            <>
              <Panel title="Setup evidence (JSON)">
                {trade.setupEvidence && Object.keys(trade.setupEvidence).length ? (
                  <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: "0.72rem", color: "#9fb3a8" }}>
                    {JSON.stringify(trade.setupEvidence, null, 2)}
                  </pre>
                ) : (
                  <p className="cc-term-empty">No feature_snapshot_json</p>
                )}
              </Panel>
              <Panel title="Fingerprint / raw marks">
                <Row k="Fingerprint" v={trade.fingerprint} />
                {!Array.isArray(trade.marks) || trade.marks.length === 0 ? (
                  <p className="cc-term-empty">No persisted marks</p>
                ) : (
                  <table className="mini-table" style={{ width: "100%" }}>
                    <thead>
                      <tr><th>When</th><th>Bid</th><th>Ask</th><th>Fill</th><th>Return</th></tr>
                    </thead>
                    <tbody>
                      {trade.marks.map((m: any, i: number) => (
                        <tr key={`${m.markAtMs}-${i}`}>
                          <td>{m.markAtMs ? new Date(Number(m.markAtMs)).toLocaleString() : "—"}</td>
                          <td className="num">{m.bid != null ? Number(m.bid).toFixed(2) : "—"}</td>
                          <td className="num">{m.ask != null ? Number(m.ask).toFixed(2) : "—"}</td>
                          <td className="num">{m.exitFill != null ? Number(m.exitFill).toFixed(2) : "—"}</td>
                          <td className={`num ${toneSigned(m.returnPct)}`}>{fmtPct(m.returnPct)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Panel>
            </>
          ) : null}

          <div className="cc-term-links">
            <Link href="/paper/0dte" className="cc-term-link">← Back to 0DTE terminal</Link>
            <Link href="/paper?tab=0dte" className="cc-term-link">Paper tab</Link>
          </div>
        </>
      ) : null}
    </div>
  );
}
