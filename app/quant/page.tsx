"use client";

/**
 * /quant — Quant Lab terminal: lane-separated realized metrics + breakdowns.
 * Dark cc-term UI matching Command Center. Historical analysis, not financial advice.
 */

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { scanHeaders } from "@/hooks/useScanner";
import { decideQuantZeroState } from "@/lib/research/options/quant-zero-state";
import type { VerificationCensus } from "@/lib/research/options/quant-zero-state";

type Confidence = "LOW" | "MEDIUM" | "HIGH";

type Segment = {
  key: string;
  n: number;
  winRate: number | null;
  expectancy: number | null;
  avgReturn: number | null;
  medianReturn: number | null;
  profitFactor: number | null;
  mfe: number | null;
  mae: number | null;
};

type Metrics = {
  winRate: number | null;
  medianReturn: number | null;
  meanReturn: number | null;
  expectancy: number | null;
  profitFactor: number | null;
  mfe: number | null;
  mae: number | null;
  captureEfficiency: number | null;
  t1HitRate: number | null;
  t2HitRate: number | null;
  stopRate: number | null;
  detectionToDiscordLatencyMs: number | null;
  preMovePercentage: number | null;
  largeWinnersBlocked: number | null;
  severeLossesPrevented: number | null;
};

type Breakdowns = {
  strategyFamily: Segment[];
  symbol: Segment[];
  spyVsQqq: Segment[];
  callsVsPuts: Segment[];
  dte: Segment[];
  zeroDteOnly: Segment[];
  timeOfDay: Segment[];
  marketRegime: Segment[];
  contractMoneyness: Segment[];
  deltaBand: Segment[];
  exitPolicyVersion: Segment[];
  qualityScoreBand: Segment[];
};

type Report = {
  sampleSize: number;
  dataLane: string;
  timeWindow: string;
  resultKind: string;
  confidence: Confidence;
  completenessPct?: number;
  metrics: Metrics;
  breakdowns: Breakdowns;
  insufficientEvidence?: boolean;
  metadataCompleteness?: Record<string, number>;
};

type Snapshot = Report & {
  generatedAtMs: number;
  lanes: Record<string, Report>;
  verification?: VerificationCensus;
};

const LANE_OPTIONS: { key: string; label: string }[] = [
  { key: "delivered", label: "Delivered" },
  { key: "zero_dte_research", label: "0DTE Research" },
  { key: "shadow_would_send", label: "Shadow would-send" },
  { key: "blocked", label: "Shadow would-block" },
  { key: "all_paper", label: "All paper" },
];

const BREAKDOWN_META: { dim: keyof Breakdowns; title: string }[] = [
  { dim: "strategyFamily", title: "Strategy family" },
  { dim: "symbol", title: "Symbol" },
  { dim: "spyVsQqq", title: "SPY vs QQQ" },
  { dim: "callsVsPuts", title: "Calls vs puts" },
  { dim: "dte", title: "DTE" },
  { dim: "zeroDteOnly", title: "0DTE only" },
  { dim: "timeOfDay", title: "Time of day" },
  { dim: "marketRegime", title: "Market regime" },
  { dim: "contractMoneyness", title: "Moneyness" },
  { dim: "deltaBand", title: "Delta band" },
  { dim: "exitPolicyVersion", title: "Exit policy" },
  { dim: "qualityScoreBand", title: "Quality score band" },
];

function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v == null || Number.isNaN(v)) return "—";
  if (!Number.isFinite(v)) return "∞";
  return `${(v * (Math.abs(v) <= 1.5 ? 100 : 1)).toFixed(digits)}%`;
}

function fmtRet(v: number | null | undefined, digits = 1): string {
  if (v == null || Number.isNaN(v)) return "—";
  if (!Number.isFinite(v)) return "∞";
  return `${v.toFixed(digits)}%`;
}

