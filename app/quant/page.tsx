"use client";

/**
 * /quant — Quant Lab terminal: lane-separated realized metrics + breakdowns.
 * Dark cc-term UI matching Command Center. Historical analysis, not financial advice.
 */

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { scanHeaders } from "@/hooks/useScanner";
import { TermHBar, TermPanel } from "@/components/terminal/TermViz";

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
};

type Snapshot = Report & {
  generatedAtMs: number;
  lanes: Record<string, Report>;
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

function fmtMs(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v >= 1000) return `${(v / 1000).toFixed(1)}s`;
  return `${Math.round(v)}ms`;
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
            <table className="mini-table" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th>Key</th>
                  <th>n</th>
                  <th>Win%</th>
                  <th>Expect</th>
                  <th>Avg</th>
                  <th>Med</th>
                  <th>PF</th>
                  <th>MFE</th>
                  <th>MAE</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const href = `/quant?lane=${encodeURIComponent(lane)}&dim=${encodeURIComponent(dim)}&key=${encodeURIComponent(r.key)}`;
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

  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
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
          <span className="cc-term-panel-title">Core metrics</span>
          <div className="cc-term-panel-right">
            <span className={`cc-term-pill ${confTone(report?.confidence)}`}>
              {report?.confidence ?? "LOW"}
            </span>
            <span className="cc-term-pill muted">n={report?.sampleSize ?? 0}</span>
            <span className="cc-term-pill muted">{report?.dataLane ?? laneParam}</span>
            <span className="cc-term-pill muted">{report?.timeWindow ?? "all_exited"}</span>
            <span className="cc-term-pill muted">{report?.resultKind ?? "realized"}</span>
          </div>
        </header>
        <div className="cc-term-panel-body">
          <div className="cc-term-kpi-scroll">
            <Kpi label="Sample" value={String(report?.sampleSize ?? 0)} hint="exited" tone="info" />
            <Kpi label="Win rate" value={fmtPct(m?.winRate)} tone={toneForRate(m?.winRate)} />
            <Kpi label="Median ret" value={fmtRet(m?.medianReturn)} tone={toneForSigned(m?.medianReturn)} />
            <Kpi label="Mean ret" value={fmtRet(m?.meanReturn)} tone={toneForSigned(m?.meanReturn)} />
            <Kpi label="Expectancy" value={fmtRet(m?.expectancy)} tone={toneForSigned(m?.expectancy)} />
            <Kpi label="Profit factor" value={fmtNum(m?.profitFactor)} tone={toneForSigned(m?.profitFactor != null && m.profitFactor >= 1 ? 1 : -1)} />
            <Kpi label="MFE" value={fmtRet(m?.mfe)} tone={toneForSigned(m?.mfe)} />
            <Kpi label="MAE" value={fmtRet(m?.mae)} tone={toneForSigned(m?.mae != null ? -Math.abs(m.mae) : null)} />
            <Kpi label="Capture" value={fmtPct(m?.captureEfficiency)} hint="realized/MFE" tone={toneForRate(m?.captureEfficiency)} />
            <Kpi label="T1 hit" value={fmtPct(m?.t1HitRate)} tone={toneForRate(m?.t1HitRate)} />
            <Kpi label="T2 hit" value={fmtPct(m?.t2HitRate)} tone={toneForRate(m?.t2HitRate)} />
            <Kpi label="Stop rate" value={fmtPct(m?.stopRate)} tone={m?.stopRate != null && m.stopRate > 0.4 ? "bad" : "muted"} />
            <Kpi label="Detect→Discord" value={fmtMs(m?.detectionToDiscordLatencyMs)} hint="avg latency" />
            <Kpi label="Pre-move" value={fmtRet(m?.preMovePercentage)} hint="if available" />
            <Kpi label="Winners blocked" value={m?.largeWinnersBlocked != null ? String(m.largeWinnersBlocked) : "—"} hint="shadow soak" tone="warn" />
            <Kpi label="Losses prevented" value={m?.severeLossesPrevented != null ? String(m.severeLossesPrevented) : "—"} hint="shadow soak" tone="ok" />
          </div>
          <p className="cc-term-disclaimer">
            Historical / statistical analysis — not financial advice. Sample size gates confidence.
            {" "}
            <Link href="/ai" className="cc-term-link">AI Advisory interprets these metrics →</Link>
          </p>
        </div>
      </section>

      {/* Visual analytics layer */}
      {report ? (
        <div className="term-quant-viz-grid">
          <TermPanel
            title="Expectancy by strategy"
            badge={<span className="cc-term-pill muted">n={report.sampleSize} · {report.dataLane} · {report.confidence}</span>}
          >
            <TermHBar
              rows={(report.breakdowns.strategyFamily ?? []).slice(0, 8).map((r) => ({
                key: r.key,
                label: r.key,
                value: Number(r.expectancy ?? 0),
                tone: (r.expectancy ?? 0) >= 0 ? "ok" : "bad",
              }))}
              hrefFor={(k) => `/quant?lane=${encodeURIComponent(laneParam)}&dim=strategyFamily&key=${encodeURIComponent(k)}`}
            />
          </TermPanel>
          <TermPanel title="Win rate by time of day" badge={<span className="cc-term-pill muted">realized · {report.timeWindow}</span>}>
            <div className="cc-term-chart">
              <ResponsiveContainer width="100%" height={140}>
                <BarChart data={(report.breakdowns.timeOfDay ?? []).map((r) => ({
                  key: r.key,
                  wr: r.winRate == null ? 0 : (Math.abs(r.winRate) <= 1.5 ? r.winRate * 100 : r.winRate),
                  n: r.n,
                }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(80,120,100,0.12)" />
                  <XAxis dataKey="key" tick={{ fontSize: 9, fill: "#6b7a72" }} />
                  <YAxis tick={{ fontSize: 9, fill: "#6b7a72" }} width={28} />
                  <Tooltip contentStyle={{ background: "#0a0c0b", border: "1px solid rgba(80,200,120,0.25)", fontSize: 11 }} />
                  <Bar dataKey="wr" fill="#34d399" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </TermPanel>
          <TermPanel title="SPY vs QQQ" badge={<span className="cc-term-pill muted">expectancy</span>}>
            <TermHBar
              rows={(report.breakdowns.spyVsQqq ?? []).map((r) => ({
                key: r.key,
                label: `${r.key} (n=${r.n})`,
                value: Number(r.expectancy ?? 0),
              }))}
            />
          </TermPanel>
          <TermPanel title="Calls vs puts">
            <TermHBar
              rows={(report.breakdowns.callsVsPuts ?? []).map((r) => ({
                key: r.key,
                label: `${r.key} (n=${r.n})`,
                value: Number(r.expectancy ?? 0),
              }))}
            />
          </TermPanel>
          <TermPanel title="Moneyness ATM/ITM/OTM">
            <TermHBar
              rows={(report.breakdowns.contractMoneyness ?? []).map((r) => ({
                key: r.key,
                label: `${r.key} (n=${r.n})`,
                value: Number(r.expectancy ?? 0),
              }))}
            />
          </TermPanel>
          <TermPanel title="DTE performance">
            <TermHBar
              rows={(report.breakdowns.dte ?? []).slice(0, 8).map((r) => ({
                key: r.key,
                label: `${r.key} (n=${r.n})`,
                value: Number(r.expectancy ?? 0),
              }))}
            />
          </TermPanel>
          <TermPanel title="Delta-band performance">
            <TermHBar
              rows={(report.breakdowns.deltaBand ?? []).map((r) => ({
                key: r.key,
                label: `${r.key} (n=${r.n})`,
                value: Number(r.expectancy ?? 0),
              }))}
            />
          </TermPanel>
          <TermPanel title="Exit-policy performance">
            <TermHBar
              rows={(report.breakdowns.exitPolicyVersion ?? []).map((r) => ({
                key: r.key,
                label: `${r.key} (n=${r.n})`,
                value: Number(r.expectancy ?? 0),
              }))}
            />
          </TermPanel>
          <TermPanel title="MFE vs MAE (by family)" badge={<span className="cc-term-pill muted">scatter</span>}>
            <div className="cc-term-chart">
              <ResponsiveContainer width="100%" height={140}>
                <ScatterChart>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(80,120,100,0.12)" />
                  <XAxis type="number" dataKey="mfe" name="MFE" tick={{ fontSize: 9, fill: "#6b7a72" }} />
                  <YAxis type="number" dataKey="mae" name="MAE" tick={{ fontSize: 9, fill: "#6b7a72" }} width={32} />
                  <Tooltip cursor={{ strokeDasharray: "3 3" }} contentStyle={{ background: "#0a0c0b", border: "1px solid rgba(80,200,120,0.25)", fontSize: 11 }} />
                  <Scatter
                    data={(report.breakdowns.strategyFamily ?? []).map((r) => ({
                      mfe: Number(r.mfe ?? 0),
                      mae: Number(r.mae ?? 0),
                      n: r.n,
                      key: r.key,
                    }))}
                    fill="#34d399"
                  />
                </ScatterChart>
              </ResponsiveContainer>
            </div>
          </TermPanel>
          <TermPanel title="Allowed vs blocked / soak" badge={<span className="cc-term-pill muted">shadow</span>}>
            <div className="cc-term-grid-2">
              <Kpi label="Winners blocked" value={m?.largeWinnersBlocked != null ? String(m.largeWinnersBlocked) : "—"} tone="warn" />
              <Kpi label="Losses prevented" value={m?.severeLossesPrevented != null ? String(m.severeLossesPrevented) : "—"} tone="ok" />
              <Kpi label="Capture eff." value={fmtPct(m?.captureEfficiency)} />
              <Kpi label="Confidence" value={String(report.confidence)} tone={confTone(report.confidence)} />
            </div>
          </TermPanel>
        </div>
      ) : null}

      <p className="cc-term-footnote">Exact tables below — charts summarize the same SQLite lane metrics.</p>

      {dimParam && keyParam ? (
        <div className="cc-term-banner info" style={{ borderColor: "rgba(52,211,153,0.35)" }}>
          Filter: {dimParam} = {keyParam}
          {" · "}
          <Link href={`/quant?lane=${encodeURIComponent(laneParam)}`} className="cc-term-link">Clear</Link>
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
        : (
          <p className="cc-term-empty">Loading Quant Lab…</p>
        )}
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
