"use client";

import { useCallback, useEffect, useState } from "react";
import {
  PageContainer, ResponsiveGrid, Card, KeyValue, StatusBadge, LoadingState, ErrorState, EmptyState, DetailsDisclosure,
} from "@/components/ui/Shell";
import { SimpleTable, type Column } from "@/components/ui/Table";
import { scanHeaders } from "@/hooks/useScanner";

type Overview = {
  flags?: Record<string, any>;
  schedule?: Record<string, any>;
  runs?: Record<string, any>;
  cost?: {
    spendUsd: number;
    softLimitUsd: number;
    hardLimitUsd: number;
    atSoftLimit: boolean;
    atHardLimit: boolean;
    monthKey: string;
    inputTokens?: number;
    outputTokens?: number;
  };
  latestNightly?: any;
  nightlyHistory?: any[];
  weeklyHistory?: any[];
  lessons?: any[];
  proposals?: { pending: any[]; accepted: any[]; rejected: any[] };
  jobFailures?: any[];
  quantDashboard?: any;
  evidenceLearning?: any;
};

const RETRYABLE_NIGHTLY_STATUSES = new Set(["VALIDATION_FAILED", "ERROR", "SKIPPED"]);

const dash = "-";
const fmtTime = (ms?: number | null) =>
  ms ? new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) + " ET" : dash;
const fmtNum = (n?: number | null) => (typeof n === "number" ? n.toLocaleString() : dash);
const fmtMetric = (v: any, unit?: string) => {
  if (v == null || v === "") return "n/a";
  if (typeof v === "number") return `${Number.isInteger(v) ? v.toLocaleString() : v.toFixed(1)}${unit ? ` ${unit}` : ""}`;
  return String(v);
};
const fmtTrend = (t: any) => t?.value == null ? (t?.label ?? "n/a") : `${t.value >= 0 ? "+" : ""}${t.value}`;
const fmtMs = (ms?: number | null) => typeof ms === "number" ? `${Math.round(ms / 1000)}s` : "n/a";

const fmtDiag = (v: any) => {
  if (v == null || v === "") return "n/a";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
};

function toneForScore(score: any): "bull" | "warn" | "bear" | "muted" {
  return typeof score === "number" ? score >= 80 ? "bull" : score >= 60 ? "warn" : "bear" : "muted";
}

function ValidationDetails({ diagnostic, summary }: { diagnostic: any; summary: string }) {
  if (!diagnostic) return null;
  const violations = Array.isArray(diagnostic.schemaViolations) ? diagnostic.schemaViolations : [];
  return (
    <DetailsDisclosure summary={summary}>
      <ResponsiveGrid min={180}>
        <KeyValue k="Stage" v={diagnostic.validationStage ?? "n/a"} />
        <KeyValue k="Validator" v={diagnostic.validatorName ?? "n/a"} />
        <KeyValue k="Field" v={diagnostic.failingField ?? "n/a"} />
        <KeyValue k="Expected" v={diagnostic.expectedValue ?? "n/a"} />
        <KeyValue k="Received" v={fmtDiag(diagnostic.receivedValue)} />
        <KeyValue k="Response length" v={diagnostic.aiResponseLength ?? "n/a"} />
        <KeyValue k="Retries" v={diagnostic.retryCount ?? diagnostic.attempts ?? "n/a"} />
        <KeyValue k="Model" v={diagnostic.providerModel ?? diagnostic.model ?? "n/a"} />
        <KeyValue k="Prompt" v={diagnostic.promptVersion ?? "n/a"} />
        <KeyValue k="Response type" v={diagnostic.responseType ?? "n/a"} />
        <KeyValue k="Attempts" v={diagnostic.attempts ?? "n/a"} />
        <KeyValue k="Stopped early" v={diagnostic.stoppedEarly ? "yes" : "no"} tone={diagnostic.stoppedEarly ? "warn" : "muted"} />
      </ResponsiveGrid>
      {diagnostic.parserOutput && (
        <div style={{ marginTop: 8 }}>
          <p style={{ fontSize: 12, opacity: 0.7, margin: "4px 0" }}>Parser output</p>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 11, margin: 0 }}>{fmtDiag(diagnostic.parserOutput)}</pre>
        </div>
      )}
      {violations.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <p style={{ fontSize: 12, opacity: 0.7, margin: "4px 0" }}>Schema violations</p>
          {violations.map((v: any, i: number) => <pre key={i} style={{ whiteSpace: "pre-wrap", fontSize: 11, margin: "2px 0" }}>{fmtDiag(v)}</pre>)}
        </div>
      )}
      {Array.isArray(diagnostic.validationErrors) && diagnostic.validationErrors.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {diagnostic.validationErrors.map((s: string, i: number) => <p key={i} style={{ fontSize: 12, margin: "2px 0" }}>{s}</p>)}
        </div>
      )}
      {diagnostic.parseError && <p style={{ fontSize: 12, margin: "6px 0 0" }}>{diagnostic.parseError}</p>}
    </DetailsDisclosure>
  );
}

function ProgressBar({ value }: { value: number | null | undefined }) {
  const pct = typeof value === "number" ? Math.max(0, Math.min(100, value)) : 0;
  return (
    <div style={{ height: 6, background: "rgba(148,163,184,.18)", borderRadius: 999, overflow: "hidden" }}>
      <div style={{ width: `${pct}%`, height: "100%", background: pct >= 80 ? "var(--bull)" : pct >= 60 ? "var(--warn)" : "var(--bear)" }} />
    </div>
  );
}

