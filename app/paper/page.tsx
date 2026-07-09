"use client";

/**
 * /paper — Paper Trading dashboard (v1.2).
 *
 * Simulated options trades with realistic limit fills, hard + smart exits,
 * and honest realized-only analytics. Beginner-first: every stat has an
 * InfoTip, every exit explains itself, every closed trade carries a lesson.
 * No broker. No real money. That's the point.
 */

import { Suspense, useCallback, useEffect, useState } from "react";
import { AppNav } from "@/components/AppNav";
import { scanHeaders } from "@/hooks/useScanner";
import { InfoTip } from "@/components/InfoTip";
import { fmtPrice } from "@/lib/format";

interface Summary {
  openCount: number; closedCount: number; gradedCount: number;
  wins: number; losses: number; winRatePct: number | null;
  avgGainPct: number | null; avgLossPct: number | null;
  profitFactor: number | null; expectancyDollars: number | null;
  totalPnlDollars: number; maxDrawdownDollars: number;
  largestWinDollars: number | null; largestLossDollars: number | null;
  avgHoldMinutes: number | null; avgMfePct: number | null; avgMaePct: number | null;
}

interface BucketRow { bucket: string; count: number; winRatePct: number | null; avgPnlPct: number | null; totalDollars: number }

function num(v: number | null | undefined, suffix = "", digits = 1): string {
  if (v == null || Number.isNaN(v)) return "—";
  if (!Number.isFinite(v)) return "∞";
  return `${v.toFixed(digits)}${suffix}`;
}

