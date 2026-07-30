"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  PageContainer, ResponsiveGrid, Card, KeyValue, StatusBadge, LoadingState, ErrorState, EmptyState, DetailsDisclosure,
} from "@/components/ui/Shell";
import { SimpleTable, type Column } from "@/components/ui/Table";
import { scanHeaders } from "@/hooks/useScanner";
import { apiFetchJson, describeApiLoadFailure, parseApiJsonResponse } from "@/lib/client-auth";
import { AdvisoryChat } from "@/components/AdvisoryChat";

type Tab = "OVERVIEW" | "CHAT" | "FINDINGS" | "EXPERIMENTS" | "REPORTS" | "ADVANCED";

type FindingsResponse = { report?: any };
type OverviewResponse = { overview?: any };

const tabs: Tab[] = ["OVERVIEW", "CHAT", "FINDINGS", "EXPERIMENTS", "REPORTS", "ADVANCED"];
const RETRYABLE_NIGHTLY_STATUSES = new Set(["VALIDATION_FAILED", "ERROR", "SKIPPED"]);
const dash = "-";

const fmtNum = (n: any, unit = "") => {
  if (n == null || n === "") return "n/a";
  if (typeof n === "number") return `${Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1)}${unit ? ` ${unit}` : ""}`;
  return String(n);
};

const fmtTime = (ms?: number | null) =>
  ms ? `${new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} ET` : dash;

function toneForConfidence(c: string): "bull" | "warn" | "bear" | "muted" {
  if (c === "HIGH") return "bull";
  if (c === "MEDIUM") return "warn";
  if (c === "LOW") return "bear";
  return "muted";
}

function toneForQuality(q: string): "bull" | "warn" | "bear" | "muted" {
  if (q === "VALID") return "bull";
  if (q === "MISSING_DATA") return "muted";
  if (["TIMESTAMP_ERROR", "BROKEN_QUERY", "PIPELINE_MIXED", "UNIT_ERROR"].includes(q)) return "bear";
  return "warn";
}

function pipelineLabel(p: string): string {
  const labels: Record<string, string> = {
    INDEPENDENT_OPTIONS: "Active options scanner",
    DELIVERED_ALERT_PAPER: "Verified delivered options",
    STOCK_MOMENTUM: "Stock momentum scanner",
    SUPERVISOR_OPTIONS: "Inactive legacy options pipeline",
    ZERO_DTE_RESEARCH: "0DTE research lane",
    SHADOW_REPLAY: "Shadow replay",
    LEGACY_AUDIT: "Legacy audit",
  };
  return labels[p] ?? p ?? "Unknown pipeline";
}

function plainText(s: any): string {
  return String(s ?? "")
    .replace(/INDEPENDENT_OPTIONS/g, "Active options scanner")
    .replace(/DELIVERED_ALERT_PAPER/g, "Verified delivered options")
    .replace(/STOCK_MOMENTUM/g, "Stock momentum scanner")
    .replace(/SUPERVISOR_OPTIONS/g, "Inactive legacy options pipeline")
    .replace(/READY -> SENT linked cohort/g, "Qualified setups that became alerts")
    .replace(/Independent READY -> SENT cohort is linked/g, "Qualified setups that became alerts are linked")
    .replace(/midday_1100_1400/g, "11:00 a.m.-2:00 p.m. ET");
}

function issueType(f: any): string {
  const text = `${f?.findingId ?? f?.id ?? ""} ${f?.title ?? ""} ${f?.explanation ?? ""}`.toLowerCase();
  if (/latency|timestamp|duplicate|profit|no data|source|quality/.test(text)) return "Data bug";
  if (/stop|t1|exit|return/.test(text)) return "Exit issue";
  if (/late|timing|session|midday/.test(text)) return "Timing issue";
  return "Strategy issue";
}

function unsafeMetric(m: any): boolean {
  return ["TIMESTAMP_ERROR", "BROKEN_QUERY", "PIPELINE_MIXED", "UNIT_ERROR", "MISSING_DATA", "DUPLICATED"].includes(String(m?.qualityStatus ?? ""));
}

function metricDisplayValue(metric: any): string {
  if (!metric) return "n/a";
  if (unsafeMetric(metric)) return metric.qualityStatus === "TIMESTAMP_ERROR" ? "Unavailable" : fmtNum(metric.value, metric.unit);
  return fmtNum(metric.value, metric.unit);
}

