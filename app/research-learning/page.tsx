"use client";

import { useCallback, useEffect, useState } from "react";
import {
  PageContainer, ResponsiveGrid, Card, KeyValue, StatusBadge, EmptyState, LoadingState, ErrorState,
} from "@/components/ui/Shell";
import { SimpleTable, type Column } from "@/components/ui/Table";
import { scanHeaders } from "@/hooks/useScanner";

/**
 * Research & Learning (Phase 7). Model readiness, drift state, bounded-retrain
 * audit, data-quality blockers, and human-reviewable recommendations. Read-only —
 * nothing here changes code or trading rules.
 */

type Run = { id: number; kind: string; watermark: number; new_graded: number; drift_state: string | null; created_at_ms: number };
type ExperimentalMeta = {
  trainingSample?: number; wins?: number; losses?: number; holdout?: number;
  brier?: number | null; ece?: number | null; coverage?: number | null; reasonNotValidated?: string | null;
};
type Status = {
  modelStatus?: {
    status?: string; state?: string; tier?: string; message?: string;
    championVersion?: number | null; metrics?: any; experimental?: ExperimentalMeta | null;
  };
  latestDrift?: { state: string; reasons: string[]; atMs: number } | null;
  recentRuns?: Run[];
  counts?: { graded: number; ungradable: number; outcomes: number };
  recommendations?: string[];
};

function modelTone(state: string | undefined): "bull" | "warn" | "bear" | "muted" {
  if (state === "ACTIVE_VALIDATED") return "bull";
  if (state === "ACTIVE_EXPERIMENTAL_RESEARCH_ONLY") return "warn";
  return "muted";
}

function driftTone(state: string | undefined): "bull" | "warn" | "bear" | "muted" {
  if (state === "HEALTHY") return "bull";
  if (state === "WATCH" || state === "INSUFFICIENT_DATA") return "muted";
  if (state === "DEGRADED" || state === "MODEL_STALE" || state === "PERFORMANCE_DRIFT") return "bear";
  return "warn";
}

export default function ResearchLearningPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(async (run = false) => {
    try {
      if (run) setRunning(true);
      const r = await fetch(`/api/learning${run ? "?run=1" : ""}`, { cache: "no-store", headers: scanHeaders() }).then((x) => x.json());
      setStatus(r?.status ?? {});
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? "Could not load learning status.");
    } finally {
      setRunning(false);
    }
  }, []);

  useEffect(() => { load(); const id = setInterval(() => load(), 30000); return () => clearInterval(id); }, [load]);

  if (error && !status) return <PageContainer><ErrorState detail={error} onRetry={() => load()} /></PageContainer>;
  if (!status) return <PageContainer><Card title="Loading learning status"><LoadingState rows={4} /></Card></PageContainer>;

  const m = status.modelStatus ?? {};
  const c = status.counts ?? { graded: 0, ungradable: 0, outcomes: 0 };
  const drift = status.latestDrift ?? null;

  const runCols: Column<Run>[] = [
    { key: "kind", header: "Run", render: (r) => r.kind },
    { key: "wm", header: "Watermark", align: "right", render: (r) => String(r.watermark) },
    { key: "ng", header: "New graded", align: "right", render: (r) => String(r.new_graded) },
    { key: "at", header: "When", render: (r) => new Date(r.created_at_ms).toLocaleString() },
  ];

  return (
    <PageContainer>
      <ResponsiveGrid min={240}>
        <Card title="Model readiness" meta="Probability = evidence only; never a trade permission">
          <div style={{ marginBottom: 6 }}><StatusBadge tone={modelTone(m.state)}>{(m.state ?? m.status ?? "INACTIVE").replace(/_/g, " ")}</StatusBadge></div>
          {m.state === "ACTIVE_EXPERIMENTAL_RESEARCH_ONLY" ? (
            <p style={{ fontSize: 12, fontWeight: 600, color: "#e0a020", margin: "2px 0 6px" }}>EXPERIMENTAL — LIMITED DATA — RESEARCH ONLY · not a validated probability</p>
          ) : null}
          <KeyValue k="Champion version" v={m.championVersion ?? "—"} />
          <KeyValue k="Brier (holdout)" v={m.metrics?.brier ?? m.experimental?.brier ?? "—"} />
          <KeyValue k="Calibration (ECE)" v={m.metrics?.ece ?? m.experimental?.ece ?? "—"} />
          {m.experimental ? (
            <KeyValue k="Sample (W/L · holdout)" v={`${m.experimental.trainingSample ?? 0} (${m.experimental.wins ?? 0}W/${m.experimental.losses ?? 0}L · ${m.experimental.holdout ?? 0})`} />
          ) : null}
          {m.state !== "ACTIVE_VALIDATED" && m.experimental?.reasonNotValidated ? (
            <p style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>Not validated: {m.experimental.reasonNotValidated}</p>
          ) : null}
          <p style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>{m.message}</p>
        </Card>
        <Card title="Drift monitor">
          <div style={{ marginBottom: 6 }}><StatusBadge tone={driftTone(drift?.state)}>{drift?.state ?? "—"}</StatusBadge></div>
          {drift?.reasons?.length ? drift.reasons.map((r, i) => <p key={i} style={{ fontSize: 12, margin: "2px 0", opacity: 0.85 }}>• {r}</p>) : <p style={{ fontSize: 12, opacity: 0.7 }}>No drift snapshot yet.</p>}
        </Card>
        <Card title="Authoritative outcomes">
          <KeyValue k="Total outcomes" v={c.outcomes} />
          <KeyValue k="Graded" v={c.graded} />
          <KeyValue k="Ungradable" v={c.ungradable} tone={c.ungradable > 0 ? "warn" : undefined} />
          <KeyValue k="Toward validated model" v={`${c.graded}/200`} />
        </Card>
      </ResponsiveGrid>

      <Card title="Recommendations" meta="Human review required — never auto-applied">
        {(status.recommendations ?? []).map((r, i) => <p key={i} style={{ fontSize: 13, margin: "3px 0" }}>→ {r}</p>)}
        <div style={{ marginTop: 10 }}>
          <button onClick={() => load(true)} disabled={running} style={{ padding: "6px 12px", fontSize: 13 }}>
            {running ? "Running bounded cycle…" : "Run learning cycle now"}
          </button>
        </div>
      </Card>

      <Card title="Retrain / drift audit">
        <SimpleTable
          columns={runCols}
          rows={status.recentRuns ?? []}
          rowKey={(r) => String(r.id)}
          emptyTitle="No learning runs yet"
          emptyReason="A bounded retrain runs only after ≥25 new graded outcomes and ≥24h since the last attempt. Every attempt, skip, promotion, and rollback is recorded here."
        />
      </Card>

      <Card title="About continuous learning">
        <EmptyState icon="ℹ" title="Bounded, versioned, reversible" reason="The learning loop refreshes statistics, monitors drift, and may train a challenger under strict gates. It never edits source code, thresholds, risk limits, sizing, entry/exit rules, sessions, bearish status, or execution permissions." />
      </Card>
    </PageContainer>
  );
}
