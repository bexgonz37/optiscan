"use client";

import { useCallback, useEffect, useState } from "react";
import {
  PageContainer, ResponsiveGrid, Card, KeyValue, StatusBadge, LoadingState, ErrorState,
} from "@/components/ui/Shell";
import { SimpleTable, type Column } from "@/components/ui/Table";
import { scanHeaders } from "@/hooks/useScanner";

/**
 * Improvement & Research (Phase 9). Shows the controlled code-improvement agent's
 * honest state, its absolute prohibitions, disposition counts, and the immutable
 * proposal ledger. Read-only — nothing here edits code, branches, merges, or pushes.
 */

type Proposal = {
  id: string; category: string; title: string; risk: string; forbidden: boolean;
  disposition: string; branchName: string; targetPaths: string[]; createdAtMs: number;
  dispositionReasons?: string[];
};
type Status = {
  agentState?: string;
  automationAvailable?: boolean;
  autoMergeEnabled?: boolean;
  blockers?: string[];
  prohibitions?: string[];
  counts?: Record<string, number>;
  proposals?: Proposal[];
};

function agentTone(state: string | undefined): "bull" | "warn" | "bear" | "muted" {
  if (state === "ACTIVE_AUTO_MERGE_LOW_RISK") return "bull";
  if (state === "ACTIVE_PROPOSE_ONLY") return "warn";
  return "muted";
}

function dispositionTone(d: string): "bull" | "warn" | "bear" | "muted" {
  if (d === "AUTO_MERGE_ELIGIBLE") return "bull";
  if (d === "READY_FOR_CODING_AGENT") return "warn";
  if (d === "BLOCKED") return "bear";
  return "muted";
}

function riskTone(r: string): "bull" | "warn" | "bear" | "muted" {
  if (r === "LOW") return "bull";
  if (r === "MEDIUM") return "warn";
  if (r === "HIGH") return "bear";
  return "muted";
}

export default function ImprovementPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(async (audit = false) => {
    try {
      if (audit) setRunning(true);
      const r = await fetch(`/api/improvement${audit ? "?audit=1" : ""}`, { cache: "no-store", headers: scanHeaders() }).then((x) => x.json());
      setStatus(r?.status ?? {});
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? "Could not load improvement status.");
    } finally {
      setRunning(false);
    }
  }, []);

  useEffect(() => { load(); const id = setInterval(() => load(), 60000); return () => clearInterval(id); }, [load]);

  if (error && !status) return <PageContainer><ErrorState detail={error} onRetry={() => load()} /></PageContainer>;
  if (!status) return <PageContainer><Card title="Loading improvement status"><LoadingState rows={4} /></Card></PageContainer>;

  const counts = status.counts ?? {};
  const proposals = status.proposals ?? [];

  const cols: Column<Proposal>[] = [
    { key: "cat", header: "Category", render: (p) => p.category.replace(/_/g, " ") },
    { key: "title", header: "Proposal", render: (p) => p.title },
    { key: "risk", header: "Risk", render: (p) => <StatusBadge tone={riskTone(p.risk)}>{p.risk}</StatusBadge> },
    { key: "disp", header: "Disposition", render: (p) => <StatusBadge tone={dispositionTone(p.disposition)}>{p.disposition.replace(/_/g, " ")}</StatusBadge> },
    { key: "branch", header: "Branch", render: (p) => p.branchName },
  ];

  return (
    <PageContainer>
      <ResponsiveGrid min={240}>
        <Card title="Agent state" meta="Proposes only — never edits code, merges, or pushes">
          <div style={{ marginBottom: 6 }}><StatusBadge tone={agentTone(status.agentState)}>{(status.agentState ?? "INACTIVE").replace(/_/g, " ")}</StatusBadge></div>
          <KeyValue k="Automation available" v={status.automationAvailable ? "yes" : "no"} />
          <KeyValue k="Auto-merge enabled" v={status.autoMergeEnabled ? "yes" : "no"} />
          {(status.blockers ?? []).map((b, i) => <p key={i} style={{ fontSize: 11, opacity: 0.75, marginTop: 6 }}>• {b}</p>)}
        </Card>
        <Card title="Disposition counts">
          <KeyValue k="Total proposals" v={counts.total ?? 0} />
          <KeyValue k="Ready for coding agent" v={counts.READY_FOR_CODING_AGENT ?? 0} />
          <KeyValue k="Human review required" v={counts.HUMAN_REVIEW_REQUIRED ?? 0} />
          <KeyValue k="Auto-merge eligible" v={counts.AUTO_MERGE_ELIGIBLE ?? 0} />
          <KeyValue k="Blocked" v={counts.BLOCKED ?? 0} tone={(counts.BLOCKED ?? 0) > 0 ? "warn" : undefined} />
        </Card>
        <Card title="Absolute prohibitions" meta="Never overridable by configuration">
          {(status.prohibitions ?? []).map((p, i) => <p key={i} style={{ fontSize: 12, margin: "2px 0", opacity: 0.85 }}>✕ {p}</p>)}
        </Card>
      </ResponsiveGrid>

      <Card title="Improvement proposals" meta="Immutable, write-once records">
        <div style={{ marginBottom: 10 }}>
          <button onClick={() => load(true)} disabled={running} style={{ padding: "6px 12px", fontSize: 13 }}>
            {running ? "Auditing repo…" : "Run repo audit now"}
          </button>
        </div>
        <SimpleTable
          columns={cols}
          rows={proposals}
          rowKey={(p) => p.id}
          emptyTitle="No proposals yet"
          emptyReason="Run a repo audit to record test-coverage proposals from real facts."
        />
      </Card>
    </PageContainer>
  );
}
