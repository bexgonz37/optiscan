"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { PageContainer, ResponsiveGrid, Card, KeyValue, StatusBadge, LoadingState, ErrorState, EmptyState, DetailsDisclosure } from "@/components/ui/Shell";
import { apiFetchJson, describeApiLoadFailure } from "@/lib/client-auth";

const fmtNum = (n: any, unit = "") => {
  if (n == null || n === "") return "n/a";
  if (typeof n === "number") return `${Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1)}${unit ? ` ${unit}` : ""}`;
  return String(n);
};

const fmtTime = (ms?: number | null) =>
  ms ? `${new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} ET` : "-";

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
  return ({
    INDEPENDENT_OPTIONS: "Active options scanner",
    DELIVERED_ALERT_PAPER: "Verified delivered options",
    STOCK_MOMENTUM: "Stock momentum scanner",
    SUPERVISOR_OPTIONS: "Inactive legacy options pipeline",
    ZERO_DTE_RESEARCH: "0DTE research lane",
    SHADOW_REPLAY: "Shadow replay",
    LEGACY_AUDIT: "Legacy audit",
  } as Record<string, string>)[p] ?? p ?? "Unknown pipeline";
}

function plainText(s: any): string {
  return String(s ?? "")
    .replace(/midday_1100_1400/g, "11:00 a.m.-2:00 p.m. ET")
    .replace(/Independent READY -> SENT cohort is linked/g, "Qualified setups that became alerts are linked")
    .replace(/READY -> SENT linked cohort/g, "Qualified setups that became alerts");
}

function priorIssueLabel(report: any): string {
  const text = `${report?.dataQualityFindings?.map((f: any) => f.title).join(" ")} ${report?.sourceReferences?.join(" ")}`;
  if (/Inactive supervisor delivery/i.test(text)) return "Historical issue · inactive supervisor pipeline";
  return "No historical inactive-pipeline issue shown";
}

