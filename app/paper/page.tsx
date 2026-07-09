"use client";

/**
 * /paper — Paper Trading dashboard (v1.3).
 * Autonomous from the AI copilot: deterministic auto-entry + scanner piggyback exits.
 */

import { Suspense, useCallback, useEffect, useState } from "react";
import { scanHeaders } from "@/hooks/useScanner";
import { InfoTip } from "@/components/InfoTip";
import { CardTip } from "@/components/CardTip";
import { Panel } from "@/components/ui/Panel";
import { StatTile } from "@/components/ui/StatTile";
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

function timeAgo(ms: number | null | undefined): string {
  if (!ms) return "never";
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
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
    const t = setInterval(load, 7_000);
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
  const engine = data?.engine ?? null;
  const trades: any[] = data?.trades ?? [];
  const decisions: any[] = data?.decisions ?? [];
  const open = trades.filter((t) => ["WATCHING", "READY", "ENTERED"].includes(t.status));
  const closed = trades.filter((t) => !["WATCHING", "READY", "ENTERED"].includes(t.status));
  const risk = engine?.risk ?? {};

  return (
    <div className="page axiom-utility">
      <main className="main-col axiom-live">
        <CardTip metric="paperTrading" className="utility-hero">
          <section className="panel main utility-intro">
            <h2 className="section-title"><InfoTip metric="paperTrading">Paper trading</InfoTip></h2>
            <p className="muted text-sm">
              Fully autonomous from the AI copilot — deterministic rules only. Fresh TRADE callouts auto-enter when
              <code> PAPER_AUTO_ENTRY=1</code>; hot symbols re-price every ~7s via the scanner&apos;s own chain refresh;
              everything else sweeps every {engine?.sweepMs ? Math.round(engine.sweepMs / 1000) : 30}s.
            </p>
            <div className="utility-badges">
              <span className={`pill badge${engine?.running ? " badge-live" : ""}`}>
                {engine?.running ? "Engine live" : "Engine offline"}
              </span>
              <span className={`pill badge${engine?.autoEntryEnabled ? " badge-live" : ""}`}>
                {engine?.autoEntryEnabled ? "Auto-entry ON" : "Auto-entry off"}
              </span>
              {engine?.autoEntryEnabled && !engine?.allowZeroDte ? (
                <span className="pill badge badge-warn">Needs PAPER_ALLOW_ZERO_DTE=1</span>
              ) : null}
              {risk.killSwitch ? <span className="pill badge badge-warn">Kill switch ON</span> : null}
            </div>
            {error ? <div className="alert-error">{error} — is the app running with a token set?</div> : null}
          </section>
        </CardTip>

        <Panel title="Risk rules the agent cannot override" meta="Beginner guardrails · enforced before every entry" tip="paperTrading">
          <div className="paper-buckets">
            <div className="paper-bucket">
              <h4>Position limits</h4>
              <p className="muted text-xs">
                Max risk {dollars(risk.maxRiskPerTrade)} per trade · max {risk.maxOpenTrades ?? "—"} open trades · max {dollars(risk.maxExposurePerTicker)} per ticker.
              </p>
            </div>
            <div className="paper-bucket">
              <h4>Loss circuit breakers</h4>
              <p className="muted text-xs">
                Daily loss {dollars(risk.maxDailyLoss)} · weekly loss {dollars(risk.maxWeeklyLoss)} · cooldown after a loss {risk.cooldownAfterLossMinutes ?? 30}m.
              </p>
            </div>
            <div className="paper-bucket">
              <h4>Execution discipline</h4>
              <p className="muted text-xs">
                0DTE {risk.allowZeroDte ? "allowed by env" : "blocked by default"} · averaging down {risk.allowAveragingDown ? "allowed by env" : "blocked"} · kill switch {risk.killSwitch ? "ON" : "off"}.
              </p>
            </div>
          </div>
        </Panel>

        {s ? (
          <div className="axiom-strip paper-strip">
            <StatTile label="Win rate" value={num(s.winRatePct, "%")} hint={`${s.wins}W / ${s.losses}L of ${s.gradedCount}`} metric="winRate" />
            <StatTile label="Profit factor" value={num(s.profitFactor, "", 2)} hint="gross win ÷ gross loss" metric="profitFactor" />
            <StatTile label="Expectancy" value={dollars(s.expectancyDollars)} hint="per graded trade" metric="expectancy" />
            <StatTile label="Total P/L" value={dollars(s.totalPnlDollars)} hint="realized" metric="paperTrading" />
            <StatTile label="Max drawdown" value={dollars(s.maxDrawdownDollars)} hint="worst stretch" metric="maxDrawdown" />
            <StatTile label="Avg gain / loss" value={`${num(s.avgGainPct, "%")} / ${num(s.avgLossPct, "%")}`} hint="winners vs losers" metric="paperTrading" />
            <StatTile label="Largest win / loss" value={`${dollars(s.largestWinDollars)} / ${dollars(s.largestLossDollars)}`} hint="outliers matter" metric="paperTrading" />
            <StatTile label="Avg hold" value={num(s.avgHoldMinutes, "m", 0)} hint="entry → exit" metric="paperTrading" />
          </div>
        ) : null}

        <Panel title="Open trades" meta={`${open.length} active · ~7s marks on hot symbols`} live tip="paperTrading">
          {open.length ? (
            <ul className="ledger axiom-ledger">
              {open.map((t) => (
                <li key={t.id}>
                  <span className="t num">#{t.id}</span>
                  <span className="what">
                    <b>{t.ticker}</b> ${t.strike} {t.optionType?.toUpperCase()} {t.expiration} × {t.contracts}
                    <small>
                      {t.status} · entry {t.entryPrice != null ? fmtPrice(t.entryPrice) : `limit ${fmtPrice(t.entryLimit)}`}
                      {t.lastMark != null ? ` · mark ${fmtPrice(t.lastMark)}` : ""}
                      {t.unrealizedPnlDollars != null ? ` · unrealized ${t.unrealizedPnlDollars >= 0 ? "+" : ""}$${Math.abs(t.unrealizedPnlDollars).toFixed(0)} (${t.unrealizedPnlPct > 0 ? "+" : ""}${t.unrealizedPnlPct.toFixed(0)}%)` : ""}
                      {t.status === "ENTERED" && t.mfePct != null ? ` · peak ${t.mfePct.toFixed(0)}% / heat ${t.maePct?.toFixed(0)}%` : ""}
                    </small>
                    {t.entrySnapshot?.delta != null ? (
                      <small className="muted">
                        At entry: Δ {Number(t.entrySnapshot.delta).toFixed(2)}
                        {t.entrySnapshot.iv != null ? ` · IV ${(Number(t.entrySnapshot.iv) * 100).toFixed(0)}%` : ""}
                        {t.entrySnapshot.spreadPct != null ? ` · spread ${Number(t.entrySnapshot.spreadPct).toFixed(1)}%` : ""}
                      </small>
                    ) : null}
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
          ) : <div className="sigwhy muted text-sm">No open paper trades — auto-entry will populate when TRADE callouts fire.</div>}
        </Panel>

        <Panel title="Agent decision log" meta={`${decisions.length} latest · entries, refusals, fills, exits`} tip="paperTrading">
          {decisions.length ? (
            <ul className="ledger axiom-ledger">
              {decisions.slice(0, 16).map((d) => (
                <li key={d.id}>
                  <span className={`t num ${d.allowed ? "up" : "dn"}`}>{d.allowed ? "PASS" : "BLOCK"}</span>
                  <span className="what">
                    <b>{d.ticker ?? "SYSTEM"}</b> {String(d.decision).replaceAll("_", " ")}
                    <small>{d.reason}</small>
                    {d.snapshot?.optionSymbol ? (
                      <small className="muted">
                        Quote: {d.snapshot.optionSymbol} · bid {d.snapshot.bid ?? "—"} · ask {d.snapshot.ask ?? "—"} · spread {d.snapshot.spreadPct ?? "—"}%
                      </small>
                    ) : null}
                  </span>
                  <span className="res muted text-xs">{timeAgo(d.createdAtMs)}</span>
                </li>
              ))}
            </ul>
          ) : <div className="sigwhy muted text-sm">No agent decisions logged yet. The first auto-entry, risk refusal, fill, or exit will appear here.</div>}
        </Panel>

        <Panel title="Manual override" meta="Optional — engine runs without this" tip="paperTrading">
          <p className="muted text-xs">Force a paper trade from a recent callout. The risk engine can still refuse.</p>
          {createNote ? <div className="text-sm">{createNote}</div> : null}
          {recentAlerts.length ? (
            <ul className="ledger axiom-ledger">
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
        </Panel>

        <Panel title="Closed trades" meta={`${closed.length} graded · lessons auto-generated`} tip="paperTrading">
          {closed.length ? (
            <ul className="ledger axiom-ledger">
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
          ) : <div className="sigwhy muted text-sm">Nothing closed yet — exits fire automatically on stops, targets, and thesis breaks.</div>}
        </Panel>

        {data?.buckets ? (
          <Panel title="Performance buckets" meta="Where the edge is (or isn't)" tip="paperTrading">
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
          </Panel>
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