function MetricTiles({ items }: { items: any[] }) {
  return (
    <ResponsiveGrid min={170}>
      {items.map((m, i) => (
        <div key={`${m.label}-${i}`} style={{ border: "1px solid rgba(148,163,184,.22)", borderRadius: 8, padding: 10, display: "grid", gap: 7 }}>
          <div style={{ fontSize: 11, opacity: 0.7 }}>{m.label}</div>
          <div style={{ fontSize: 20, fontWeight: 800 }}>{fmtMetric(m.value, m.unit)}</div>
          {m.score != null && <ProgressBar value={m.score} />}
          <div style={{ fontSize: 10, opacity: 0.55 }}>{m.source}</div>
        </div>
      ))}
    </ResponsiveGrid>
  );
}

function Sparkline({ points }: { points: any[] }) {
  const vals = (points ?? []).map((p) => typeof p.value === "number" ? p.value : null).filter((v): v is number => v != null);
  if (!vals.length) return <span style={{ fontSize: 12, opacity: 0.6 }}>not enough data</span>;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  return (
    <div style={{ display: "flex", alignItems: "end", gap: 3, height: 44 }}>
      {(points ?? []).map((p, i) => {
        const v = typeof p.value === "number" ? p.value : null;
        const h = v == null ? 4 : 8 + ((v - min) / span) * 34;
        return <div key={`${p.periodKey}-${i}`} title={`${p.periodKey}: ${v ?? "n/a"}`} style={{ width: 10, height: h, borderRadius: 3, background: v == null ? "rgba(148,163,184,.25)" : "var(--accent)" }} />;
      })}
    </div>
  );
}