function dollars(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(0)}`;
}

const STATE_CLASS: Record<string, string> = {
  ENTERED: "up", TAKE_PROFIT: "up", READY: "muted", WATCHING: "muted",
  STOPPED_OUT: "dn", EXITED: "", CANCELLED: "muted", EXPIRED: "muted",
};

function PaperPageInner() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [recentAlerts, setRecentAlerts] = useState<any[]>([]);
  const [createNote, setCreateNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/paper/trades", { cache: "no-store", headers: scanHeaders() });
      const d = await res.json();
      if (d?.ok) { setData(d); setError(null); } else setError(d?.error ?? "load failed");
    } catch (e: any) {
      setError(e?.message ?? "load failed");
    }
  }, []);

  const loadAlerts = useCallback(async () => {
    try {
      const res = await fetch("/api/alerts?limit=12", { cache: "no-store", headers: scanHeaders() });
      const d = await res.json();
      setRecentAlerts((d?.alerts ?? []).filter((a: any) => a.option_symbol && a.asset_class !== "stock"));
    } catch { /* best effort */ }
  }, []);

  useEffect(() => {
    load();
    loadAlerts();
    const t = setInterval(load, 30_000); // matches the engine sweep — auto-updating
    return () => clearInterval(t);
  }, [load, loadAlerts]);

  const act = useCallback(async (id: number, action: "cancel" | "close") => {
    setBusyId(id);
    try {
      await fetch(`/api/paper/trades/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...scanHeaders() },
        body: JSON.stringify({ action }),
      });
      await load();
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const paperIt = useCallback(async (alertId: number) => {
    setCreateNote(null);
    const res = await fetch("/api/paper/trades", {
      method: "POST",
      headers: { "content-type": "application/json", ...scanHeaders() },
      body: JSON.stringify({ alertId }),
    });
    const d = await res.json();
    setCreateNote(d.ok ? `Paper trade #${d.id} created — entry order active.` : `Blocked by risk engine: ${d.risk?.failures?.join("; ")}`);
    await load();
  }, [load]);

  const s: Summary | null = data?.summary ?? null;
  const trades: any[] = data?.trades ?? [];
  const open = trades.filter((t) => ["WATCHING", "READY", "ENTERED"].includes(t.status));
  const closed = trades.filter((t) => !["WATCHING", "READY", "ENTERED"].includes(t.status));

  return (
    <div className="page">
      <AppNav />
      <main className="main-col">
        <section className="panel main">
          <h2 className="section-title">Paper trading</h2>
          <p className="muted text-sm">
            Simulated trades with realistic limit fills (you pay the ask, exit at the bid), hard stops/targets, and smart
            thesis-invalidation exits. Build trust in the system before any real money — every stat below uses realized
            fills only.
          </p>
          {error ? <div className="alert-error">{error} — is the app running with a token set?</div> : null}
        </section>

        {s ? (
          <section className="panel main">
            <h3 className="section-title">Performance</h3>
            <div className="statgrid paper-stats">
              <div><div className="k"><InfoTip metric="winRate">Win rate</InfoTip></div><div className="v num">{num(s.winRatePct, "%")}</div><div className="s">{s.wins}W / {s.losses}L of {s.gradedCount}</div></div>
              <div><div className="k"><InfoTip metric="profitFactor">Profit factor</InfoTip></div><div className="v num">{num(s.profitFactor, "", 2)}</div><div className="s">gross win ÷ gross loss</div></div>
              <div><div className="k"><InfoTip metric="expectancy">Expectancy</InfoTip></div><div className="v num">{dollars(s.expectancyDollars)}</div><div className="s">per graded trade</div></div>
              <div><div className="k">Total P/L</div><div className={`v num ${s.totalPnlDollars >= 0 ? "up" : "dn"}`}>{dollars(s.totalPnlDollars)}</div><div className="s">realized</div></div>
              <div><div className="k"><InfoTip metric="maxDrawdown">Max drawdown</InfoTip></div><div className="v num">{dollars(s.maxDrawdownDollars)}</div><div className="s">worst stretch</div></div>
              <div><div className="k">Avg gain / loss</div><div className="v num">{num(s.avgGainPct, "%")} / {num(s.avgLossPct, "%")}</div><div className="s">winners vs losers</div></div>
              <div><div className="k">Largest win / loss</div><div className="v num">{dollars(s.largestWinDollars)} / {dollars(s.largestLossDollars)}</div><div className="s">outliers matter</div></div>
              <div><div className="k">Avg hold</div><div className="v num">{num(s.avgHoldMinutes, "m", 0)}</div><div className="s">entry → exit</div></div>
              <div><div className="k"><InfoTip metric="mfe">Avg MFE</InfoTip> / <InfoTip metric="mae">MAE</InfoTip></div><div className="v num">{num(s.avgMfePct, "%")} / {num(s.avgMaePct, "%")}</div><div className="s">peak vs heat (learning only)</div></div>
            </div>
          </section>
        ) : null}

        <section className="panel main">
          <h3 className="section-title">Open trades ({open.length})</h3>
          {open.length ? (
            <ul className="ledger">
              {open.map((t) => (
                <li key={t.id}>
                  <span className="t num">#{t.id}</span>
                  <span className="what">
                    <b>{t.ticker}</b> ${t.strike} {t.optionType?.toUpperCase()} {t.expiration} × {t.contracts}
                    <small>
                      {t.status} · entry {t.entryPrice != null ? fmtPrice(t.entryPrice) : `limit ${fmtPrice(t.entryLimit)}`}
                      {t.lastMark != null ? ` · mark ${fmtPrice(t.lastMark)}` : ""}
                      {t.status === "ENTERED" && t.mfePct != null ? ` · peak ${t.mfePct.toFixed(0)}% / heat ${t.maePct?.toFixed(0)}%` : ""}
                    </small>
                    {t.thesis ? <small className="muted">Thesis: {t.thesis.slice(0, 110)}</small> : null}
                  </span>
                  <span className="res">
                    <button className="pill btn btn-xs" disabled={busyId === t.id}
                      onClick={() => act(t.id, t.status === "ENTERED" ? "close" : "cancel")}>
                      {t.status === "ENTERED" ? "Close" : "Cancel"}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ) : <div className="muted text-sm">No open paper trades. Start one from a callout below.</div>}
        </section>

        <section className="panel main">
          <h3 className="section-title">Start from a recent callout</h3>
          <p className="muted text-xs">Uses the callout&apos;s contract + entry mid as the limit. The risk engine can refuse — that&apos;s it working.</p>
          {createNote ? <div className="text-sm">{createNote}</div> : null}
          {recentAlerts.length ? (
            <ul className="ledger">
              {recentAlerts.slice(0, 6).map((a) => (
                <li key={a.id}>
                  <span className="t num">{a.ticker}</span>
                  <span className="what">${a.strike} {String(a.option_side ?? "").toUpperCase()} {a.expiration}
                    <small>setup {Math.round(a.signal_score ?? 0)} · {a.capture_action}</small>
                  </span>
                  <span className="res"><button className="pill btn btn-xs" onClick={() => paperIt(a.id)}>Paper trade it</button></span>
                </li>
              ))}
            </ul>
          ) : <div className="muted text-sm">No recent options callouts with contracts yet today.</div>}
        </section>

        <section className="panel main">
          <h3 className="section-title">Closed trades ({closed.length})</h3>
          {closed.length ? (
            <ul className="ledger">
              {closed.slice(0, 40).map((t) => {
                const pnl = t.entryPrice != null && t.exitPrice != null
                  ? (t.exitPrice - t.entryPrice) * 100 * (t.contracts ?? 1) : null;
                const pct = t.entryPrice ? ((t.exitPrice - t.entryPrice) / t.entryPrice) * 100 : null;
                return (
                  <li key={t.id}>
                    <span className={`t num ${STATE_CLASS[t.status] ?? ""}`}>{t.status}</span>
                    <span className="what">
                      <b>{t.ticker}</b> ${t.strike} {t.optionType?.toUpperCase()} {t.expiration}
                      <small>{t.exitReason ?? "no exit reason recorded"}</small>
                      {t.lessons ? <small className="muted">Lesson: {t.lessons}</small> : null}
                    </span>
                    <span className={`res num ${pnl != null && pnl > 0 ? "pos" : pnl != null ? "neg" : "open"}`}>
                      {pnl != null ? `${pnl > 0 ? "+" : ""}$${Math.abs(pnl).toFixed(0)} (${pct! > 0 ? "+" : ""}${pct!.toFixed(0)}%)` : "—"}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : <div className="muted text-sm">Nothing closed yet — results appear here automatically as exits fire.</div>}
        </section>

        {data?.buckets ? (
          <section className="panel main">
            <h3 className="section-title">Performance by …</h3>
            <div className="paper-buckets">
              {([["Confidence at entry", data.buckets.byConfidence], ["Expiration length", data.buckets.byExpirationLength], ["Setup", data.buckets.bySetup], ["Exit kind", data.buckets.byExitKind]] as [string, BucketRow[]][]).map(([title, rows]) => (
                <div key={title} className="paper-bucket">
                  <h4>{title}</h4>
                  {rows?.length ? (
                    <table className="mini-table">
                      <thead><tr><th>Bucket</th><th>N</th><th>Win%</th><th>Avg%</th><th>$</th></tr></thead>
                      <tbody>
                        {rows.map((b) => (
                          <tr key={b.bucket}>
                            <td>{b.bucket}</td><td className="num">{b.count}</td>
                            <td className="num">{num(b.winRatePct, "%")}</td>
                            <td className="num">{num(b.avgPnlPct, "%")}</td>
                            <td className={`num ${b.totalDollars >= 0 ? "up" : "dn"}`}>{dollars(b.totalDollars)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : <div className="muted text-xs">no data yet</div>}
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </main>
    </div>
  );
}

export default function PaperPage() {
  return (
    <Suspense fallback={null}>
      <PaperPageInner />
    </Suspense>
  );
}