function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v == null || Number.isNaN(v)) return "—";
  if (!Number.isFinite(v)) return "∞";
  return v.toFixed(digits);
}

function toneForSigned(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "muted";
  if (v > 0) return "ok";
  if (v < 0) return "bad";
  return "muted";
}

function toneForRate(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "muted";
  const pct = Math.abs(v) <= 1.5 ? v : v / 100;
  if (pct >= 0.55) return "ok";
  if (pct >= 0.4) return "warn";
  return "bad";
}

function confTone(c: Confidence | undefined): string {
  if (c === "HIGH") return "ok";
  if (c === "MEDIUM") return "warn";
  return "bad";
}

function Kpi({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className={`cc-term-kpi ${tone ?? "muted"}`}>
      <span className="cc-term-kpi-label">{label}</span>
      <span className="cc-term-kpi-value">{value}</span>
      {hint ? <span className="cc-term-kpi-hint">{hint}</span> : null}
    </div>
  );
}

type FindingClass = "SUPPORTED FINDING" | "EARLY SIGNAL" | "DATA QUALITY ISSUE" | "HYPOTHESIS";

function FindingLine({
  classification,
  children,
}: {
  classification: FindingClass;
  children: ReactNode;
}) {
  const tone = classification === "SUPPORTED FINDING"
    ? "ok"
    : classification === "DATA QUALITY ISSUE"
      ? "bad"
      : "warn";
  return (
    <p className="quant-finding-line">
      <span className={`cc-term-pill ${tone}`}>{classification}</span>
      <span>{children}</span>
    </p>
  );
}

function FormulaRow(props: {
  name: string;
  purpose: string;
  evidence: string;
  status: string;
  nextTest: string;
  definition: string;
  source: string;
  liveUsage: string;
  history: string;
  alternative: string;
  comparison: string;
  approval: string;
}) {
  return (
    <details className="quant-formula-row">
      <summary>
        <span><strong>{props.name}</strong><small>{props.purpose}</small></span>
        <span>{props.evidence}</span>
        <span className="cc-term-pill muted">{props.status}</span>
        <span>{props.nextTest}</span>
      </summary>
      <div className="quant-formula-detail">
        <div><strong>Exact definition</strong><span>{props.definition}</span></div>
        <div><strong>Source</strong><span>{props.source}</span></div>
        <div><strong>Current live usage</strong><span>{props.liveUsage}</span></div>
        <div><strong>Historical performance</strong><span>{props.history}</span></div>
        <div><strong>Proposed alternative</strong><span>{props.alternative}</span></div>
        <div><strong>Shadow comparison</strong><span>{props.comparison}</span></div>
        <div><strong>Approval state</strong><span>{props.approval}</span></div>
      </div>
    </details>
  );
}