function BarRows({ rows }: { rows: any[] }) {
  const max = Math.max(1, ...rows.map((r) => Number(r.value ?? r.count ?? 0)));
  return (
    <div style={{ display: "grid", gap: 7 }}>
      {rows.slice(0, 10).map((r, i) => {
        const v = Number(r.value ?? r.count ?? 0);
        return (
          <div key={`${r.periodKey ?? r.gate}-${i}`} style={{ display: "grid", gridTemplateColumns: "120px 1fr 44px", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.periodKey ?? r.gate}</span>
            <div style={{ height: 8, background: "rgba(148,163,184,.18)", borderRadius: 999, overflow: "hidden" }}>
              <div style={{ width: `${(v / max) * 100}%`, height: "100%", background: "var(--accent)" }} />
            </div>
            <span style={{ fontSize: 12, textAlign: "right" }}>{v}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function AiLabPage() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retryingKey, setRetryingKey] = useState<string | null>(null);
  const [retryMessage, setRetryMessage] = useState<{ key: string; text: string; ok: boolean } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/ai", { cache: "no-store", headers: scanHeaders() });
      if (res.status === 401) { setError("Not authorized - AI Lab is private. Provide the scan API token."); setOv(null); return; }
      const r = await res.json();
      setOv(r?.overview ?? {});
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? "Could not load AI overview.");
    } finally { setLoading(false); }
  }, []);

  const decide = useCallback(async (action: string, id: number, status: string) => {
    setBusy(true);
    try {
      await fetch("/api/ai", { method: "POST", headers: { ...scanHeaders(), "content-type": "application/json" }, body: JSON.stringify({ action, id, status }) });
      await load();
    } finally { setBusy(false); }
  }, [load]);

  const retryNightly = useCallback(async (report: any) => {
    const hasReportId = Number.isFinite(Number(report?.id));
    const key = hasReportId ? `id:${Number(report.id)}` : `period:${String(report?.periodKey ?? "")}`;
    const body = hasReportId
      ? { action: "retry_nightly_narrative", reportId: Number(report.id) }
      : { action: "retry_nightly_narrative", periodKey: String(report?.periodKey ?? "") };
    setRetryingKey(key);
    setRetryMessage(null);
    try {
      const res = await fetch("/api/ai", { method: "POST", headers: { ...scanHeaders(), "content-type": "application/json" }, body: JSON.stringify(body) });
      const raw = await res.text();
      let payload: any = null;
      try { payload = raw ? JSON.parse(raw) : null; } catch { payload = null; }
      if (!res.ok || payload?.ok === false) {
        const detail = payload?.error ?? (raw || `HTTP ${res.status}`);
        setRetryMessage({ key, text: String(detail), ok: false });
        return;
      }
      setRetryMessage({ key, text: "Retry started successfully.", ok: true });
      await load();
    } finally { setRetryingKey(null); }
  }, [load]);

  useEffect(() => { load(); const id = setInterval(load, 60000); return () => clearInterval(id); }, [load]);

  if (error && !ov) return <PageContainer><ErrorState title="AI Lab unavailable" detail={error} onRetry={load} /></PageContainer>;
  if (loading && !ov) return <PageContainer><Card title="Loading AI Lab"><LoadingState rows={5} /></Card></PageContainer>;

  const flags = ov?.flags ?? {};
  const schedule = ov?.schedule ?? {};
  const runs = ov?.runs ?? {};
  const cost = ov?.cost;
  const nightly = ov?.latestNightly;
  const narrative = nightly?.narrative;
  const diagnostic = nightly?.diagnostic;
  const pending = ov?.proposals?.pending ?? [];
  const accepted = ov?.proposals?.accepted ?? [];
  const rejected = ov?.proposals?.rejected ?? [];
  const lessons = ov?.lessons ?? [];
  const failures = ov?.jobFailures ?? [];
  const nightlyHistory = ov?.nightlyHistory ?? [];
  const weeklyHistory = ov?.weeklyHistory ?? [];
  const latestWeekly = weeklyHistory[0] ?? null;
  const quant = ov?.quantDashboard;
  const evidenceLearning = ov?.evidenceLearning;
  const disabled = !flags.enabled;

  const proposalCols: Column<any>[] = [
    { key: "title", header: "Proposal", render: (p) => p.title },
    { key: "strat", header: "Strategy", render: (p) => p.affectedStrategy ?? dash },
    { key: "conf", header: "Confidence", render: (p) => <StatusBadge tone={p.confidence === "HIGH" ? "bull" : p.confidence === "MEDIUM" ? "warn" : "muted"}>{p.confidence}</StatusBadge> },
    { key: "level", header: "Change", render: (p) => p.changeLevel ?? dash },
    {
      key: "act", header: "Decision", render: (p) => (
        <span style={{ display: "flex", gap: 6 }}>
          <button disabled={busy} onClick={() => decide("decide_proposal", p.id, "ACCEPTED")} style={{ fontSize: 12, padding: "3px 8px" }}>Accept</button>
          <button disabled={busy} onClick={() => decide("decide_proposal", p.id, "REJECTED")} style={{ fontSize: 12, padding: "3px 8px" }}>Reject</button>
        </span>
      ),
    },
  ];
  const historyCols: Column<any>[] = [
    { key: "day", header: "Period", render: (r) => r.periodKey },
    { key: "status", header: "Narrative", render: (r) => <StatusBadge tone={r.narrativeStatus === "OK" ? "bull" : r.narrativeStatus === "SKIPPED" ? "muted" : "warn"}>{r.narrativeStatus}</StatusBadge> },
    { key: "issue", header: "Top issue", render: (r) => r.summary?.prioritizedIssue ?? dash },
    {
      key: "retry", header: "Action", render: (r) => {
        const retryable = RETRYABLE_NIGHTLY_STATUSES.has(String(r.narrativeStatus));
        if (!retryable) return <span style={{ fontSize: 12, opacity: 0.55 }}>{dash}</span>;
        const hasReportId = Number.isFinite(Number(r.id));
        const key = hasReportId ? `id:${Number(r.id)}` : `period:${String(r.periodKey ?? "")}`;
        const active = retryingKey === key;
        return (
          <div style={{ display: "grid", gap: 6, minWidth: 150 }}>
            <button disabled={Boolean(retryingKey)} onClick={() => retryNightly(r)} style={{ fontSize: 12, padding: "4px 9px", fontWeight: 700 }}>
              {active ? "Retrying..." : "Retry Narrative"}
            </button>
            {retryMessage?.key === key && (
              <span style={{ fontSize: 12, color: retryMessage.ok ? "var(--bull)" : "var(--bear)" }}>{retryMessage.text}</span>
            )}
          </div>
        );
      },
    },
    {
      key: "diagnostic", header: "Diagnostics", render: (r) =>
        RETRYABLE_NIGHTLY_STATUSES.has(String(r.narrativeStatus))
          ? <ValidationDetails diagnostic={r.diagnostic} summary="Structured validation diagnostic" />
          : null,
    },
    { key: "at", header: "Created", render: (r) => fmtTime(r.createdAtMs) },
  ];
  const lessonCols: Column<any>[] = [
    { key: "title", header: "Lesson", render: (l) => l.title },
    { key: "type", header: "Type", render: (l) => l.findingType },
    { key: "n", header: "Sample", render: (l) => l.sampleSize },
    { key: "conf", header: "Confidence", render: (l) => l.confidence },
    { key: "status", header: "Status", render: (l) => <StatusBadge tone={l.status === "ACCEPTED" ? "bull" : l.status === "REJECTED" ? "bear" : "muted"}>{l.status}</StatusBadge> },
  ];
  const failureCols: Column<any>[] = [
    { key: "job", header: "Job", render: (f) => f.job_type },
    { key: "status", header: "Status", render: (f) => <StatusBadge tone="bear">{f.status}</StatusBadge> },
    { key: "cat", header: "Category", render: (f) => f.error_category ?? dash },
    { key: "err", header: "Error", render: (f) => <span style={{ fontSize: 12, opacity: 0.85 }}>{f.error ?? dash}</span> },
    { key: "validator", header: "Validator", render: (f) => f.diagnostic?.validatorName ?? "n/a" },
    { key: "field", header: "Field", render: (f) => f.diagnostic?.failingField ?? "n/a" },
    { key: "details", header: "Details", render: (f) => <ValidationDetails diagnostic={f.diagnostic} summary="Validation diagnostic" /> },
    { key: "at", header: "When", render: (f) => fmtTime(f.created_at_ms) },
  ];
  const gateCols: Column<any>[] = [
    { key: "gate", header: "Gate", render: (g) => g.gate },
    { key: "count", header: "Count", render: (g) => g.count },
    { key: "pct", header: "%", render: (g) => fmtMetric(g.pct, "%") },
    { key: "trend", header: "Trend", render: (g) => fmtTrend(g.trend) },
    { key: "examples", header: "Samples", render: (g) => (g.sampleExamples ?? []).slice(0, 2).join(" | ") || "n/a" },
    { key: "why", header: "AI explanation", render: (g) => <span style={{ fontSize: 12 }}>{g.aiExplanation}</span> },
  ];
  const missedCols: Column<any>[] = [
    { key: "ticker", header: "Ticker", render: (r) => r.ticker },
    { key: "time", header: "Time", render: (r) => fmtTime(r.timeMs) },
    { key: "move", header: "Current move", render: (r) => fmtMetric(r.currentMovePct, "%") },
    { key: "peak", header: "Peak move", render: (r) => fmtMetric(r.peakMovePct, "%") },
    { key: "delay", header: "Delay", render: (r) => fmtMs(r.delayMs) },
    { key: "reason", header: "Reason not alerted", render: (r) => r.reasonNotAlerted },
    { key: "gate", header: "Responsible gate", render: (r) => r.responsibleGate },
    { key: "fixable", header: "Fixable?", render: (r) => r.fixable },
  ];
  const strategyCols: Column<any>[] = [
    { key: "strategy", header: "Strategy", render: (s) => s.strategy },
    { key: "wr", header: "Win rate", render: (s) => fmtMetric(s.winRate, "%") },
    { key: "pf", header: "Profit factor", render: (s) => fmtMetric(s.profitFactor) },
    { key: "avg", header: "Avg return", render: (s) => fmtMetric(s.averageReturnPct, "%") },
    { key: "opp", header: "Opportunity grade", render: (s) => fmtMetric(s.opportunityGradeSuccess, "%") },
    { key: "fp", header: "False positive", render: (s) => fmtMetric(s.falsePositivePct, "%") },
    { key: "miss", header: "Miss rate", render: (s) => fmtMetric(s.missRate, "%") },
    { key: "trend", header: "Trend", render: (s) => fmtTrend(s.trend) },
    { key: "grade", header: "Grade", render: (s) => <StatusBadge tone={String(s.healthGrade).startsWith("A") || String(s.healthGrade).startsWith("B") ? "bull" : s.healthGrade === "N/A" ? "muted" : "warn"}>{s.healthGrade}</StatusBadge> },
  ];
  const requirementCols: Column<any>[] = [
    { key: "label", header: "Requirement", render: (r) => r.label },
    { key: "value", header: "Value", render: (r) => fmtMetric(r.value, "%") },
    { key: "target", header: "Target", render: (r) => r.target },
    { key: "status", header: "Status", render: (r) => <StatusBadge tone={r.passed == null ? "muted" : r.passed ? "bull" : "warn"}>{r.passed == null ? "not stored" : r.passed ? "met" : "not met"}</StatusBadge> },
  ];
  const researchCols: Column<any>[] = [
    { key: "question", header: "Research question", render: (r) => r.question },
    { key: "formula", header: "Current formula", render: (r) => <span style={{ fontSize: 12 }}>{r.currentFormula}</span> },
    { key: "challenger", header: "Challenger", render: (r) => r.challengerFormula },
    { key: "status", header: "Status", render: (r) => <StatusBadge tone="muted">{r.status}</StatusBadge> },
  ];
  const experimentCols: Column<any>[] = [
    { key: "title", header: "Experiment", render: (e) => e.title },
    { key: "reason", header: "Reason", render: (e) => e.reason },
    { key: "expected", header: "Expected improvement", render: (e) => e.expectedImprovement ?? "n/a" },
    { key: "confidence", header: "Confidence", render: (e) => e.confidence },
    { key: "risk", header: "Risk", render: (e) => e.risk ?? "n/a" },
    { key: "status", header: "Status", render: (e) => <StatusBadge tone={e.status === "Accepted" ? "bull" : e.status === "Rejected" ? "bear" : "warn"}>{e.status}</StatusBadge> },
  ];
  const evidenceCols: Column<any>[] = [
    { key: "label", header: "Evidence cut", render: (e) => e.label },
    { key: "n", header: "Sample", render: (e) => fmtNum(e.sample_size) },
    { key: "wr", header: "Win rate", render: (e) => e.win_rate == null ? "n/a" : `${(Number(e.win_rate) * 100).toFixed(1)}%` },
    { key: "avg", header: "Avg return", render: (e) => fmtMetric(e.avg_return_pct, "%") },
    { key: "lift", header: "Delivered lift", render: (e) => e.delivered_vs_research_lift == null ? "n/a" : `${(Number(e.delivered_vs_research_lift) * 100).toFixed(1)} pts` },
    { key: "confidence", header: "Confidence", render: (e) => <StatusBadge tone={e.confidence === "HIGH" ? "bull" : e.confidence === "MEDIUM" ? "warn" : "muted"}>{e.confidence}</StatusBadge> },
    { key: "risk", header: "Overfit risk", render: (e) => <StatusBadge tone={e.overfitting_risk === "LOW" ? "bull" : e.overfitting_risk === "MEDIUM" ? "warn" : "bear"}>{e.overfitting_risk}</StatusBadge> },
    { key: "rec", header: "Recommendation", render: (e) => <span style={{ fontSize: 12 }}>{e.recommendation}</span> },
  ];
  const portfolioCols: Column<any>[] = [
    { key: "portfolio", header: "Portfolio", render: (p) => p.portfolio },
    { key: "curve", header: "Equity curve", render: (p) => p.equityCurve },
    { key: "returns", header: "Returns", render: (p) => fmtMetric(p.returns, "%") },
    { key: "dd", header: "Drawdown", render: (p) => fmtMetric(p.drawdown, "%") },
    { key: "wr", header: "Win rate", render: (p) => fmtMetric(p.winRate, "%") },
    { key: "pf", header: "Profit factor", render: (p) => fmtMetric(p.profitFactor) },
    { key: "opp", header: "Opportunity grade", render: (p) => fmtMetric(p.opportunityGrade, "%") },
    { key: "mix", header: "Strategy mix", render: (p) => <span style={{ fontSize: 12 }}>{p.strategyMix}</span> },
  ];

  return (
    <PageContainer>
      {disabled && (
        <Card title="AI is OFF" meta="Advisory layer - safe default">
          <p style={{ fontSize: 13, margin: "0 0 6px" }}>
            The advisory AI is disabled. It never trades, edits code, changes callouts, or bypasses gates.
          </p>
          <p style={{ fontSize: 12, opacity: 0.8, margin: 0 }}>
            To enable: set <code>AI_ENABLED=1</code>, <code>ANTHROPIC_API_KEY</code>, and <code>AI_NIGHTLY_DIAGNOSIS_ENABLED=1</code>.
            {!flags.hasApiKey && " An Anthropic API key is currently missing."}
          </p>
        </Card>
      )}

      <ResponsiveGrid min={240}>
        <Card title="Status" meta="Research only">
          <KeyValue k="AI enabled" v={flags.enabled ? "yes" : "no"} tone={flags.enabled ? "bull" : "muted"} />
          <KeyValue k="Anthropic API key" v={flags.hasApiKey ? "configured" : "missing"} tone={flags.hasApiKey ? "bull" : "bear"} />
          <KeyValue k="Nightly diagnosis" v={flags.nightlyDiagnosisEnabled ? "on" : "off"} tone={flags.nightlyDiagnosisEnabled ? "bull" : "muted"} />
          <KeyValue k="Weekly proposals" v={flags.weeklyProposalsEnabled ? "on" : "off"} tone={flags.weeklyProposalsEnabled ? "bull" : "muted"} />
          <KeyValue k="Nightly recap" v={flags.recapEnabled ? "on" : "off"} tone={flags.recapEnabled ? "bull" : "muted"} />
        </Card>

        <Card title="Schedule & runs" meta="America/New_York">
          <KeyValue k="Last job run" v={`${fmtTime(runs.lastRunAtMs)}${runs.lastRunType ? ` / ${runs.lastRunType} (${runs.lastRunStatus})` : ""}`} />
          <KeyValue k="Last success" v={fmtTime(runs.lastSuccessAtMs)} tone={runs.lastSuccessAtMs ? "bull" : "muted"} />
          <KeyValue k="Last failure" v={runs.lastFailureAtMs ? `${fmtTime(runs.lastFailureAtMs)} / ${runs.lastFailureType}` : "none"} tone={runs.lastFailureAtMs ? "bear" : "bull"} />
          <KeyValue k="Next nightly" v={`${fmtTime(schedule.nextNightlyEligibleMs)}${schedule.nightlyDueNow ? " / DUE NOW" : ""}`} />
          <KeyValue k="Next weekly" v={`${fmtTime(schedule.nextWeeklyEligibleMs)}${schedule.weeklyDueNow ? " / DUE NOW" : ""}`} />
          <KeyValue k="Last nightly report" v={schedule.lastNightlyDay ? `${schedule.lastNightlyDay} (${schedule.lastNightlyStatus})` : "none yet"} />
        </Card>

        <Card title="Models & cost" meta={cost?.monthKey ?? ""}>
          <KeyValue k="Nightly model" v={flags.nightlyModel ?? dash} />
          <KeyValue k="Weekly model" v={flags.weeklyModel ?? dash} />
          <KeyValue k="Input tokens (mo)" v={fmtNum(cost?.inputTokens)} />
          <KeyValue k="Output tokens (mo)" v={fmtNum(cost?.outputTokens)} />
          <KeyValue k="Estimated spend" v={`$${(cost?.spendUsd ?? 0).toFixed(4)}`} tone={cost?.atHardLimit ? "bear" : cost?.atSoftLimit ? "warn" : "bull"} />
          <KeyValue k="Soft / hard limit" v={`$${cost?.softLimitUsd ?? 0} / $${cost?.hardLimitUsd ?? 0}`} />
          <KeyValue k="Budget" v={cost?.atHardLimit ? "hard limit - optional AI skipped" : cost?.atSoftLimit ? "soft limit reached" : "within budget"} tone={cost?.atHardLimit ? "bear" : cost?.atSoftLimit ? "warn" : "bull"} />
        </Card>
      </ResponsiveGrid>

      <Card title="Evidence Learning Engine" meta="Aggregate evidence only">
        <ResponsiveGrid min={180}>
          <KeyValue k="Available" v={evidenceLearning?.available ? "yes" : "no"} tone={evidenceLearning?.available ? "bull" : "muted"} />
          <KeyValue k="Production authority" v={evidenceLearning?.productionAuthority ?? "none"} tone="muted" />
          <KeyValue k="Completed examples" v={fmtNum(evidenceLearning?.examples?.total)} />
          <KeyValue k="Delivered mirrors" v={fmtNum(evidenceLearning?.examples?.delivered)} />
          <KeyValue k="Research-only mirrors" v={fmtNum(evidenceLearning?.examples?.researchOnly)} />
          <KeyValue k="Replay labels" v={fmtNum(evidenceLearning?.examples?.replayUnderlyingForward)} />
          <KeyValue k="Patterns" v={fmtNum(evidenceLearning?.patterns?.total)} />
          <KeyValue k="Ranked recommendations" v={fmtNum(evidenceLearning?.patterns?.actionableRecommendations)} />
        </ResponsiveGrid>
        <p style={{ fontSize: 12, opacity: 0.78, margin: "10px 0" }}>
          {evidenceLearning?.disclaimer ?? "Evidence Learning is advisory-only and never changes production logic automatically."}
        </p>
        <SimpleTable
          columns={evidenceCols}
          rows={evidenceLearning?.patterns?.top ?? []}
          rowKey={(e, i) => `${e.pattern_key ?? e.label}-${i}`}
          emptyTitle="No aggregate evidence yet"
          emptyReason="Completed delivered/research mirrors and replay labels will be materialized into long-term evidence during weekly runs or manual refresh."
        />
      </Card>

      {quant && (
        <>
          <Card title="Scanner Health" meta="Deterministic score from stored scanner metrics">
            <ResponsiveGrid min={180}>
              <KeyValue k="Overall Grade" v={quant.scannerHealth?.grade ?? "N/A"} tone={toneForScore(quant.scannerHealth?.score)} />
              <KeyValue k="Scanner Health Score" v={fmtMetric(quant.scannerHealth?.score)} />
              <KeyValue k="Trend vs Yesterday" v={fmtTrend(quant.scannerHealth?.trendVsYesterday)} tone={(quant.scannerHealth?.trendVsYesterday?.value ?? 0) >= 0 ? "bull" : "warn"} />
              <KeyValue k="Trend vs Last Week" v={fmtTrend(quant.scannerHealth?.trendVsLastWeek)} tone={(quant.scannerHealth?.trendVsLastWeek?.value ?? 0) >= 0 ? "bull" : "warn"} />
              <KeyValue k="Trend vs Last Month" v={fmtTrend(quant.scannerHealth?.trendVsLastMonth)} tone={(quant.scannerHealth?.trendVsLastMonth?.value ?? 0) >= 0 ? "bull" : "warn"} />
            </ResponsiveGrid>
            <div style={{ marginTop: 12 }}><MetricTiles items={quant.scannerHealth?.components ?? []} /></div>
          </Card>

          <Card title="Today's Scanner Report Card" meta="Stored deterministic fields">
            <MetricTiles items={quant.reportCard ?? []} />
          </Card>

          <ResponsiveGrid min={360}>
            <Card title="Why Setups Were Rejected" meta="Top gates rejecting winners and candidates">
              <SimpleTable columns={gateCols} rows={quant.gateBreakdown ?? []} rowKey={(g, i) => `${g.gate}-${i}`} emptyTitle="No gate rejections" emptyReason="No rejection rows were recorded for the latest report." />
            </Card>
            <Card title="Missed Runners" meta="Per-runner stored momentum diagnostics">
              <SimpleTable columns={missedCols} rows={quant.missedRunners ?? []} rowKey={(r, i) => `${r.ticker}-${r.timeMs}-${i}`} emptyTitle="No missed-runner rows" emptyReason="No per-runner momentum diagnostics were recorded for the latest nightly day." />
            </Card>
          </ResponsiveGrid>

          <Card title="Strategy Scorecard" meta="Strategies, calls, puts, 0DTE, weeklies, sessions">
            <SimpleTable columns={strategyCols} rows={quant.strategyScorecards ?? []} rowKey={(s, i) => `${s.strategy}-${i}`} emptyTitle="No strategy samples" emptyReason="No deterministic paper outcomes are available yet." />
          </Card>

          <ResponsiveGrid min={360}>
            <Card title="Copy Trading Readiness" meta="Consistency evaluator only">
              <ResponsiveGrid min={180}>
                <KeyValue k="Readiness" v={fmtMetric(quant.copyTradingReadiness?.score)} />
                <KeyValue k="Grade" v={quant.copyTradingReadiness?.grade ?? "N/A"} tone={toneForScore(quant.copyTradingReadiness?.score)} />
              </ResponsiveGrid>
              <p style={{ fontSize: 12, opacity: 0.78 }}>{quant.copyTradingReadiness?.aiExplanation}</p>
              <SimpleTable columns={requirementCols} rows={quant.copyTradingReadiness?.requirements ?? []} rowKey={(r, i) => `${r.label}-${i}`} emptyTitle="No readiness inputs" emptyReason="Readiness inputs appear after deterministic report data is stored." />
            </Card>

            <Card title="Daily AI Summary" meta="Compact nightly research rollup">
              <ResponsiveGrid min={170}>
                <KeyValue k="Today's Scanner Grade" v={quant.dailyAiSummary?.scannerGrade ?? "N/A"} />
                <KeyValue k="Scanner Health" v={fmtMetric(quant.dailyAiSummary?.scannerHealth)} />
                <KeyValue k="Missed Fast Movers" v={fmtMetric(quant.dailyAiSummary?.missedFastMovers)} />
                <KeyValue k="Late Alerts" v={fmtMetric(quant.dailyAiSummary?.lateAlerts)} />
                <KeyValue k="False Positives" v={fmtMetric(quant.dailyAiSummary?.falsePositives)} />
                <KeyValue k="Best Strategy" v={quant.dailyAiSummary?.bestStrategy ?? "n/a"} />
                <KeyValue k="Worst Strategy" v={quant.dailyAiSummary?.worstStrategy ?? "n/a"} />
                <KeyValue k="Top Rejecting Gate" v={quant.dailyAiSummary?.topRejectingGate ?? "n/a"} />
                <KeyValue k="Most Common Failure" v={quant.dailyAiSummary?.mostCommonFailure ?? "n/a"} />
                <KeyValue k="Most Improved Metric" v={quant.dailyAiSummary?.mostImprovedMetric ?? "n/a"} />
                <KeyValue k="Most Regressed Metric" v={quant.dailyAiSummary?.mostRegressedMetric ?? "n/a"} />
                <KeyValue k="Recommended Experiment" v={quant.dailyAiSummary?.recommendedExperiment ?? "n/a"} />
                <KeyValue k="Expected Impact" v={quant.dailyAiSummary?.expectedImpact ?? "n/a"} />
                <KeyValue k="Confidence" v={quant.dailyAiSummary?.confidence ?? "LOW"} />
              </ResponsiveGrid>
            </Card>
          </ResponsiveGrid>

          <Card title="AI Research" meta="Weekly baseline/current/challenger research questions">
            <SimpleTable columns={researchCols} rows={(quant.researchTopics ?? []).slice(0, 12)} rowKey={(r, i) => `${r.question}-${i}`} emptyTitle="No research topics" emptyReason="Research topics are generated from the deterministic formula inventory." />
            <DetailsDisclosure summary="More research questions">
              <SimpleTable columns={researchCols} rows={(quant.researchTopics ?? []).slice(12)} rowKey={(r, i) => `${r.question}-${i}`} emptyTitle="No more topics" emptyReason="All research topics are already visible above." />
            </DetailsDisclosure>
          </Card>

          <Card title="Recommended Experiments" meta="Pending, accepted, rejected, testing, completed">
            <SimpleTable columns={experimentCols} rows={quant.recommendedExperiments ?? []} rowKey={(e, i) => `${e.title}-${i}`} emptyTitle="No recommended experiments" emptyReason="Weekly proposals will appear here as pending experiments." />
          </Card>

          <Card title="Portfolio Comparison" meta="Primary vs Aggressive Challenge vs Stock Day Trader">
            <SimpleTable columns={portfolioCols} rows={quant.portfolioComparison ?? []} rowKey={(p, i) => `${p.portfolio}-${i}`} emptyTitle="No portfolio rows" emptyReason="Portfolio comparison appears when deterministic weekly context is stored." />
          </Card>

          <Card title="Visualizations" meta="Interactive deterministic chart points">
            <ResponsiveGrid min={240}>
              <div><p style={{ fontSize: 12, fontWeight: 700 }}>Scanner Health over time</p><Sparkline points={quant.charts?.scannerHealth ?? []} /></div>
              <div><p style={{ fontSize: 12, fontWeight: 700 }}>Missed Runner Trend</p><Sparkline points={quant.charts?.missedRunnerTrend ?? []} /></div>
              <div><p style={{ fontSize: 12, fontWeight: 700 }}>False Positive Trend</p><Sparkline points={quant.charts?.falsePositiveTrend ?? []} /></div>
              <div><p style={{ fontSize: 12, fontWeight: 700 }}>Late Alert Trend</p><Sparkline points={quant.charts?.lateAlertTrend ?? []} /></div>
              <div><p style={{ fontSize: 12, fontWeight: 700 }}>Average Delay</p><Sparkline points={quant.charts?.averageDelay ?? []} /></div>
              <div><p style={{ fontSize: 12, fontWeight: 700 }}>Opportunity Grade Trend</p><Sparkline points={quant.charts?.opportunityGradeTrend ?? []} /></div>
              <div><p style={{ fontSize: 12, fontWeight: 700 }}>Calls vs Puts</p><Sparkline points={quant.charts?.callsVsPuts ?? []} /></div>
              <div><p style={{ fontSize: 12, fontWeight: 700 }}>Discovery Delay</p><Sparkline points={quant.charts?.discoveryDelay ?? []} /></div>
              <div><p style={{ fontSize: 12, fontWeight: 700 }}>Gate Rejection Distribution</p><BarRows rows={quant.charts?.gateRejectionDistribution ?? []} /></div>
            </ResponsiveGrid>
          </Card>

          <Card title="AI Guardrails" meta="Research portal boundaries">
            <ResponsiveGrid min={240}>
              {(quant.guardrails ?? []).map((g: string) => <KeyValue key={g} k="Rule" v={g} tone="muted" />)}
            </ResponsiveGrid>
            {Array.isArray(quant.dataGaps) && quant.dataGaps.length > 0 && (
              <DetailsDisclosure summary="Deterministic data gaps">
                {quant.dataGaps.map((g: string, i: number) => <p key={i} style={{ fontSize: 12, margin: "2px 0" }}>{g}</p>)}
              </DetailsDisclosure>
            )}
          </Card>
        </>
      )}

      <Card title="Latest nightly diagnosis" meta={nightly?.periodKey ? `${nightly.periodKey} / ${nightly.narrativeStatus}` : "no report yet"}>
        {!nightly ? (
          <EmptyState title="No nightly report yet" reason={disabled ? "Enable the AI layer to generate nightly diagnoses." : "The nightly job runs after 20:15 ET on trading weekdays."} />
        ) : (
          <>
            <ResponsiveGrid min={180}>
              <KeyValue k="Prioritized issue" v={nightly.summary?.prioritizedIssue ?? dash} tone={nightly.summary?.prioritizedIssue ? "warn" : "muted"} />
              <KeyValue k="Graded outcomes" v={nightly.summary?.counts?.outcomesGraded ?? 0} />
              <KeyValue k="Rejected" v={nightly.summary?.counts?.rejected ?? 0} />
              <KeyValue k="Options delivery blocked" v={nightly.summary?.options?.configBlockedCycles ?? 0} tone={(nightly.summary?.options?.configBlockedCycles ?? 0) > 0 ? "bear" : "muted"} />
              <KeyValue k="Momentum near misses" v={nightly.summary?.momentum?.nearMisses ?? nightly.summary?.counts?.nearMisses ?? "n/a"} />
            </ResponsiveGrid>
            {narrative ? (
              <div style={{ marginTop: 10 }}>
                <p style={{ fontWeight: 600, margin: "0 0 6px" }}>{narrative.headline}</p>
                <p style={{ fontSize: 13, opacity: 0.9 }}>{narrative.whatHappened}</p>
                {Array.isArray(narrative.repeatedPatterns) && narrative.repeatedPatterns.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <p style={{ fontSize: 12, opacity: 0.7, margin: "4px 0" }}>Repeated patterns</p>
                    {narrative.repeatedPatterns.map((s: string, i: number) => <p key={i} style={{ fontSize: 12, margin: "2px 0" }}>- {s}</p>)}
                  </div>
                )}
              </div>
            ) : (
              <p style={{ fontSize: 12, opacity: 0.75, marginTop: 8 }}>
                Deterministic summary stored; narrative status: <strong>{nightly.narrativeStatus}</strong>
                {nightly.narrativeStatus === "SKIPPED" && " (AI narration disabled or over budget; the numbers above are still real)."}
              </p>
            )}
            {!narrative && ["VALIDATION_FAILED", "ERROR", "SKIPPED"].includes(String(nightly.narrativeStatus)) && (
              <div style={{ display: "grid", gap: 6, justifyItems: "start", marginTop: 6 }}>
                <button disabled={Boolean(retryingKey)} onClick={() => retryNightly(nightly)} style={{ fontSize: 12, padding: "4px 9px", fontWeight: 700 }}>
                  {retryingKey ? "Retrying..." : "Retry Narrative"}
                </button>
                {retryMessage && <span style={{ fontSize: 12, color: retryMessage.ok ? "var(--bull)" : "var(--bear)" }}>{retryMessage.text}</span>}
              </div>
            )}
            <ValidationDetails diagnostic={diagnostic} summary="Structured validation diagnostic" />
            {Array.isArray(nightly.summary?.patterns) && nightly.summary.patterns.length > 0 && (
              <DetailsDisclosure summary="Deterministic patterns">
                {nightly.summary.patterns.map((s: string, i: number) => <p key={i} style={{ fontSize: 12, margin: "2px 0" }}>- {s}</p>)}
              </DetailsDisclosure>
            )}
          </>
        )}
      </Card>

      <ResponsiveGrid min={320}>
        <Card title="Latest weekly proposal" meta={latestWeekly?.periodKey ?? "no weekly report yet"}>
          {!latestWeekly ? (
            <EmptyState title="No weekly report yet" reason="The weekly job runs Friday >=21:00 ET / Saturday." />
          ) : (
            <>
              <KeyValue k="Narrative" v={latestWeekly.narrativeStatus} />
              <KeyValue k="Created" v={fmtTime(latestWeekly.createdAtMs)} />
              {latestWeekly.narrative?.headline && <p style={{ fontSize: 13, marginTop: 6 }}>{latestWeekly.narrative.headline}</p>}
              <ValidationDetails diagnostic={latestWeekly.diagnostic} summary="Weekly failure details" />
            </>
          )}
        </Card>
        <Card title="Nightly Report History" meta={`${nightlyHistory.length} reports`}>
          <SimpleTable columns={historyCols} rows={nightlyHistory.slice(0, 15)} rowKey={(r) => String(r.id)} emptyTitle="No reports yet" emptyReason="Reports appear after the nightly job runs." />
        </Card>
      </ResponsiveGrid>

      <Card title="Proposals" meta={`${pending.length} pending / ${accepted.length} accepted / ${rejected.length} rejected`}>
        <SimpleTable columns={proposalCols} rows={pending} rowKey={(p) => String(p.id)} emptyTitle="No pending proposals" emptyReason="The weekly job proposes changes on Friday night / Saturday. Nothing is applied automatically." />
      </Card>

      <ResponsiveGrid min={320}>
        <Card title="Lessons memory" meta="Deterministic, evidence-gated findings">
          <SimpleTable columns={lessonCols} rows={lessons} rowKey={(l) => String(l.id)} emptyTitle="No lessons yet" emptyReason="Nightly reports record lessons once evidence thresholds are met." />
        </Card>
        <Card title="Job failures" meta={failures.length ? `${failures.length} recent` : "none"}>
          <SimpleTable columns={failureCols} rows={failures} rowKey={(f) => String(f.id)} emptyTitle="No failures" emptyReason="Every AI job so far either succeeded or was safely skipped." />
        </Card>
      </ResponsiveGrid>
    </PageContainer>
  );
}