function invalidMetricReason(metric: any): string | null {
  if (!metric) return null;
  if (metric.qualityStatus === "TIMESTAMP_ERROR") return `${metric.sampleSize ?? "Some"} records include invalid timestamps; excluded from top-line decisions.`;
  if (metric.qualityStatus === "DUPLICATED") return "Diagnostic raw count only; repeated observations are not unique opportunities.";
  if (metric.qualityStatus === "MISSING_DATA") return "Canonical data is unavailable for this lane/window.";
  if (metric.qualityStatus === "VALID_BUT_MISLEADING") return "Useful for investigation, but not safe as a top-line decision metric.";
  if (!metric.safeForTopLine) return "Not safe for top-line use at this sample size or quality level.";
  return null;
}

function sourceText(metric: any): string {
  return `${metric?.source?.table ?? "n/a"} / ${metric?.source?.function ?? "n/a"} / ${metric?.source?.field ?? "n/a"}`;
}

function createFixPrompt(item: any, finding?: any): string {
  return [
    "Codex fix prompt - advisory export only",
    "",
    `Finding: ${plainText(item?.title ?? finding?.title ?? "n/a")}`,
    `Type: ${issueType(item ?? finding)}`,
    `Evidence window: ${item?.evidenceWindow ?? "n/a"}`,
    `Sample size: ${item?.sampleSize ?? "n/a"}`,
    `Current behavior: ${item?.currentBehavior ?? finding?.summary ?? "n/a"}`,
    `Proposed investigation: ${item?.proposedBehavior ?? finding?.recommendedNextStep ?? "n/a"}`,
    `Risk: ${item?.rollbackPlan ?? "Keep advisory-only until reviewed."}`,
    "Boundary: Do not change live scanner formulas, thresholds, delivery rules, or Railway variables without human approval.",
  ].join("\n");
}

