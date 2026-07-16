"use client";

import { useCallback, useEffect, useState } from "react";
import {
  PageContainer, ResponsiveGrid, Card, KeyValue, StatusBadge, LoadingState, ErrorState, EmptyState, DetailsDisclosure,
} from "@/components/ui/Shell";
import { SimpleTable, type Column } from "@/components/ui/Table";
import { scanHeaders } from "@/hooks/useScanner";

/**
 * AI Lab (private). Read surface for the advisory AI layer: enablement, schedule,
 * run history, cost + tokens, the latest nightly diagnosis, weekly proposals,
 * lessons, and job failures. Nothing here edits code, merges, deploys, or trades.
 * The Anthropic API key is never exposed (only its presence).
 */

type Overview = {
  flags?: Record<string, any>;
  schedule?: Record<string, any>;
  runs?: Record<string, any>;
  cost?: {
    spendUsd: number; softLimitUsd: number; hardLimitUsd: number;
    atSoftLimit: boolean; atHardLimit: boolean; monthKey: string;
    inputTokens?: number; outputTokens?: number;
  };
  latestNightly?: any;
  nightlyHistory?: any[];
  weeklyHistory?: any[];
  lessons?: any[];
  proposals?: { pending: any[]; accepted: any[]; rejected: any[] };
  jobFailures?: any[];
};

const fmtTime = (ms?: number | null) =>
  ms ? new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) + " ET" : "—";
const fmtNum = (n?: number | null) => (typeof n === "number" ? n.toLocaleString() : "—");

const fmtDiag = (v: any) => {
  if (v == null || v === "") return "n/a";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
};

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