function BreakdownSection({
  title,
  dim,
  rows,
  lane,
  activeKey,
}: {
  title: string;
  dim: string;
  rows: Segment[];
  lane: string;
  activeKey: string | null;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="cc-term-panel">
      <button type="button" className="cc-term-collapse" onClick={() => setOpen((o) => !o)}>
        {open ? "▾" : "▸"} {title}
        <span className="cc-term-pill muted" style={{ marginLeft: 8 }}>{rows.length} keys</span>
      </button>
      {open ? (
        <div className="cc-term-panel-body">
          {rows.length === 0 ? (
            <p className="cc-term-empty">No sample</p>
          ) : (
            <div className="quant-table-wrap">
            <table className="mini-table quant-advanced-table">
              <thead>
                <tr>
                  <th>Key</th>
                  <th title="Number of graded outcomes">N</th>
                  <th title="Percentage of graded outcomes above zero">Win %</th>
                  <th title="Mean realized option return">Expectancy</th>
                  <th title="Average realized option return">Average</th>
                  <th title="Middle realized return after sorting">Median</th>
                  <th title="Gross positive return divided by absolute gross negative return">Profit factor</th>
                  <th title="Maximum favorable excursion">MFE</th>
                  <th title="Maximum adverse excursion">MAE</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const href = `/quant?lane=${encodeURIComponent(lane)}&view=advanced&dim=${encodeURIComponent(dim)}&key=${encodeURIComponent(r.key)}`;
                  const active = activeKey === r.key;
                  return (
                    <tr key={r.key} style={active ? { outline: "1px solid rgba(52,211,153,0.45)" } : undefined}>
                      <td>
                        <Link href={href} className="cc-term-link">{r.key}</Link>
                      </td>
                      <td className="num">{r.n}</td>
                      <td className={`num ${toneForRate(r.winRate)}`}>{fmtPct(r.winRate)}</td>
                      <td className={`num ${toneForSigned(r.expectancy)}`}>{fmtRet(r.expectancy)}</td>
                      <td className={`num ${toneForSigned(r.avgReturn)}`}>{fmtRet(r.avgReturn)}</td>
                      <td className={`num ${toneForSigned(r.medianReturn)}`}>{fmtRet(r.medianReturn)}</td>
                      <td className="num">{fmtNum(r.profitFactor)}</td>
                      <td className={`num ${toneForSigned(r.mfe)}`}>{fmtRet(r.mfe)}</td>
                      <td className={`num ${toneForSigned(r.mae)}`}>{fmtRet(r.mae)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function QuantLabInner() {
  const search = useSearchParams();
  const router = useRouter();
  const laneParam = search.get("lane") ?? "delivered";
  const dimParam = search.get("dim");
  const keyParam = search.get("key");
  const advanced = search.get("view") === "advanced";

  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** False until the first fetch attempt finishes, however it finishes. */
  const [settled, setSettled] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/research/options/quant-lab", {
        cache: "no-store",
        headers: scanHeaders(),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        setError(json?.error ?? `HTTP ${res.status}`);
        setSnap(null);
        return;
      }
      setSnap(json.snapshot);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? "load failed");
    } finally {
      setRefreshing(false);
      setSettled(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  const report: Report | null = useMemo(() => {
    if (!snap) return null;
    return snap.lanes?.[laneParam] ?? snap;
  }, [snap, laneParam]);

  const filteredBreakdowns = useMemo(() => {
    if (!report) return null;
    if (!dimParam || !keyParam) return report.breakdowns;
    const next = { ...report.breakdowns };
    const dim = dimParam as keyof Breakdowns;
    if (next[dim]) {
      next[dim] = next[dim].filter((r) => r.key === keyParam);
    }
    return next;
  }, [report, dimParam, keyParam]);

  const setLane = (lane: string) => {
    const q = new URLSearchParams();
    q.set("lane", lane);
    router.replace(`/quant?${q.toString()}`);
  };

  const m = report?.metrics;
  const supportedStrategies = useMemo(
    () => (report?.breakdowns.strategyFamily ?? [])
      .filter((row) => row.n >= 5 && row.expectancy != null)
      .sort((a, b) => Number(b.expectancy) - Number(a.expectancy)),
    [report],
  );
  const supportedTimes = useMemo(
    () => (report?.breakdowns.timeOfDay ?? [])
      .filter((row) => row.n >= 5 && row.expectancy != null)
      .sort((a, b) => Number(b.expectancy) - Number(a.expectancy)),
    [report],
  );
  const completeness = report?.metadataCompleteness ?? {};
  const biggestGap = Object.entries(completeness).sort((a, b) => a[1] - b[1])[0] ?? null;
  const sampleSize = report?.sampleSize ?? 0;
  const conclusionReady = sampleSize >= 5;

  // Why there is nothing to show, when there is nothing to show. A failed load
  // must never render as `0` — see lib/research/options/quant-zero-state.ts.
  const zeroState = useMemo(
    () => decideQuantZeroState({
      loadError: error,
      report,
      verification: snap?.verification ?? null,
      lane: laneParam,
      pending: !settled,
    }),
    [error, report, snap, laneParam, settled],
  );
  const showMetrics = zeroState.metricsRenderable;
  const nLabel = zeroState.sampleSizeKnown ? String(sampleSize) : "Unknown";
  const positiveFindings = supportedStrategies.filter((row) => Number(row.expectancy) > 0);
  const negativeFindings = supportedStrategies.filter((row) => Number(row.expectancy) < 0);
  const earlyCaptureSignal = m?.captureEfficiency != null && m.captureEfficiency < 0.5;
  const earlyStopSignal = m?.stopRate != null && m.stopRate > 0.4;
  const refreshLabel = snap?.generatedAtMs
    ? new Date(snap.generatedAtMs).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";

  return (
    <div className="ui-page cc-term">
      <div className="cc-term-strip">
        <div className="cc-term-strip-chips">
          {LANE_OPTIONS.map((o) => (
            <button
              key={o.key}
              type="button"
              className={`cc-term-chip ${laneParam === o.key ? "ok" : "muted"}`}
              onClick={() => setLane(o.key)}
              style={{ cursor: "pointer", border: "none", background: "transparent" }}
            >
              <span className="cc-term-chip-label">Lane</span>
              <span className="cc-term-chip-state">{o.label}</span>
            </button>
          ))}
        </div>
        <div className="cc-term-strip-meta">
          <span>Quant Lab</span>
          <span>Refreshed {refreshLabel}</span>
          <button type="button" className="cc-term-refresh" disabled={refreshing} onClick={() => void load()}>
            {refreshing ? "…" : "Refresh"}
          </button>
        </div>
      </div>

      {error ? (
        <div className="cc-term-banner bad">
          Token required — set your scan token in Settings. ({error})
        </div>
      ) : null}

      <section className="cc-term-panel">
        <header className="cc-term-panel-head">
          <span className="cc-term-panel-title">Summary</span>
          <div className="cc-term-panel-right">
            <span className={`cc-term-pill ${confTone(report?.confidence)}`}>
              {showMetrics ? `${report?.confidence ?? "LOW"} confidence` : zeroState.kind.replace(/_/g, " ").toLowerCase()}
            </span>
            <span className="cc-term-pill muted">n={nLabel}</span>
          </div>
        </header>
        <div className="cc-term-panel-body">
          {showMetrics ? (
            <div className="quant-summary-grid">
              <Kpi label="Evidence quality" value={report?.insufficientEvidence ? "Insufficient" : report?.confidence ?? "LOW"} tone={confTone(report?.confidence)} />
              <Kpi label="Sample size" value={String(sampleSize)} hint="verified closed outcomes" tone="info" />
              <Kpi label="Win rate" value={fmtPct(m?.winRate)} hint={conclusionReady ? "supported sample" : `Low confidence · n=${sampleSize}`} tone={conclusionReady ? toneForRate(m?.winRate) : "muted"} />
              <Kpi label="Average return" value={fmtRet(m?.meanReturn)} hint={conclusionReady ? "realized option return" : `Low confidence · n=${sampleSize}`} tone={conclusionReady ? toneForSigned(m?.meanReturn) : "muted"} />
              <Kpi label="Profit factor" value={fmtNum(m?.profitFactor)} hint={conclusionReady ? "gross gains ÷ gross losses" : "Not conclusive"} />
              <Kpi label="Best supported setup" value={supportedStrategies[0]?.key ?? "No setup reaches n≥5"} />
              <Kpi label="Worst supported setup" value={supportedStrategies.at(-1)?.key ?? "No setup reaches n≥5"} />
              <Kpi label="Best time window" value={supportedTimes[0]?.key ?? "No window reaches n≥5"} />
              <Kpi label="Biggest data gap" value={biggestGap ? `${biggestGap[0]} ${biggestGap[1].toFixed(0)}%` : "Unavailable"} tone="warn" />
            </div>
          ) : (
            /* No metrics were read. Showing 0 here would assert a measurement
             * that never happened — the 2026-08-03 defect. */
            <div className={`cc-term-banner ${zeroState.kind === "LOAD_FAILED" ? "bad" : "warn"}`}>
              <strong>{zeroState.headline}</strong>
              <div>{zeroState.detail}</div>
            </div>
          )}
          <p className="cc-term-disclaimer">Deterministic research only. Nothing on this page changes production rules automatically.</p>
        </div>
      </section>

      {snap?.verification && laneParam === "delivered" ? (
        <section className="cc-term-panel">
          <header className="cc-term-panel-head">
            <span className="cc-term-panel-title">Evidence census — why the official sample is smaller than the lane</span>
            <div className="cc-term-panel-right">
              <span className={`cc-term-pill ${snap.verification.quotable ? "ok" : "muted"}`}>
                {snap.verification.quotable ? "quotable" : "not quotable"}
              </span>
            </div>
          </header>
          <div className="cc-term-panel-body">
            <div className="quant-summary-grid">
              <Kpi label="Delivered closed records" value={String(snap.verification.deliveredTotal)} hint="every EXITED delivered paper trade" tone="info" />
              <Kpi label="Counted in official metrics" value={String(snap.verification.deliveredVerified)} hint={snap.verification.officialStatus} tone="ok" />
              <Kpi label="Excluded" value={String(snap.verification.deliveredExcluded)} hint="kept, never deleted, never blended" tone="warn" />
              <Kpi
                label="Verified fraction"
                value={snap.verification.verifiedFraction != null ? `${(snap.verification.verifiedFraction * 100).toFixed(1)}%` : "Unknown"}
                tone="muted"
              />
            </div>
            {zeroState.exclusions.length ? (
              <div className="quant-table-wrap">
                <table className="mini-table">
                  <thead>
                    <tr><th>Exclusion reason</th><th>Records</th><th>Share of excluded</th></tr>
                  </thead>
                  <tbody>
                    {zeroState.exclusions.map((x) => (
                      <tr key={x.reason}>
                        <td>{x.reason}</td>
                        <td>{x.n}</td>
                        <td>{snap.verification!.deliveredExcluded ? `${((x.n / snap.verification!.deliveredExcluded) * 100).toFixed(1)}%` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {snap.verification.quotableBlockers?.length ? (
              <p className="cc-term-disclaimer">
                Blocking quotability: {snap.verification.quotableBlockers.join(" · ")}
              </p>
            ) : null}
            <p className="cc-term-disclaimer">{snap.verification.note}</p>
          </div>
        </section>
      ) : null}

      <div className="term-quant-viz-grid">
        <section className="cc-term-panel">
          <header className="cc-term-panel-head"><span className="cc-term-panel-title">What is working</span></header>
          <div className="cc-term-panel-body">
            {positiveFindings.slice(0, 4).map((row) => (
              <FindingLine key={row.key} classification="SUPPORTED FINDING">
                <strong>{row.key}</strong> · n={row.n} · expectancy {fmtRet(row.expectancy)} · {report?.confidence} confidence
              </FindingLine>
            ))}
            {positiveFindings.length === 0 ? <p className="cc-term-empty">No supported positive finding yet. At least 5 graded outcomes are required.</p> : null}
          </div>
        </section>
        <section className="cc-term-panel">
          <header className="cc-term-panel-head"><span className="cc-term-panel-title">What is failing</span></header>
          <div className="cc-term-panel-body">
            {negativeFindings.slice(0, 4).map((row) => (
              <FindingLine key={row.key} classification="SUPPORTED FINDING">
                <strong>{row.key}</strong> · n={row.n} · expectancy {fmtRet(row.expectancy)} · investigate entry or exit policy
              </FindingLine>
            ))}
            {earlyStopSignal ? (
              <FindingLine classification={conclusionReady ? "SUPPORTED FINDING" : "EARLY SIGNAL"}>
                Stop rate may be elevated · n={sampleSize} · compare entry timing and stop placement in shadow.
              </FindingLine>
            ) : null}
            {earlyCaptureSignal ? (
              <FindingLine classification={conclusionReady ? "SUPPORTED FINDING" : "EARLY SIGNAL"}>
                Winner capture may be weak · n={sampleSize} · compare exit policies before changing entries.
              </FindingLine>
            ) : null}
            {biggestGap && biggestGap[1] < 50 ? (
              <FindingLine classification="DATA QUALITY ISSUE">
                {biggestGap[0]} metadata is only {biggestGap[1].toFixed(0)}% complete, so related conclusions are blocked.
              </FindingLine>
            ) : null}
            {negativeFindings.length === 0 && !earlyStopSignal && !earlyCaptureSignal && !(biggestGap && biggestGap[1] < 50) ? (
              <p className="cc-term-empty">No supported failing finding yet.</p>
            ) : null}
          </div>
        </section>
      </div>

      <section className="cc-term-panel">
        <header className="cc-term-panel-head">
          <span className="cc-term-panel-title">What to test next</span>
          <span className="cc-term-pill muted">SHADOW ONLY</span>
        </header>
        <div className="cc-term-panel-body">
          <div className="quant-table-wrap">
            <table className="mini-table quant-test-table">
              <thead><tr><th>Hypothesis</th><th>Evidence</th><th>Proposed shadow test</th><th>Success metric</th><th>Required sample</th><th>Status</th></tr></thead>
              <tbody>
                <tr><td>Entry timing may improve expectancy</td><td>Current lane · n={sampleSize}</td><td>Compare the current entry window with the adjacent ET window</td><td>Higher out-of-sample expectancy</td><td>30 per arm</td><td>HYPOTHESIS</td></tr>
                <tr><td>Wide spreads may reduce realized capture</td><td>Capture efficiency {fmtPct(m?.captureEfficiency)}</td><td>Compare the live spread rule with a tighter shadow filter</td><td>Higher realized-to-MFE ratio</td><td>30 per arm</td><td>{earlyCaptureSignal ? "EARLY SIGNAL" : "HYPOTHESIS"}</td></tr>
                <tr><td>Exit policy may explain weak capture</td><td>MFE {fmtRet(m?.mfe)} · mean {fmtRet(m?.meanReturn)}</td><td>Compare fixed target, runner, and time-exit policies</td><td>Higher profit factor without larger drawdown</td><td>30 per policy</td><td>{earlyCaptureSignal ? "EARLY SIGNAL" : "HYPOTHESIS"}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="cc-term-panel">
        <header className="cc-term-panel-head"><span className="cc-term-panel-title">Formula Lab</span></header>
        <div className="cc-term-panel-body">
          <div className="quant-formula-head">
            <span>Formula and purpose</span><span>Current evidence</span><span>Status</span><span>Next safe test</span>
          </div>
          <FormulaRow
            name="Expectancy"
            purpose="Lane performance"
            evidence={fmtRet(m?.expectancy)}
            status={conclusionReady ? "SUPPORTED" : "EARLY"}
            nextTest="Accumulate 30 outcomes per arm"
            definition="Arithmetic mean of realized option-return percentages in the selected lane."
            source="lib/research/options/quant-lab.ts · metricsFromRows"
            liveUsage="Reporting only. It does not alter scanner or delivery behavior."
            history={`Selected lane contains ${sampleSize} graded outcomes.`}
            alternative="No challenger is proposed until the evidence threshold is met."
            comparison="A future challenger must run in shadow against the same linked cohort."
            approval="Human review required. Nothing applies automatically."
          />
          <FormulaRow
            name="Profit factor"
            purpose="Outcome quality"
            evidence={fmtNum(m?.profitFactor)}
            status={conclusionReady ? "SUPPORTED" : "EARLY"}
            nextTest="Keep the canonical formula"
            definition="Gross positive realized return divided by the absolute gross negative realized return."
            source="lib/research/options/quant-lab.ts · profitFactor"
            liveUsage="Reporting only. It does not size or authorize trades."
            history={`Current canonical value: ${fmtNum(m?.profitFactor)}.`}
            alternative="None."
            comparison="Required before any alternate risk metric could be reviewed."
            approval="Human review required."
          />
          <FormulaRow
            name="Capture efficiency"
            purpose="Exit quality"
            evidence={fmtPct(m?.captureEfficiency)}
            status={earlyCaptureSignal ? "EARLY SIGNAL" : "HYPOTHESIS"}
            nextTest="Shadow three exit policies"
            definition="Realized option return divided by maximum favorable excursion for rows with positive MFE."
            source="lib/research/options/quant-lab.ts · metricsFromRows"
            liveUsage="Research only. Existing exits remain deterministic and unchanged."
            history={`MFE ${fmtRet(m?.mfe)} · realized mean ${fmtRet(m?.meanReturn)}.`}
            alternative="Compare fixed target, runner, and time-exit policies."
            comparison="Pending sufficient matched outcomes."
            approval="Not approved."
          />
        </div>
      </section>

      <div className="term-quant-viz-grid">
        <section className="cc-term-panel">
          <header className="cc-term-panel-head"><span className="cc-term-panel-title">Winner discovery</span></header>
          <div className="cc-term-panel-body">
            <p>Delivered winners: {(report?.breakdowns.strategyFamily ?? []).filter((row) => row.n >= 5 && Number(row.expectancy) > 0).length} supported patterns</p>
            <p>Blocked winners: {m?.largeWinnersBlocked ?? "Unavailable"}</p>
            <p>High MFE with weak realized return: {m?.mfe != null && m?.meanReturn != null && m.mfe > m.meanReturn * 2 ? "Present" : "Not established"}</p>
            <p className="muted">These are correlations. They do not establish causation or authorize a rule change.</p>
          </div>
        </section>
        <section className="cc-term-panel">
          <header className="cc-term-panel-head"><span className="cc-term-panel-title">Data completeness</span></header>
          <div className="cc-term-panel-body">
            <p><strong>Overall: {report?.completenessPct?.toFixed(1) ?? "0.0"}%</strong></p>
            {Object.entries(completeness).map(([key, value]) => (
              <p key={key}>{key}: {value.toFixed(1)}% {value < 50 ? "· conclusions blocked" : ""}</p>
            ))}
          </div>
        </section>
      </div>

      <p className="cc-term-footnote">
        <Link href={advanced ? `/quant?lane=${encodeURIComponent(laneParam)}` : `/quant?lane=${encodeURIComponent(laneParam)}&view=advanced`} className="cc-term-link">
          {advanced ? "Hide advanced data" : "Open advanced data"}
        </Link>
      </p>

      {advanced ? (
        <>
          {dimParam && keyParam ? (
            <div className="cc-term-banner info">
              Filter: {dimParam} = {keyParam} · <Link href={`/quant?lane=${encodeURIComponent(laneParam)}&view=advanced`} className="cc-term-link">Clear</Link>
            </div>
          ) : null}
          {filteredBreakdowns
            ? BREAKDOWN_META.map(({ dim, title }) => (
                <BreakdownSection
                  key={dim}
                  title={title}
                  dim={dim}
                  rows={filteredBreakdowns[dim] ?? []}
                  lane={laneParam}
                  activeKey={dimParam === dim ? keyParam : null}
                />
              ))
            : <p className="cc-term-empty">Loading advanced Quant data…</p>}
        </>
      ) : null}
    </div>
  );
}

export default function QuantPage() {
  return (
    <Suspense fallback={<div className="ui-page cc-term"><p className="cc-term-empty">Loading…</p></div>}>
      <QuantLabInner />
    </Suspense>
  );
}