function FindingList({ rows, empty, metrics = [], dateWindow }: { rows: any[]; empty: string; metrics?: any[]; dateWindow?: string | null }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (!rows?.length) return <EmptyState title={empty} reason="No canonical finding in this section yet." />;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {rows.map((f) => (
        <div key={f.id} style={{ border: "1px solid rgba(148,163,184,.22)", borderRadius: 8, padding: 12, display: "grid", gap: 6 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <strong>{plainText(f.title)}</strong>
            <StatusBadge tone={f.severity === "critical" ? "bear" : f.severity === "warning" ? "warn" : f.severity === "positive" ? "bull" : "muted"}>{f.classification}</StatusBadge>
            <StatusBadge tone={toneForConfidence(f.confidence)}>{f.confidence}</StatusBadge>
            <span style={{ fontSize: 11, opacity: 0.7 }}>{pipelineLabel(f.pipeline)}</span>
          </div>
          <p style={{ margin: 0, fontSize: 13, opacity: 0.9 }}>{plainText(f.summary)}</p>
          {f.recommendedNextStep && <p style={{ margin: 0, fontSize: 12, opacity: 0.72 }}>Next: {plainText(f.recommendedNextStep)}</p>}
          <button
            type="button"
            onClick={() => setOpen((prev) => ({ ...prev, [f.id]: !prev[f.id] }))}
            style={{ justifySelf: "start", fontSize: 12, padding: "4px 9px", fontWeight: 800 }}
          >
            View evidence
          </button>
          {open[f.id] ? (
            <div style={{ borderTop: "1px solid rgba(148,163,184,.18)", paddingTop: 8, display: "grid", gap: 8 }}>
              <ResponsiveGrid min={230}>
                <KeyValue k="Classification" v={f.classification} />
                <KeyValue k="Pipeline" v={pipelineLabel(f.pipeline)} />
                <KeyValue k="Pipeline ID" v={f.pipeline} />
                <KeyValue k="Date/window" v={dateWindow ?? metrics.find((m) => f.metricIds?.includes(m.id))?.timeWindow ?? "n/a"} />
                <KeyValue k="Confidence" v={f.confidence} tone={toneForConfidence(f.confidence)} />
              </ResponsiveGrid>
              <SimpleTable
                columns={[
                  { key: "metric", header: "Affected metric", render: (m: any) => m.label },
                  { key: "lane", header: "Lane", render: (m: any) => plainText(m.lane) },
                  { key: "sample", header: "Sample", render: (m: any) => fmtNum(m.sampleSize) },
                  { key: "quality", header: "Quality", render: (m: any) => <StatusBadge tone={toneForQuality(m.qualityStatus)}>{m.qualityStatus}</StatusBadge> },
                  { key: "source", header: "Source", render: (m: any) => <span style={{ whiteSpace: "normal", fontSize: 12 }}>{sourceText(m)}</span> },
                ]}
                rows={metrics.filter((m) => f.metricIds?.includes(m.id))}
                rowKey={(m: any) => m.id}
                emptyTitle="No affected metrics"
                emptyReason="This finding is supported by source records rather than a single metric."
              />
              <ResponsiveGrid min={220}>
                <KeyValue k="Supporting records" v={(f.sourceRefs ?? []).join(", ") || "n/a"} />
                <KeyValue k="Investigation" v={plainText(f.recommendedNextStep ?? "No investigation recorded")} />
                <KeyValue k="Limitations" v={metrics.filter((m) => f.metricIds?.includes(m.id)).map(invalidMetricReason).filter(Boolean).join(" ") || "No additional limitations recorded."} />
              </ResponsiveGrid>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function MetricCard({ metric }: { metric: any }) {
  const reason = invalidMetricReason(metric);
  return (
    <div style={{ border: "1px solid rgba(148,163,184,.22)", borderRadius: 8, padding: 12, display: "grid", gap: 7 }}>
      <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center" }}>
        <strong style={{ fontSize: 13 }}>{metric.label}</strong>
        <StatusBadge tone={toneForQuality(metric.qualityStatus)}>{metric.qualityStatus}</StatusBadge>
      </div>
      <div style={{ fontSize: unsafeMetric(metric) ? 18 : 24, fontWeight: 850, opacity: unsafeMetric(metric) ? 0.72 : 1 }}>
        {metricDisplayValue(metric)}
      </div>
      {reason ? <p style={{ margin: 0, fontSize: 12, opacity: 0.86 }}>{reason}</p> : <p style={{ margin: 0, fontSize: 12, opacity: 0.86 }}>{metric.meaning}</p>}
      <p style={{ margin: 0, fontSize: 11, opacity: 0.62 }}>
        {pipelineLabel(metric.pipeline)} / sample {metric.sampleSize ?? "n/a"} / confidence {metric.confidence} / safe to use: {metric.safeForTopLine ? "yes" : "no"}
      </p>
    </div>
  );
}

function MetricsGrid({ metrics, ids }: { metrics: any[]; ids: string[] }) {
  const selected = ids.map((id) => metrics.find((m) => m.id === id)).filter(Boolean);
  return <ResponsiveGrid min={230}>{selected.map((m) => <MetricCard key={m.id} metric={m} />)}</ResponsiveGrid>;
}

function MetricRegistry({ rows }: { rows: any[] }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);
  if (!rows.length) return <EmptyState title="No metrics" reason="No canonical findings report is available." />;
  const copySource = async (m: any) => {
    const text = sourceText(m);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(m.id);
      setTimeout(() => setCopied(null), 1400);
    } catch {
      setCopied(null);
    }
  };
  return (
    <div className="ui-table-scroll" style={{ overflowX: "auto" }}>
      <table className="ui-table" style={{ minWidth: 1180 }}>
        <thead>
          <tr>
            <th>Metric</th>
            <th>Value</th>
            <th>Quality</th>
            <th>Sample</th>
            <th>Safe?</th>
            <th>Source</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <Fragment key={m.id}>
              <tr key={m.id}>
                <td>{m.label}</td>
                <td>{metricDisplayValue(m)}</td>
                <td><StatusBadge tone={toneForQuality(m.qualityStatus)}>{m.qualityStatus}</StatusBadge></td>
                <td>{fmtNum(m.sampleSize)}</td>
                <td>{m.safeForTopLine ? "yes" : "no"}</td>
                <td><span style={{ display: "inline-block", maxWidth: 420, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sourceText(m)}</span></td>
                <td>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button type="button" onClick={() => setOpen((prev) => ({ ...prev, [m.id]: !prev[m.id] }))} style={{ fontSize: 12, padding: "3px 8px" }}>
                      {open[m.id] ? "Hide" : "Expand"}
                    </button>
                    <button type="button" onClick={() => copySource(m)} style={{ fontSize: 12, padding: "3px 8px" }}>
                      {copied === m.id ? "Copied" : "Copy source"}
                    </button>
                  </div>
                </td>
              </tr>
              {open[m.id] ? (
                <tr key={`${m.id}:detail`}>
                  <td colSpan={7}>
                    <div style={{ whiteSpace: "normal", display: "grid", gap: 8 }}>
                      <ResponsiveGrid min={190}>
                        <KeyValue k="Pipeline" v={pipelineLabel(m.pipeline)} />
                        <KeyValue k="Pipeline ID" v={m.pipeline} />
                        <KeyValue k="Lane" v={plainText(m.lane)} />
                        <KeyValue k="Window" v={m.timeWindow} />
                        <KeyValue k="Confidence" v={m.confidence} tone={toneForConfidence(m.confidence)} />
                        <KeyValue k="Freshness" v={m.freshness} />
                      </ResponsiveGrid>
                      <p style={{ margin: 0, fontSize: 12 }}>{m.meaning}</p>
                      <p style={{ margin: 0, fontSize: 12, opacity: 0.78 }}>{m.whyItMatters}</p>
                      <p style={{ margin: 0, fontSize: 12, opacity: 0.72 }}>Source: {sourceText(m)}</p>
                      {invalidMetricReason(m) ? <p style={{ margin: 0, fontSize: 12, color: "var(--warn)" }}>Limit: {invalidMetricReason(m)}</p> : null}
                    </div>
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ValidationDetails({ diagnostic, summary }: { diagnostic: any; summary: string }) {
  if (!diagnostic) return null;
  return (
    <DetailsDisclosure summary={summary}>
      <ResponsiveGrid min={180}>
        <KeyValue k="Stage" v={diagnostic.validationStage ?? "n/a"} />
        <KeyValue k="Validator" v={diagnostic.validatorName ?? "n/a"} />
        <KeyValue k="Field" v={diagnostic.failingField ?? "n/a"} />
        <KeyValue k="Retries" v={diagnostic.retryCount ?? diagnostic.attempts ?? "n/a"} />
      </ResponsiveGrid>
      <pre style={{ whiteSpace: "pre-wrap", fontSize: 11, maxHeight: 220, overflow: "auto" }}>
        {JSON.stringify(diagnostic, null, 2)}
      </pre>
    </DetailsDisclosure>
  );
}

export default function AiAdvisoryPage() {
  const [tab, setTab] = useState<Tab>("OVERVIEW");
  const [report, setReport] = useState<any>(null);
  const [overview, setOverview] = useState<any>(null);
  const [recommendations, setRecommendations] = useState<any[]>([]);
  const [cursorPrompt, setCursorPrompt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryingKey, setRetryingKey] = useState<string | null>(null);
  const [retryMessage, setRetryMessage] = useState<{ key: string; text: string; ok: boolean } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const findings = await apiFetchJson<FindingsResponse>("/api/ai/findings/latest");
    if (!findings.ok) {
      const { title, detail } = describeApiLoadFailure(findings);
      setError(`${title}: ${detail}`);
      setLoading(false);
      return;
    }
    setReport(findings.data?.report ?? null);
    setError(null);
    setLoading(false);

    const ov = await apiFetchJson<OverviewResponse>("/api/ai");
    if (ov.ok) setOverview(ov.data?.overview ?? null);
    const recs = await apiFetchJson<{ recommendations?: any[] }>("/api/ai/recommendations");
    if (recs.ok) setRecommendations(recs.data?.recommendations ?? []);
  }, []);

  const exportCursorPrompt = useCallback(async (id: number) => {
    const result = await apiFetchJson<{ cursorPrompt?: string }>(`/api/ai/recommendations?id=${id}&export=cursor`);
    if (result.ok) setCursorPrompt(result.data?.cursorPrompt ?? null);
  }, []);

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
      const parsed = await parseApiJsonResponse(res, "/api/ai");
      if (!parsed.ok) {
        const { detail } = describeApiLoadFailure(parsed);
        setRetryMessage({ key, text: detail, ok: false });
        return;
      }
      setRetryMessage({ key, text: "Retry started successfully.", ok: true });
      await load();
    } finally {
      setRetryingKey(null);
    }
  }, [load]);

  useEffect(() => {
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, [load]);

  const rows = report?.metrics ?? [];
  const nightlyHistory = overview?.nightlyHistory ?? [];
  const weeklyHistory = overview?.weeklyHistory ?? [];
  const failures = overview?.jobFailures ?? [];
  const cost = overview?.cost;

  const findingCols: Column<any>[] = [
    { key: "title", header: "Finding", render: (f) => f.title },
    { key: "kind", header: "Kind", render: (f) => <StatusBadge tone="muted">{f.classification}</StatusBadge> },
    { key: "pipe", header: "Pipeline", render: (f) => f.pipeline },
    { key: "conf", header: "Confidence", render: (f) => <StatusBadge tone={toneForConfidence(f.confidence)}>{f.confidence}</StatusBadge> },
    { key: "summary", header: "Plain English", render: (f) => <span style={{ fontSize: 12 }}>{f.summary}</span> },
  ];
  const fixCols: Column<any>[] = [
    { key: "status", header: "Status", render: (f) => <StatusBadge tone={f.status === "DATA_BUG" ? "bear" : "warn"}>{f.status}</StatusBadge> },
    { key: "finding", header: "Finding", render: (f) => plainText(f.title) },
    { key: "evidence", header: "Evidence", render: (f) => <span style={{ fontSize: 12 }}>{f.evidenceWindow}; sample {fmtNum(f.sampleSize)}</span> },
    { key: "experiment", header: "Proposed experiment", render: (f) => <span style={{ fontSize: 12 }}>{plainText(f.proposedBehavior)}</span> },
    { key: "risk", header: "Risk", render: (f) => <span style={{ fontSize: 12 }}>{f.rollbackPlan}</span> },
    { key: "approval", header: "Human approval", render: (f) => <StatusBadge tone="warn">{f.humanApprovalStatus}</StatusBadge> },
  ];
  const metricCols: Column<any>[] = [
    { key: "metric", header: "Metric", render: (m) => m.label },
    { key: "value", header: "Value", render: (m) => fmtNum(m.value, m.unit) },
    { key: "quality", header: "Quality", render: (m) => <StatusBadge tone={toneForQuality(m.qualityStatus)}>{m.qualityStatus}</StatusBadge> },
    { key: "sample", header: "Sample", render: (m) => fmtNum(m.sampleSize) },
    { key: "top", header: "Top-line", render: (m) => m.safeForTopLine ? "yes" : "no" },
    { key: "source", header: "Source", render: (m) => <span style={{ fontSize: 12 }}>{m.source?.table} / {m.source?.field}</span> },
  ];
  const priorityFix = (report?.fixQueue ?? []).find((f: any) => f.status === "DATA_BUG" || /latency|timestamp/i.test(f.findingId + f.title))
    ?? report?.fixQueue?.[0]
    ?? null;
  const priorityFinding = priorityFix
    ? [...(report?.dataQualityFindings ?? []), ...(report?.failingFindings ?? []), ...(report?.topFindings ?? [])].find((f: any) => f.id === priorityFix.findingId)
    : report?.recommendedInvestigations?.[0] ?? null;
  const priorityEvidenceSize = priorityFix?.sampleSize
    ?? rows.find((m: any) => priorityFinding?.metricIds?.includes(m.id))?.sampleSize
    ?? "n/a";

  if (error && !report) return <PageContainer><ErrorState title="AI Advisory unavailable" detail={error} onRetry={load} /></PageContainer>;
  if (loading && !report) return <PageContainer><Card title="Loading AI Advisory"><LoadingState rows={5} /></Card></PageContainer>;

  return (
    <PageContainer>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: "7px 11px",
              borderRadius: 8,
              border: "1px solid rgba(148,163,184,.28)",
              background: tab === t ? "rgba(52,211,153,.18)" : "transparent",
              color: "inherit",
              fontSize: 12,
              fontWeight: 800,
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "OVERVIEW" && (
        <>
          <Card title="Overview" meta={`Canonical findings report ${report?.reportId ?? "n/a"}`}>
            <ResponsiveGrid min={180}>
              <KeyValue k="State" v={report?.overallState ?? "n/a"} tone={report?.overallState?.includes("DATA") ? "bear" : "warn"} />
              <KeyValue k="Confidence" v={report?.overallConfidence ?? "LOW"} tone={toneForConfidence(report?.overallConfidence)} />
              <KeyValue k="Active pipeline" v={pipelineLabel(report?.activeProductionPipeline)} />
              <KeyValue k="Trading day" v={report?.tradingDay ?? "n/a"} />
              <KeyValue k="Generated" v={fmtTime(report?.generatedAtMs)} />
              <KeyValue k="AI narrative" v={report?.narrative?.status ?? "n/a"} tone={report?.narrative?.status === "OK" ? "bull" : "warn"} />
              <KeyValue k="Production behavior changed" v={report?.safety?.productionBehaviorChanged ? "YES" : "NO"} tone="bull" />
              <KeyValue k="AI authority" v={report?.safety?.aiAuthority === "ADVISORY_ONLY" ? "ADVISORY ONLY" : report?.safety?.aiAuthority ?? "n/a"} tone="bull" />
            </ResponsiveGrid>
            <p style={{ fontSize: 12, marginTop: 10, opacity: 0.78 }}>{report?.narrative?.message}</p>
          </Card>

          <Card
            title="NEXT BEST INVESTIGATION"
            meta="Prioritized before strategy changes"
            tone={issueType(priorityFix ?? priorityFinding) === "Data bug" ? "warn" : "neutral"}
          >
            {priorityFix || priorityFinding ? (
              <div style={{ display: "grid", gap: 10 }}>
                <ResponsiveGrid min={190}>
                  <KeyValue k="Issue" v={plainText(priorityFix?.title ?? priorityFinding?.title)} />
                  <KeyValue k="Type" v={issueType(priorityFix ?? priorityFinding)} />
                  <KeyValue k="Confidence" v={priorityFinding?.confidence ?? "n/a"} tone={toneForConfidence(priorityFinding?.confidence)} />
                  <KeyValue k="Evidence size" v={fmtNum(priorityEvidenceSize)} />
                </ResponsiveGrid>
                <p style={{ margin: 0, fontSize: 13 }}>{plainText(priorityFix?.explanation ?? priorityFinding?.summary)}</p>
                <p style={{ margin: 0, fontSize: 12, opacity: 0.76 }}>Safe next step: {plainText(priorityFix?.proposedBehavior ?? priorityFinding?.recommendedNextStep ?? "Review evidence; do not change production rules automatically.")}</p>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button type="button" onClick={() => setTab("FINDINGS")} style={{ fontSize: 12, padding: "5px 10px", fontWeight: 800 }}>View evidence</button>
                  <button type="button" onClick={() => setCursorPrompt(createFixPrompt(priorityFix, priorityFinding))} style={{ fontSize: 12, padding: "5px 10px", fontWeight: 800 }}>Create fix prompt</button>
                </div>
                {cursorPrompt ? (
                  <DetailsDisclosure summary="Fix prompt preview (text only - does not modify code)">
                    <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{cursorPrompt}</pre>
                  </DetailsDisclosure>
                ) : null}
              </div>
            ) : <EmptyState title="No priority investigation" reason="No canonical findings require investigation." />}
          </Card>

          <ResponsiveGrid min={320}>
            <Card title="Top Findings" meta="Highest priority facts and data warnings">
              <FindingList rows={(report?.topFindings ?? []).slice(0, 3)} metrics={rows} dateWindow={report?.tradingDay} empty="No top findings" />
            </Card>
            <Card title="Recommended Investigation" meta="Human-reviewed, no automatic changes">
              <FindingList rows={(report?.recommendedInvestigations ?? []).slice(0, 1)} metrics={rows} dateWindow={report?.tradingDay} empty="No recommended investigation" />
            </Card>
          </ResponsiveGrid>

          <Card title="Top-Line Metrics" meta="Canonical, source-labeled, quality scored">
            <MetricsGrid
              metrics={rows}
              ids={["paper.win_rate", "paper.avg_return_pct", "missed.unique_opportunities", "timing.discovery_delay_ms", "independent.ready_to_sent", "paper.profit_factor"]}
            />
          </Card>

          <Card title="Data Quality Warnings" meta="Values not safe for top-line decisions">
            <FindingList rows={(report?.dataQualityFindings ?? []).slice(0, 3)} metrics={rows} dateWindow={report?.tradingDay} empty="No data quality warnings" />
          </Card>
        </>
      )}

      {tab === "CHAT" && (
        <Card title="Chat" meta="Grounded in the canonical findings report">
          <AdvisoryChat />
        </Card>
      )}

      {tab === "FINDINGS" && (
        <>
          <ResponsiveGrid min={340}>
            <Card title="What Is Working"><FindingList rows={report?.workingFindings ?? []} metrics={rows} dateWindow={report?.tradingDay} empty="No working findings" /></Card>
            <Card title="What Is Failing"><FindingList rows={report?.failingFindings ?? []} metrics={rows} dateWindow={report?.tradingDay} empty="No failing findings" /></Card>
          </ResponsiveGrid>
          <Card title="Missed Opportunities" meta="Unique opportunity counts lead; raw observations stay diagnostic">
            <MetricsGrid
              metrics={rows}
              ids={["missed.unique_opportunities", "missed.unique_meaningful_misses", "missed.raw_observations", "missed.repeated_scans", "missed.late_discoveries"]}
            />
            <DetailsDisclosure summary="Example fingerprints">
              <SimpleTable
                columns={[
                  { key: "symbol", header: "Symbol", render: (r: any) => r.symbol },
                  { key: "count", header: "Raw scans", render: (r: any) => r.count },
                  { key: "quality", header: "Quality", render: (r: any) => <StatusBadge tone={toneForQuality(r.qualityStatus)}>{r.qualityStatus}</StatusBadge> },
                  { key: "reason", header: "Reason", render: (r: any) => r.reason },
                ]}
                rows={report?.missedOpportunities?.examples ?? []}
                rowKey={(r: any) => r.fingerprint}
                emptyTitle="No examples"
                emptyReason="No missed opportunity rows were available."
              />
            </DetailsDisclosure>
          </Card>
          <ResponsiveGrid min={340}>
            <Card title="Timing">
              <SimpleTable columns={metricCols} rows={(report?.timingFindings ?? []).map((t: any) => t.metric)} rowKey={(m) => m.id} emptyTitle="No timing metrics" emptyReason="" />
            </Card>
            <Card title="Calls vs Puts">
              <ResponsiveGrid min={160}>
                {["call", "put"].map((side) => {
                  const s = report?.callsVsPuts?.[side];
                  return (
                    <div key={side} style={{ border: "1px solid rgba(148,163,184,.22)", borderRadius: 8, padding: 10 }}>
                      <strong>{String(side).toUpperCase()}</strong>
                      <KeyValue k="Status" v={s?.status ?? "NO_DATA"} tone={s?.status === "VALID" ? "bull" : "muted"} />
                      <KeyValue k="Sample" v={fmtNum(s?.sampleSize)} />
                      <KeyValue k="Win rate" v={fmtNum(s?.winRate, "%")} />
                      <KeyValue k="Avg return" v={fmtNum(s?.avgReturnPct, "%")} />
                    </div>
                  );
                })}
              </ResponsiveGrid>
              <p style={{ fontSize: 12, opacity: 0.72 }}>Comparison: {report?.callsVsPuts?.comparison ?? "NO_VALID_COMPARISON"}</p>
            </Card>
          </ResponsiveGrid>
          <ResponsiveGrid min={340}>
            <Card title="Entries"><FindingList rows={report?.entryFindings ?? []} metrics={rows} dateWindow={report?.tradingDay} empty="No entry findings" /></Card>
            <Card title="Exits"><FindingList rows={report?.exitFindings ?? []} metrics={rows} dateWindow={report?.tradingDay} empty="No exit findings" /></Card>
            <Card title="Discord"><FindingList rows={report?.discordFindings ?? []} metrics={rows} dateWindow={report?.tradingDay} empty="No Discord findings" /></Card>
            <Card title="Paper"><FindingList rows={report?.paperFindings ?? []} metrics={rows} dateWindow={report?.tradingDay} empty="No paper findings" /></Card>
          </ResponsiveGrid>
        </>
      )}

      {tab === "EXPERIMENTS" && (
        <>
          <Card title="Fix Queue" meta="Advisory only; no live code changes are applied">
            <SimpleTable columns={fixCols} rows={report?.fixQueue ?? []} rowKey={(r) => r.findingId} emptyTitle="No fix queue items" emptyReason="No canonical findings require a fix yet." />
          </Card>
          <Card title="AI Recommendations Workflow" meta={`${recommendations.length} tracked; export-only prompts`}>
            {recommendations.length === 0 ? (
              <EmptyState
                title="No recommendations yet"
                reason="No live changes are active. Recommendations appear only after sufficient evidence; approved experiments still require shadow testing and nothing applies automatically."
              />
            ) : (
              <SimpleTable
                columns={[
                  { key: "title", header: "Title", render: (r: any) => r.title },
                  { key: "status", header: "Workflow", render: (r: any) => r.workflowStatus ?? r.status },
                  { key: "packet", header: "Evidence", render: (r: any) => r.evidencePacketId ?? "n/a" },
                  { key: "export", header: "Export", render: (r: any) => <button onClick={() => exportCursorPrompt(r.id)} style={{ fontSize: 12, padding: "3px 8px" }}>Export Cursor Prompt</button> },
                ]}
                rows={recommendations.slice(0, 20)}
                rowKey={(r: any) => String(r.id)}
                emptyTitle="No recommendations"
                emptyReason=""
              />
            )}
            {cursorPrompt && (
              <DetailsDisclosure summary="Exported Cursor prompt (copy only - no repo edits)">
                <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, maxHeight: 320, overflow: "auto" }}>{cursorPrompt}</pre>
              </DetailsDisclosure>
            )}
          </Card>
        </>
      )}

      {tab === "REPORTS" && (
        <ResponsiveGrid min={360}>
          <Card title="Nightly Reports" meta={`${nightlyHistory.length} reports`}>
            <SimpleTable
              columns={[
                { key: "period", header: "Period", render: (r: any) => <Link href={`/ai/reports/${r.reportType}:${r.id}`}>{r.periodKey}</Link> },
                { key: "status", header: "Narrative", render: (r: any) => <StatusBadge tone={r.narrativeStatus === "OK" ? "bull" : "warn"}>{r.narrativeStatus}</StatusBadge> },
                { key: "issue", header: "Prior issue", render: (r: any) => r.summary?.prioritizedIssue === "options_delivery_disabled" ? "Historical issue · inactive supervisor pipeline" : r.summary?.prioritizedIssue ?? dash },
                {
                  key: "retry", header: "Action", render: (r: any) => {
                    const retryable = RETRYABLE_NIGHTLY_STATUSES.has(String(r.narrativeStatus));
                    if (!retryable) return <span style={{ fontSize: 12, opacity: 0.55 }}>{dash}</span>;
                    const hasReportId = Number.isFinite(Number(r.id));
                    const key = hasReportId ? `id:${Number(r.id)}` : `period:${String(r?.periodKey ?? "")}`;
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
                { key: "diagnostic", header: "Diagnostics", render: (r: any) => <ValidationDetails diagnostic={r.diagnostic} summary="Structured validation diagnostic" /> },
                { key: "at", header: "Created", render: (r: any) => fmtTime(r.createdAtMs) },
              ]}
              rows={nightlyHistory.slice(0, 20)}
              rowKey={(r: any) => String(r.id)}
              emptyTitle="No nightly reports"
              emptyReason="Reports appear after the nightly job runs."
            />
          </Card>
          <Card title="Weekly Reports" meta={`${weeklyHistory.length} reports`}>
            <SimpleTable
              columns={[
                { key: "period", header: "Period", render: (r: any) => <Link href={`/ai/reports/${r.reportType}:${r.id}`}>{r.periodKey}</Link> },
                { key: "status", header: "Narrative", render: (r: any) => <StatusBadge tone={r.narrativeStatus === "OK" ? "bull" : "warn"}>{r.narrativeStatus}</StatusBadge> },
                { key: "at", header: "Created", render: (r: any) => fmtTime(r.createdAtMs) },
              ]}
              rows={weeklyHistory.slice(0, 20)}
              rowKey={(r: any) => String(r.id)}
              emptyTitle="No weekly reports"
              emptyReason="Weekly proposals run Friday night / Saturday."
            />
          </Card>
        </ResponsiveGrid>
      )}

      {tab === "ADVANCED" && (
        <>
          <Card title="Metric Registry" meta="Every canonical metric has pipeline, source, quality, and top-line safety">
            <MetricRegistry rows={rows} />
          </Card>
          <Card title="Research Question Registry" meta="Explicit question-to-rule mapping">
            <SimpleTable
              columns={[
                { key: "id", header: "ID", render: (r: any) => r.id },
                { key: "question", header: "Question", render: (r: any) => r.question },
                { key: "pipeline", header: "Pipeline", render: (r: any) => r.pipeline },
                { key: "rule", header: "Rule", render: (r: any) => <span style={{ fontSize: 12 }}>{r.exactRule}</span> },
                { key: "n", header: "Min n", render: (r: any) => r.minimumSample },
              ]}
              rows={report?.researchQuestionRegistry ?? []}
              rowKey={(r: any) => r.id}
              emptyTitle="No registry rows"
              emptyReason=""
            />
          </Card>
          <ResponsiveGrid min={300}>
            <Card title="AI Cost" meta="Advisory jobs only">
              <KeyValue k="Month" v={cost?.monthKey ?? "n/a"} />
              <KeyValue k="Spend" v={fmtNum(cost?.spendUsd, " USD")} />
              <KeyValue k="Input tokens" v={fmtNum(cost?.inputTokens)} />
              <KeyValue k="Output tokens" v={fmtNum(cost?.outputTokens)} />
            </Card>
            <Card title="Job Failures" meta={`${failures.length} recent`}>
              <SimpleTable
                columns={[
                  { key: "job", header: "Job", render: (f: any) => f.job_type },
                  { key: "status", header: "Status", render: (f: any) => <StatusBadge tone="bear">{f.status}</StatusBadge> },
                  { key: "err", header: "Error", render: (f: any) => <span style={{ fontSize: 12 }}>{f.error ?? "n/a"}</span> },
                ]}
                rows={failures}
                rowKey={(f: any) => String(f.id)}
                emptyTitle="No failures"
                emptyReason="No recent AI job failures."
              />
            </Card>
          </ResponsiveGrid>
        </>
      )}
    </PageContainer>
  );
}