export default function AiLabPage() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/ai", { cache: "no-store", headers: scanHeaders() });
      if (res.status === 401) { setError("Not authorized — AI Lab is private. Provide the scan API token."); setOv(null); return; }
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

  const retryNightly = useCallback(async (reportId: number) => {
    setBusy(true);
    try {
      await fetch("/api/ai", { method: "POST", headers: { ...scanHeaders(), "content-type": "application/json" }, body: JSON.stringify({ action: "retry_nightly_narrative", reportId }) });
      await load();
    } finally { setBusy(false); }
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

  const disabled = !flags.enabled;

  const proposalCols: Column<any>[] = [
    { key: "title", header: "Proposal", render: (p) => p.title },
    { key: "strat", header: "Strategy", render: (p) => p.affectedStrategy ?? "—" },
    { key: "conf", header: "Confidence", render: (p) => <StatusBadge tone={p.confidence === "HIGH" ? "bull" : p.confidence === "MEDIUM" ? "warn" : "muted"}>{p.confidence}</StatusBadge> },
    { key: "level", header: "Change", render: (p) => p.changeLevel ?? "—" },
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
    { key: "issue", header: "Top issue", render: (r) => r.summary?.prioritizedIssue ?? "—" },
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
    { key: "cat", header: "Category", render: (f) => f.error_category ?? "—" },
    { key: "err", header: "Error", render: (f) => <span style={{ fontSize: 12, opacity: 0.85 }}>{f.error ?? "—"}</span> },
    { key: "validator", header: "Validator", render: (f) => f.diagnostic?.validatorName ?? "n/a" },
    { key: "field", header: "Field", render: (f) => f.diagnostic?.failingField ?? "n/a" },
    { key: "details", header: "Details", render: (f) => <ValidationDetails diagnostic={f.diagnostic} summary="Validation diagnostic" /> },
    { key: "at", header: "When", render: (f) => fmtTime(f.created_at_ms) },
  ];

  return (
    <PageContainer>
      {disabled && (
        <Card title="AI is OFF" meta="Advisory layer — safe default">
          <p style={{ fontSize: 13, margin: "0 0 6px" }}>
            The advisory AI is disabled. It never trades, edits code, or changes callouts — it only
            reads stored data and writes a diagnosis you approve.
          </p>
          <p style={{ fontSize: 12, opacity: 0.8, margin: 0 }}>
            To enable: set <code>AI_ENABLED=1</code>, <code>ANTHROPIC_API_KEY</code>, and{" "}
            <code>AI_NIGHTLY_DIAGNOSIS_ENABLED=1</code> (and <code>AI_WEEKLY_PROPOSALS_ENABLED=1</code>) in Railway.
            {!flags.hasApiKey && " An Anthropic API key is currently missing."}
          </p>
        </Card>
      )}

      <ResponsiveGrid min={240}>
        <Card title="Status" meta="Off by default — advisory, scheduled, human-approved">
          <KeyValue k="AI enabled" v={flags.enabled ? "yes" : "no"} tone={flags.enabled ? "bull" : "muted"} />
          <KeyValue k="Anthropic API key" v={flags.hasApiKey ? "configured" : "missing"} tone={flags.hasApiKey ? "bull" : "bear"} />
          <KeyValue k="Nightly diagnosis" v={flags.nightlyDiagnosisEnabled ? "on" : "off"} tone={flags.nightlyDiagnosisEnabled ? "bull" : "muted"} />
          <KeyValue k="Weekly proposals" v={flags.weeklyProposalsEnabled ? "on" : "off"} tone={flags.weeklyProposalsEnabled ? "bull" : "muted"} />
          <KeyValue k="Nightly recap" v={flags.recapEnabled ? "on" : "off"} tone={flags.recapEnabled ? "bull" : "muted"} />
        </Card>

        <Card title="Schedule & runs" meta="America/New_York">
          <KeyValue k="Last job run" v={`${fmtTime(runs.lastRunAtMs)}${runs.lastRunType ? ` · ${runs.lastRunType} (${runs.lastRunStatus})` : ""}`} />
          <KeyValue k="Last success" v={fmtTime(runs.lastSuccessAtMs)} tone={runs.lastSuccessAtMs ? "bull" : "muted"} />
          <KeyValue k="Last failure" v={runs.lastFailureAtMs ? `${fmtTime(runs.lastFailureAtMs)} · ${runs.lastFailureType}` : "none"} tone={runs.lastFailureAtMs ? "bear" : "bull"} />
          <KeyValue k="Next nightly" v={`${fmtTime(schedule.nextNightlyEligibleMs)}${schedule.nightlyDueNow ? " · DUE NOW" : ""}`} />
          <KeyValue k="Next weekly" v={`${fmtTime(schedule.nextWeeklyEligibleMs)}${schedule.weeklyDueNow ? " · DUE NOW" : ""}`} />
          <KeyValue k="Last nightly report" v={schedule.lastNightlyDay ? `${schedule.lastNightlyDay} (${schedule.lastNightlyStatus})` : "none yet"} />
        </Card>

        <Card title="Models & cost" meta={cost?.monthKey ?? ""}>
          <KeyValue k="Nightly model" v={flags.nightlyModel ?? "—"} />
          <KeyValue k="Weekly model" v={flags.weeklyModel ?? "—"} />
          <KeyValue k="Input tokens (mo)" v={fmtNum(cost?.inputTokens)} />
          <KeyValue k="Output tokens (mo)" v={fmtNum(cost?.outputTokens)} />
          <KeyValue k="Estimated spend" v={`$${(cost?.spendUsd ?? 0).toFixed(4)}`} tone={cost?.atHardLimit ? "bear" : cost?.atSoftLimit ? "warn" : "bull"} />
          <KeyValue k="Soft / hard limit" v={`$${cost?.softLimitUsd ?? 0} / $${cost?.hardLimitUsd ?? 0}`} />
          <KeyValue k="Budget" v={cost?.atHardLimit ? "HARD LIMIT — optional AI skipped" : cost?.atSoftLimit ? "soft limit reached" : "within budget"} tone={cost?.atHardLimit ? "bear" : cost?.atSoftLimit ? "warn" : "bull"} />
        </Card>
      </ResponsiveGrid>

      <Card title="Latest nightly diagnosis" meta={nightly?.periodKey ? `${nightly.periodKey} · ${nightly.narrativeStatus}` : "no report yet"}>
        {!nightly ? (
          <EmptyState title="No nightly report yet" reason={disabled ? "Enable the AI layer to generate nightly diagnoses." : "The nightly job runs after 20:15 ET on trading weekdays."} />
        ) : (
          <>
            <ResponsiveGrid min={180}>
              <KeyValue k="Prioritized issue" v={nightly.summary?.prioritizedIssue ?? "—"} tone={nightly.summary?.prioritizedIssue ? "warn" : "muted"} />
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
                    {narrative.repeatedPatterns.map((s: string, i: number) => <p key={i} style={{ fontSize: 12, margin: "2px 0" }}>• {s}</p>)}
                  </div>
                )}
              </div>
            ) : (
              <p style={{ fontSize: 12, opacity: 0.75, marginTop: 8 }}>
                Deterministic summary stored; narrative status: <strong>{nightly.narrativeStatus}</strong>
                {nightly.narrativeStatus === "SKIPPED" && " (AI narration disabled or over budget — the numbers above are still real)."}
              </p>
            )}
            {!narrative && ["VALIDATION_FAILED", "ERROR", "SKIPPED"].includes(String(nightly.narrativeStatus)) && (
              <button disabled={busy} onClick={() => retryNightly(Number(nightly.id))} style={{ fontSize: 12, padding: "4px 9px", marginTop: 6 }}>
                Retry narrative
              </button>
            )}
            {diagnostic && (
              <DetailsDisclosure summary="Narrative failure details">
                <ResponsiveGrid min={180}>
                  <KeyValue k="Provider" v={diagnostic.provider ?? "anthropic"} />
                  <KeyValue k="HTTP" v={diagnostic.httpStatus ?? "n/a"} />
                  <KeyValue k="Response type" v={diagnostic.responseType ?? "n/a"} />
                  <KeyValue k="Attempts" v={diagnostic.attempts ?? "n/a"} />
                  <KeyValue k="Stopped early" v={diagnostic.stoppedEarly ? "yes" : "no"} tone={diagnostic.stoppedEarly ? "warn" : "muted"} />
                  <KeyValue k="Markdown fences" v={diagnostic.markdownFenceStripped ? "stripped" : "no"} />
                </ResponsiveGrid>
                {Array.isArray(diagnostic.validationErrors) && diagnostic.validationErrors.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    {diagnostic.validationErrors.map((s: string, i: number) => <p key={i} style={{ fontSize: 12, margin: "2px 0" }}>{s}</p>)}
                  </div>
                )}
                {diagnostic.parseError && <p style={{ fontSize: 12, margin: "6px 0 0" }}>{diagnostic.parseError}</p>}
              </DetailsDisclosure>
            )}
            <ValidationDetails diagnostic={diagnostic} summary="Structured validation diagnostic" />
            {Array.isArray(nightly.summary?.patterns) && nightly.summary.patterns.length > 0 && (
              <DetailsDisclosure summary="Deterministic patterns">
                {nightly.summary.patterns.map((s: string, i: number) => <p key={i} style={{ fontSize: 12, margin: "2px 0" }}>• {s}</p>)}
              </DetailsDisclosure>
            )}
          </>
        )}
      </Card>

      <ResponsiveGrid min={320}>
        <Card title="Latest weekly proposal" meta={latestWeekly?.periodKey ?? "no weekly report yet"}>
          {!latestWeekly ? (
            <EmptyState title="No weekly report yet" reason="The weekly job runs Friday ≥21:00 ET / Saturday." />
          ) : (
            <>
              <KeyValue k="Narrative" v={latestWeekly.narrativeStatus} />
              <KeyValue k="Created" v={fmtTime(latestWeekly.createdAtMs)} />
              {latestWeekly.narrative?.headline && <p style={{ fontSize: 13, marginTop: 6 }}>{latestWeekly.narrative.headline}</p>}
              <ValidationDetails diagnostic={latestWeekly.diagnostic} summary="Weekly failure details" />
            </>
          )}
        </Card>
        <Card title="Nightly report history" meta={`${nightlyHistory.length} reports`}>
          <SimpleTable columns={historyCols} rows={nightlyHistory.slice(0, 15)} rowKey={(r) => String(r.id)} emptyTitle="No reports yet" emptyReason="Reports appear after the nightly job runs." />
        </Card>
      </ResponsiveGrid>

      <Card title="Proposals" meta={`${pending.length} pending · ${accepted.length} accepted · ${rejected.length} rejected`}>
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
