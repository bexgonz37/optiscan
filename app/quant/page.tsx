"use client";

/**
 * /quant — Quant dashboard: setup grades, historical edge, Best Setup Plan,
 * and a simple backtest runner. Completes the quant-statistics layer
 * (backend: lib/quant.ts + /api/quant/*).
 *
 * Honesty rules baked in: stats are labeled with sample size and data
 * quality; low-sample setups grade LOW by design; everything carries the
 * "historical analysis, not financial advice" disclaimer. Until the 5-year
 * dataset is connected (see data coverage card), stats build from live
 * paper/journal/alert outcomes.
 */

import { Suspense, useCallback, useEffect, useState } from "react";
import { scanHeaders } from "@/hooks/useScanner";
import { InfoTip } from "@/components/InfoTip";
import { CardTip } from "@/components/CardTip";
import { Panel } from "@/components/ui/Panel";
import { StatTile } from "@/components/ui/StatTile";

function num(v: number | null | undefined, suffix = "", digits = 1): string {
  if (v == null || Number.isNaN(v)) return "—";
  if (!Number.isFinite(v)) return "∞";
  return `${v.toFixed(digits)}${suffix}`;
}

const GRADE_CLASS: Record<string, string> = {
  "A+": "up", A: "up", B: "", C: "muted", D: "dn", F: "dn",
};

