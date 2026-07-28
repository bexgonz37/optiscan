"use client";

/**
 * Research Lab panels for /alerts?tab=research —
 * universe funnel attrition, Factor IC, journal tearsheet, trial log.
 * Visibility only — does not change Discord SEND.
 */

import { useCallback, useEffect, useState } from "react";
import { scanHeaders } from "@/hooks/useScanner";
import { Panel } from "@/components/ui/Panel";

type FactorName =
  | "signal_score"
  | "risk_score"
  | "options_liquidity_score"
  | "scanner_score"
  | "continuation_score"
  | "exhaustion_score"
  | "long_call_score"
  | "long_put_score"
  | "zero_dte_contract_score"
  | "option_worth_score";

const FACTORS: FactorName[] = [
  "signal_score",
  "risk_score",
  "options_liquidity_score",
  "scanner_score",
  "continuation_score",
  "exhaustion_score",
  "long_call_score",
  "long_put_score",
  "zero_dte_contract_score",
  "option_worth_score",
];

const HORIZONS = ["5m", "15m", "30m", "1h", "eod"] as const;

function fmt(n: number | null | undefined, digits = 3): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return Number(n).toFixed(digits);
}

export function ResearchLabPanels() {
  const [factor, setFactor] = useState<FactorName>("signal_score");
  const [horizon, setHorizon] = useState<(typeof HORIZONS)[number]>("30m");
  const [funnel, setFunnel] = useState<any>(null);
  const [ic, setIc] = useState<any>(null);
  const [tear, setTear] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loadFunnel = useCallback(async () => {
    try {
      const d = await fetch("/api/diagnostics/universe-funnel", { headers: scanHeaders(), cache: "no-store" }).then((r) => r.json());
      if (d.ok) setFunnel(d);
    } catch { /* best effort */ }
  }, []);

  const loadTear = useCallback(async () => {
    try {
      const d = await fetch("/api/journal/tearsheet", { headers: scanHeaders(), cache: "no-store" }).then((r) => r.json());
      if (d.ok) setTear(d);
    } catch { /* best effort */ }
  }, []);

  const loadIc = useCallback(async (recordTrial = false) => {
    setBusy(true);
    setErr(null);
    try {
      const q = new URLSearchParams({ factor, horizon });
      if (recordTrial) q.set("recordTrial", "1");
      const d = await fetch(`/api/alerts/factor-ic?${q}`, { headers: scanHeaders(), cache: "no-store" }).then((r) => r.json());
      if (!d.ok) setErr(d.error ?? "factor-ic failed");
      else setIc(d);
    } catch (e: any) {
      setErr(e?.message ?? "factor-ic failed");
    } finally {
      setBusy(false);
    }
  }, [factor, horizon]);

  useEffect(() => {
    loadFunnel();
    loadTear();
    loadIc(false);
  }, [loadFunnel, loadTear, loadIc]);

  const stages = funnel?.summary?.stages ?? funnel?.snapshot?.stages ?? [];
  const report = ic?.report;
  const tearsheet = tear?.tearsheet;
  const trials = ic?.recentTrials ?? tear?.researchTrials ?? [];

  return (
    <div className="research-lab" style={{ display: "grid", gap: 14 }}>
      <p className="muted text-sm" style={{ margin: 0 }}>
        Research Lab · funnel attrition + factor IC + trial log. Does not change Discord delivery.
        Do not tune weights until the trial log has real N.
      </p>
      {err ? <div className="error-banner">{err}</div> : null}

      <Panel title="Universe filter funnel" meta="Last scan attrition per stage">
        {!stages.length ? (
          <p className="muted text-sm">No filter snapshot yet — runs after the next radar scan with contracts.</p>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Entered</th>
                  <th>Passed</th>
                  <th>Dropped</th>
                  <th>Top drop reason</th>
                </tr>
              </thead>
              <tbody>
                {stages.map((s: any) => (
                  <tr key={s.id}>
                    <td>{s.id}</td>
                    <td className="num">{s.entered}</td>
                    <td className="num">{s.passed}</td>
                    <td className="num">{s.dropped}</td>
                    <td className="muted text-xs">{s.topReason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted text-xs" style={{ marginTop: 8 }}>
              Survived {funnel?.summary?.survived ?? "—"} / entered {funnel?.summary?.entered ?? "—"}. Diagnostic only.
            </p>
          </div>
        )}
      </Panel>

      <Panel title="Factor Lab" meta="Spearman IC · day-block bootstrap · Šidák when recorded">
        <div className="toolbar" style={{ gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          <select value={factor} onChange={(e) => setFactor(e.target.value as FactorName)} style={{ minWidth: 180 }}>
            {FACTORS.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
          <select value={horizon} onChange={(e) => setHorizon(e.target.value as (typeof HORIZONS)[number])}>
            {HORIZONS.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
          <button className="pill btn" type="button" disabled={busy} onClick={() => loadIc(false)}>
            Run IC
          </button>
          <button className="pill btn btn-primary" type="button" disabled={busy} onClick={() => loadIc(true)}>
            Run + log trial
          </button>
        </div>
        {!report ? (
          <p className="muted text-sm">No factor report yet.</p>
        ) : (
          <div className="kpis axiom-kpis" style={{ marginBottom: 10 }}>
            <div className="kpi"><div className="label">Mean IC</div><div className="val num">{fmt(report.meanIc)}</div><div className="sub">{report.usableDays} usable days</div></div>
            <div className="kpi"><div className="label">IC IR</div><div className="val num">{fmt(report.icIr)}</div><div className="sub">pooled {fmt(report.pooledSpearman)}</div></div>
            <div className="kpi"><div className="label">Bootstrap 95%</div><div className="val num" style={{ fontSize: 14 }}>{fmt(report.bootstrap?.lo)} … {fmt(report.bootstrap?.hi)}</div><div className="sub">{report.bootstrap?.samples} day-blocks</div></div>
            <div className="kpi"><div className="label">Top Q vs baseline</div><div className="val num">{fmt(report.topQuintileMean)} / {fmt(report.baselineMeanForward)}</div><div className="sub">{report.beatsBaseline == null ? "n/a" : report.beatsBaseline ? "beats" : "noise"}</div></div>
          </div>
        )}
        {ic?.trial ? (
          <p className="muted text-xs">Logged trial #{ic.trial.id} · p_adj={fmt(ic.trial.pAdj, 4)}</p>
        ) : null}
      </Panel>

      <Panel title="Journal tearsheet" meta="Discrete-trade metrics from trade_journal">
        {!tearsheet || !tearsheet.n ? (
          <p className="muted text-sm">No closed journal PnL yet.</p>
        ) : (
          <div className="kpis axiom-kpis">
            <div className="kpi"><div className="label">Win rate</div><div className="val num">{tearsheet.winRate != null ? `${Math.round(tearsheet.winRate * 100)}%` : "—"}</div><div className="sub">{tearsheet.n} trades</div></div>
            <div className="kpi"><div className="label">Expectancy</div><div className="val num">{fmt(tearsheet.expectancy, 2)}</div><div className="sub">PF {fmt(tearsheet.profitFactor, 2)}</div></div>
            <div className="kpi"><div className="label">Payoff</div><div className="val num">{fmt(tearsheet.payoffRatio, 2)}</div><div className="sub">Kelly {fmt(tearsheet.kellyFraction, 2)}</div></div>
            <div className="kpi"><div className="label">Max DD</div><div className="val num">{fmt(tearsheet.maxDrawdown, 2)}</div><div className="sub">Sharpe {fmt(tearsheet.sharpe, 2)}</div></div>
          </div>
        )}
      </Panel>

      <Panel title="Research trial log" meta="Every IC run with recordTrial=1 — including failures">
        {!trials.length ? (
          <p className="muted text-sm">No trials recorded yet. Use “Run + log trial” above.</p>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Factor</th>
                  <th>Horizon</th>
                  <th>Metric</th>
                  <th>p_raw</th>
                  <th>p_adj</th>
                  <th>N</th>
                </tr>
              </thead>
              <tbody>
                {trials.slice(0, 25).map((t: any) => (
                  <tr key={t.id ?? `${t.trialKey}-${t.createdAtMs}`}>
                    <td className="muted text-xs">{t.createdAtMs ? new Date(t.createdAtMs).toLocaleString() : "—"}</td>
                    <td>{t.factor ?? "—"}</td>
                    <td>{t.horizon ?? "—"}</td>
                    <td className="num">{fmt(t.metricValue)}</td>
                    <td className="num">{fmt(t.pRaw, 4)}</td>
                    <td className="num">{fmt(t.pAdj, 4)}</td>
                    <td className="num">{t.nTrialsFamily ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
