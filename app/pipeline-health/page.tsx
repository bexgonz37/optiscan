"use client";

import { useCallback, useEffect, useState } from "react";
import { PageContainer, PageHeader, Card, LoadingState, EmptyState, StatusBadge } from "@/components/ui/Shell";
import { scanHeaders } from "@/hooks/useScanner";

type Diagnostic = {
  ok: boolean;
  summary: string;
  likelyBlockers: string[];
  flags: Record<string, boolean>;
  candidates: { observed24h: number; ready24h: number; rejected24h: number };
  delivery: { sent24h: number; failed24h: number };
  discord: { webhookConfigured: boolean };
};

export default function PipelineHealthPage() {
  const [diag, setDiag] = useState<Diagnostic | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/research/options/pipeline-health", { headers: scanHeaders() });
      const j = await r.json();
      setDiag(j.diagnostic ?? null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <PageContainer>
      <PageHeader title="Pipeline Health" subtitle="Why alerts did or did not arrive — deterministic diagnostics only." />
      {loading && <LoadingState label="Loading pipeline diagnostics…" />}
      {!loading && !diag && <EmptyState title="No diagnostics" reason="Could not load pipeline health." />}
      {diag && (
        <>
          <Card title="Summary">
            <StatusBadge tone={diag.ok ? "live" : "warn"}>{diag.summary}</StatusBadge>
            {diag.likelyBlockers.length > 0 && (
              <ul>{diag.likelyBlockers.map((b) => <li key={b}>{b}</li>)}</ul>
            )}
          </Card>
          <Card title="24h funnel">
            <p>Observed: {diag.candidates.observed24h} · READY: {diag.candidates.ready24h} · Rejected: {diag.candidates.rejected24h}</p>
            <p>Discord SENT: {diag.delivery.sent24h} · Failed: {diag.delivery.failed24h}</p>
            <p>Webhook configured: {diag.discord.webhookConfigured ? "yes" : "no"}</p>
          </Card>
        </>
      )}
    </PageContainer>
  );
}
