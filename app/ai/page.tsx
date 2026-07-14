"use client";

import { useCallback, useEffect, useState } from "react";
import {
  PageContainer, ResponsiveGrid, Card, KeyValue, StatusBadge, LoadingState, ErrorState,
} from "@/components/ui/Shell";
import { SimpleTable, type Column } from "@/components/ui/Table";
import { scanHeaders } from "@/hooks/useScanner";

/**
 * AI Lab (private). Read surface for the advisory AI layer: feature flags, monthly
 * cost, the latest nightly diagnosis, lessons, and PENDING proposals with human
 * accept/reject. Nothing here edits code, merges, deploys, or trades.
 */

type Overview = {
  flags?: Record<string, any>;
  cost?: { spendUsd: number; softLimitUsd: number; hardLimitUsd: number; atSoftLimit: boolean; atHardLimit: boolean; monthKey: string };
  latestNightly?: any;
  lessons?: any[];
  proposals?: { pending: any[]; accepted: any[]; rejected: any[] };
  jobFailures?: any[];
};

export default function AiLabPage() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/ai", { cache: "no-store", headers: scanHeaders() }).then((x) => x.json());
      setOv(r?.overview ?? {});
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? "Could not load AI overview.");
    }
  }, []);

  const decide = useCallback(async (action: string, id: number, status: string) => {
    setBusy(true);
    try {
      await fetch("/api/ai", { method: "POST", headers: { ...scanHeaders(), "content-type": "application/json" }, body: JSON.stringify({ action, id, status }) });
      await load();
    } finally { setBusy(false); }
  }, [load]);

  useEffect(() => { load(); const id = setInterval(load, 60000); return () => clearInterval(id); }, [load]);

  if (error && !ov) return <PageContainer><ErrorState detail={error} onRetry={load} /></PageContainer>;
  if (!ov) return <PageContainer><Card title="Loading AI Lab"><LoadingState rows={4} /></Card></PageContainer>;

  const flags = ov.flags ?? {};
  const cost = ov.cost;
  const nightly = ov.latestNightly;
  const narrative = nightly?.narrative;
  const pending = ov.proposals?.pending ?? [];
  const lessons = ov.lessons ?? [];

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

  const lessonCols: Column<any>[] = [
    { key: "title", header: "Lesson", render: (l) => l.title },
    { key: "type", header: "Type", render: (l) => l.findingType },
    { key: "n", header: "Sample", render: (l) => l.sampleSize },
    { key: "conf", header: "Confidence", render: (l) => l.confidence },
    { key: "status", header: "Status", render: (l) => <StatusBadge tone={l.status === "ACCEPTED" ? "bull" : l.status === "REJECTED" ? "bear" : "muted"}>{l.status}</StatusBadge> },
  ];

  return (
    <PageContainer>
      <ResponsiveGrid min={240}>
        <Card title="AI feature flags" meta="Off by default — advisory, scheduled, human-approved">
          <KeyValue k="AI enabled" v={flags.enabled ? "yes" : "no"} tone={flags.enabled ? "bull" : undefined} />
          <KeyValue k="API key present" v={flags.hasApiKey ? "yes" : "no"} />
          <KeyValue k="Nightly diagnosis" v={flags.nightlyDiagnosisEnabled ? "on" : "off"} />
          <KeyValue k="Weekly proposals" v={flags.weeklyProposalsEnabled ? "on" : "off"} />
          <KeyValue k="Nightly model" v={flags.nightlyModel ?? "—"} />
          <KeyValue k="Weekly model" v={flags.weeklyModel ?? "—"} />
        </Card>
        <Card title="Monthly AI cost" meta={cost?.monthKey ?? ""}>
          <KeyValue k="Estimated spend" v={`$${(cost?.spendUsd ?? 0).toFixed(4)}`} tone={cost?.atHardLimit ? "bear" : cost?.atSoftLimit ? "warn" : "bull"} />
          <KeyValue k="Soft limit" v={`$${cost?.softLimitUsd ?? 0}`} />
          <KeyValue k="Hard limit" v={`$${cost?.hardLimitUsd ?? 0}`} />
          <KeyValue k="Status" v={cost?.atHardLimit ? "HARD LIMIT — optional AI skipped" : cost?.atSoftLimit ? "soft limit reached" : "within budget"} />
        </Card>
        <Card title="Latest nightly" meta={nightly?.periodKey ?? "no report yet"}>
          <KeyValue k="Narrative" v={nightly?.narrativeStatus ?? "—"} />
          <KeyValue k="Prioritized issue" v={nightly?.summary?.prioritizedIssue ?? "—"} />
          <KeyValue k="Graded outcomes" v={nightly?.summary?.counts?.outcomesGraded ?? 0} />
          <KeyValue k="Rejected" v={nightly?.summary?.counts?.rejected ?? 0} />
        </Card>
      </ResponsiveGrid>

      {narrative && (
        <Card title="Nightly diagnosis narrative" meta="Every number traces to the deterministic summary">
          <p style={{ fontWeight: 600, margin: "0 0 6px" }}>{narrative.headline}</p>
          <p style={{ fontSize: 13, opacity: 0.9 }}>{narrative.whatHappened}</p>
          {Array.isArray(narrative.repeatedPatterns) && narrative.repeatedPatterns.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <p style={{ fontSize: 12, opacity: 0.7, margin: "4px 0" }}>Repeated patterns</p>
              {narrative.repeatedPatterns.map((s: string, i: number) => <p key={i} style={{ fontSize: 12, margin: "2px 0" }}>• {s}</p>)}
            </div>
          )}
        </Card>
      )}

      <Card title="Pending proposals" meta="Advisory — a human accepts or rejects; nothing is applied automatically">
        <SimpleTable columns={proposalCols} rows={pending} rowKey={(p) => String(p.id)} emptyTitle="No pending proposals" emptyReason="The weekly job proposes changes on Friday night / Saturday." />
      </Card>

      <Card title="Lessons memory" meta="Deterministic, evidence-gated findings">
        <SimpleTable columns={lessonCols} rows={lessons} rowKey={(l) => String(l.id)} emptyTitle="No lessons yet" emptyReason="Nightly reports record lessons once evidence thresholds are met." />
      </Card>
    </PageContainer>
  );
}
