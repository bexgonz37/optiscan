"use client";

import { useCallback, useEffect, useState } from "react";
import { PageContainer, PageHeader, Card, LoadingState, EmptyState, ErrorState, StatusBadge } from "@/components/ui/Shell";
import { apiFetchJson, describeApiLoadFailure } from "@/lib/client-auth";

type Diagnostic = {
  ok: boolean;
  summary: string;
  likelyBlockers: string[];
  flags: Record<string, boolean>;
  candidates: { observed24h: number; ready24h: number; rejected24h: number };
  delivery: { sent24h: number; failed24h: number };
  discord: { webhookConfigured: boolean };
};

type PipelineHealthResponse = {
  diagnostic?: Diagnostic;
};

export default function PipelineHealthPage() {
  const [diag, setDiag] = useState<Diagnostic | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadState, setLoadState] = useState<"ok" | "empty" | "error">("ok");
  const [errorTitle, setErrorTitle] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErrorTitle(null);
    setErrorDetail(null);
    const result = await apiFetchJson<PipelineHealthResponse>("/api/research/options/pipeline-health");
    if (!result.ok) {
      const { title, detail } = describeApiLoadFailure(result);
      setDiag(null);
      setLoadState("error");
      setErrorTitle(title);
      setErrorDetail(detail);
    } else if (!result.data?.diagnostic) {
      setDiag(null);
      setLoadState("empty");
    } else {
      setDiag(result.data.diagnostic);
      setLoadState("ok");
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <PageContainer>
      <PageHeader title="Pipeline Health" subtitle="Why alerts did or did not arrive — deterministic diagnostics only." />
      {loading && <LoadingState label="Loading pipeline diagnostics…" />}
      {!loading && loadState === "error" && errorTitle && (
        <ErrorState title={errorTitle} detail={errorDetail ?? undefined} onRetry={load} />
      )}
      {!loading && loadState === "empty" && (
        <EmptyState title="No diagnostic payload" reason="The server responded successfully but returned no diagnostic object." />
      )}
      {!loading && loadState === "ok" && diag && (
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