function FindingCard({ f, metrics }: { f: any; metrics: any[] }) {
  const affected = metrics.filter((m) => f.metricIds?.includes(m.id));
  return (
    <div style={{ border: "1px solid rgba(148,163,184,.22)", borderRadius: 8, padding: 12, display: "grid", gap: 7 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong>{plainText(f.title)}</strong>
        <StatusBadge tone={f.severity === "critical" ? "bear" : f.severity === "warning" ? "warn" : f.severity === "positive" ? "bull" : "muted"}>{f.classification}</StatusBadge>
        <StatusBadge tone={toneForConfidence(f.confidence)}>{f.confidence}</StatusBadge>
        <span style={{ fontSize: 11, opacity: 0.72 }}>{pipelineLabel(f.pipeline)}</span>
      </div>
      <p style={{ margin: 0, fontSize: 13 }}>{plainText(f.summary)}</p>
      <DetailsDisclosure summary="View evidence">
        <ResponsiveGrid min={230}>
          <KeyValue k="Pipeline ID" v={f.pipeline} />
          <KeyValue k="Source records" v={(f.sourceRefs ?? []).join(", ") || "n/a"} />
          <KeyValue k="Metrics" v={(f.metricIds ?? []).join(", ") || "n/a"} />
          <KeyValue k="Recommended investigation" v={plainText(f.recommendedNextStep ?? "n/a")} />
        </ResponsiveGrid>
        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
          {affected.length ? affected.map((m) => (
            <div key={m.id} style={{ border: "1px solid rgba(148,163,184,.18)", borderRadius: 8, padding: 10 }}>
              <ResponsiveGrid min={170}>
                <KeyValue k="Metric" v={m.label} />
                <KeyValue k="Sample" v={fmtNum(m.sampleSize)} />
                <KeyValue k="Quality" v={<StatusBadge tone={toneForQuality(m.qualityStatus)}>{m.qualityStatus}</StatusBadge>} />
                <KeyValue k="Source" v={`${m.source?.table} / ${m.source?.function} / ${m.source?.field}`} />
              </ResponsiveGrid>
            </div>
          )) : <EmptyState title="No metric details" reason="This finding is supported by source records rather than a single metric." />}
        </div>
      </DetailsDisclosure>
    </div>
  );
}

export default function AiReportDetailPage() {
  const params = useParams<{ reportId: string }>();
  const reportId = decodeURIComponent(String(params?.reportId ?? ""));
  const [report, setReport] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await apiFetchJson<{ report?: any }>(`/api/ai/findings/${encodeURIComponent(reportId)}`);
    if (!res.ok) {
      const { title, detail } = describeApiLoadFailure(res);
      setError(`${title}: ${detail}`);
      setLoading(false);
      return;
    }
    setReport(res.data?.report ?? null);
    setError(null);
    setLoading(false);
  }, [reportId]);

  useEffect(() => { load(); }, [load]);

  if (error && !report) return <PageContainer><ErrorState title="AI report unavailable" detail={error} onRetry={load} /></PageContainer>;
  if (loading && !report) return <PageContainer><Card title="Loading report"><LoadingState rows={4} /></Card></PageContainer>;

  const metrics = report?.metrics ?? [];
  const topMetric = (id: string) => metrics.find((m: any) => m.id === id);

  return (
    <PageContainer>
      <div style={{ marginBottom: 12 }}><Link href="/ai">Back to AI Advisory</Link></div>
      <Card title="Canonical Report" meta={report?.reportId}>
        <ResponsiveGrid min={190}>
          <KeyValue k="Trading day/window" v={report?.tradingDay ?? "n/a"} />
          <KeyValue k="Generated" v={fmtTime(report?.generatedAtMs)} />
          <KeyValue k="Active issue" v={report?.overallState ?? "n/a"} tone={report?.overallState?.includes("DATA") ? "bear" : "warn"} />
          <KeyValue k="Confidence" v={report?.overallConfidence ?? "LOW"} tone={toneForConfidence(report?.overallConfidence)} />
          <KeyValue k="AI narrative status" v={report?.narrative?.status ?? "n/a"} tone={report?.narrative?.status === "OK" ? "bull" : "warn"} />
          <KeyValue k="Prior issue" v={priorIssueLabel(report)} />
          <KeyValue k="Production behavior changed" v={report?.safety?.productionBehaviorChanged ? "YES" : "NO"} tone="bull" />
          <KeyValue k="AI authority" v={report?.safety?.aiAuthority === "ADVISORY_ONLY" ? "ADVISORY ONLY" : report?.safety?.aiAuthority ?? "n/a"} tone="bull" />
        </ResponsiveGrid>
        <p style={{ marginTop: 10, fontSize: 12, opacity: 0.78 }}>{report?.narrative?.message}</p>
        <ResponsiveGrid min={190}>
          <KeyValue k="Win rate" v={fmtNum(topMetric("paper.win_rate")?.value, "%")} />
          <KeyValue k="Average return" v={fmtNum(topMetric("paper.avg_return_pct")?.value, "%")} />
          <KeyValue k="Unique misses" v={fmtNum(topMetric("missed.unique_opportunities")?.value)} />
          <KeyValue k="PUT comparison" v={report?.callsVsPuts?.put?.status ?? "NO_DATA"} />
        </ResponsiveGrid>
      </Card>

      <ResponsiveGrid min={360}>
        <Card title="Deterministic Findings" meta="Canonical facts and warnings">
          <div style={{ display: "grid", gap: 10 }}>
            {(report?.topFindings ?? []).map((f: any) => <FindingCard key={f.id} f={f} metrics={metrics} />)}
          </div>
        </Card>
        <Card title="Validation and Retry" meta="Narrative retry status only; deterministic report remains valid">
          <KeyValue k="AI narrative status" v={report?.narrative?.status ?? "n/a"} />
          <KeyValue k="Validation failures" v={(report?.dataQualityFindings ?? []).some((f: any) => f.id === "ai-validation-failures") ? "present" : "none shown"} />
          <KeyValue k="Retry result" v={report?.narrative?.status === "OK" ? "Latest narrative OK" : "Retry not run in this local review"} />
          <KeyValue k="Historical inactive pipeline label" v={priorIssueLabel(report)} />
        </Card>
      </ResponsiveGrid>
    </PageContainer>
  );
}