function QuantPageInner() {
  const [plan, setPlan] = useState<any>(null);
  const [stats, setStats] = useState<any[]>([]);
  const [dash, setDash] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [bt, setBt] = useState<any>(null);
  const [btBusy, setBtBusy] = useState(false);
  const [btSetup, setBtSetup] = useState<string>("");
  const [btStop, setBtStop] = useState<string>("30");
  const [btTarget, setBtTarget] = useState<string>("50");

  const load = useCallback(async (refresh = false) => {
    try {
      const h = { cache: "no-store" as const, headers: scanHeaders() };
      const [p, s, d] = await Promise.all([
        fetch(`/api/quant/best-setups${refresh ? "?refresh=1" : ""}`, h).then((r) => r.json()),
        fetch("/api/quant/setup-stats", h).then((r) => r.json()),
        fetch("/api/quant/performance-dashboard", h).then((r) => r.json()),
      ]);
      if (p?.ok) setPlan(p.plan);
      if (s?.ok) setStats(s.stats ?? s.setupStats ?? []);
      if (d?.ok) setDash(d);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? "load failed — is the app running with your token set?");
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try { await load(true); } finally { setRefreshing(false); }
  }, [load]);

  const runBacktest = useCallback(async () => {
    setBtBusy(true);
    try {
      const res = await fetch("/api/quant/backtest", {
        method: "POST",
        headers: { "content-type": "application/json", ...scanHeaders() },
        body: JSON.stringify({
          setupType: btSetup || undefined,
          stopLossPct: Number(btStop) || undefined,
          profitTargetPct: Number(btTarget) || undefined,
        }),
      });
      const d = await res.json();
      setBt(d?.ok ? (d.result ?? d.backtest ?? d) : { error: d?.error ?? "backtest failed" });
    } catch (e: any) {
      setBt({ error: e?.message ?? "backtest failed" });
    } finally {
      setBtBusy(false);
    }
  }, [btSetup, btStop, btTarget]);

  const coverage = plan?.dataCoverage;
  const focus: any[] = plan?.focusToday ?? [];
  const avoid: any[] = plan?.avoidToday ?? plan?.avoid ?? [];

  return (
    <div className="page axiom-utility">
      <main className="main-col axiom-live">
        <CardTip metric="quantPlan" className="utility-hero">
          <section className="panel main utility-intro">
            <h2 className="section-title"><InfoTip metric="quantPlan">Quant — historical edge</InfoTip></h2>
            <div className="alert-warn text-sm">
              Historical/statistical analysis, not financial advice. Grades require real sample sizes — small-sample
              setups grade LOW on purpose, and past edge never guarantees future results.
            </div>
            <div className="btn-row mt-2">
              <button className="pill btn btn-primary" disabled={refreshing} onClick={refresh}>
                {refreshing ? "Recomputing…" : "Recompute stats"}
              </button>
              {coverage ? (
                <span className={`pill badge${coverage.status === "historical_connected" ? " badge-live" : " badge-warn"}`}>
                  {coverage.status === "historical_connected"
                    ? "5-year history connected"
                    : `Building from live outcomes (${coverage.tradeOutcomes ?? 0} graded) — 5y adapter not connected yet`}
                </span>
              ) : null}
            </div>
            {error ? <div className="alert-error mt-2">{error}</div> : null}
          </section>
        </CardTip>

        {dash ? (
          <div className="axiom-strip">
            <StatTile label="Graded outcomes" value={dash.totalOutcomes ?? dash.tradeOutcomes ?? coverage?.tradeOutcomes ?? "—"} hint="all sources" metric="sampleSize" />
            <StatTile label="Setup types" value={stats.length || "—"} hint="tracked" metric="setupGrade" />
            <StatTile label="Best grade" value={stats[0]?.grade ?? "—"} hint={stats[0]?.setupType ?? "no data yet"} metric="setupGrade" />
            <StatTile label="Focus today" value={focus.length} hint="positive-edge setups" metric="quantPlan" />
          </div>
        ) : null}

        <Panel title="Best Setup Plan — focus today" meta={plan?.generatedAt ? new Date(plan.generatedAt).toLocaleTimeString() : "…"} tip="quantPlan">
          {focus.length ? (
            <ul className="ledger">
              {focus.map((f: any) => (
                <li key={f.setupType}>
                  <span className={`t num ${GRADE_CLASS[f.grade] ?? ""}`}>{f.grade}</span>
                  <span className="what">
                    <b>{f.setupType}</b> · conf {f.confidenceScore}/100 · win {num(f.winRate, "%")} · expectancy {num(f.expectancy, "%")}
                    <small>Entry: {f.idealEntry}</small>
                    <small>Stop {f.suggestedStop} · target {f.suggestedTarget} · hold {f.idealHoldTime} · risk {f.riskLevel}</small>
                    <small className="muted">{f.reason}</small>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="sigwhy muted text-sm">
              No setups have earned the focus list yet — it fills as paper trades and tracked alerts close. That is the
              system being honest, not broken.
            </div>
          )}
          {avoid.length ? (
            <div className="mt-2">
              <div className="muted text-xs">Historically weak — deprioritize:</div>
              <div className="text-sm">{avoid.map((a: any) => `${a.setupType} (${a.grade})`).join(" · ")}</div>
            </div>
          ) : null}
        </Panel>

        <Panel title="Setup statistics" meta={`${stats.length} setup types · grades gated by sample size`} tip="setupGrade">
          {stats.length ? (
            <table className="mini-table">
              <thead>
                <tr>
                  <th>Setup</th><th><InfoTip metric="setupGrade">Grade</InfoTip></th>
                  <th><InfoTip metric="sampleSize">n</InfoTip></th>
                  <th><InfoTip metric="winRate">Win%</InfoTip></th>
                  <th><InfoTip metric="expectancy">Expect.</InfoTip></th>
                  <th><InfoTip metric="profitFactor">PF</InfoTip></th>
                  <th><InfoTip metric="maxDrawdown">DD</InfoTip></th>
                  <th>Quality</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((s: any) => (
                  <tr key={`${s.setupType}-${s.assetClass}`}>
                    <td>{s.setupType} <small className="muted">{s.assetClass}</small></td>
                    <td className={`num ${GRADE_CLASS[s.grade] ?? ""}`}>{s.grade}</td>
                    <td className="num">{s.sampleSize}</td>
                    <td className="num">{num(s.winRate, "%")}</td>
                    <td className="num">{num(s.expectancy, "%")}</td>
                    <td className="num">{num(s.profitFactor, "", 2)}</td>
                    <td className="num">{num(s.maxDrawdown, "%")}</td>
                    <td className={s.dataQuality === "strong" ? "up" : "muted"}>{s.dataQuality}{s.warning ? " ⚠" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="sigwhy muted text-sm">No graded outcomes yet — run the scanner + paper trading and stats appear automatically.</div>
          )}
        </Panel>

        <Panel title="Backtest" meta="replays graded outcomes with your stop/target" tip="quantPlan">
          <div className="btn-row" style={{ flexWrap: "wrap", gap: 8 }}>
            <label className="sort-control"><span>Setup</span>
              <select value={btSetup} onChange={(e) => setBtSetup(e.target.value)}>
                <option value="">All setups</option>
                {stats.map((s: any) => <option key={`${s.setupType}-${s.assetClass}`} value={s.setupType}>{s.setupType}</option>)}
              </select>
            </label>
            <label className="sort-control"><span>Stop %</span>
              <input type="number" value={btStop} onChange={(e) => setBtStop(e.target.value)} style={{ width: 64 }} />
            </label>
            <label className="sort-control"><span>Target %</span>
              <input type="number" value={btTarget} onChange={(e) => setBtTarget(e.target.value)} style={{ width: 64 }} />
            </label>
            <button className="pill btn btn-primary" disabled={btBusy} onClick={runBacktest}>{btBusy ? "Running…" : "Run backtest"}</button>
          </div>
          {bt?.error ? <div className="alert-error mt-2">{bt.error}</div> : null}
          {bt && !bt.error ? (
            <div className="axiom-strip mt-2">
              <StatTile label="Trades" value={bt.totalTrades ?? "—"} metric="sampleSize" />
              <StatTile label="Win rate" value={num(bt.winRate, "%")} metric="winRate" />
              <StatTile label="Avg return" value={num(bt.averageReturn ?? bt.avgReturn, "%")} metric="expectancy" />
              <StatTile label="Expectancy" value={num(bt.expectancy, "%")} metric="expectancy" />
              <StatTile label="Max DD" value={num(bt.maxDrawdown, "%")} metric="maxDrawdown" />
            </div>
          ) : null}
          {bt?.warning ? <div className="muted text-xs mt-2">⚠ {bt.warning}</div> : null}
        </Panel>
      </main>
    </div>
  );
}

export default function QuantPage() {
  return (
    <Suspense fallback={null}>
      <QuantPageInner />
    </Suspense>
  );
}
