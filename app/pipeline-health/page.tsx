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
  alertReliability?: {
    ownership: { owner: string; independentOwns: boolean; supervisorOptionsBlocked: boolean };
    quota: { quotaMode: string; discoveryPaused: boolean; operatorWarning: string | null; callsToday: number; discoveryDailyBudget: number };
    killSwitch: boolean;
    ambiguousOpens24h: number;
  };
  sessionGuard?: {
    state: string;
    tradingSessionDate: string;
    subscriberScanAllowed: boolean;
    subscriberDeliveryAllowed: boolean;
    reason: string;
    regularOpenMs?: number;
    regularCloseMs?: number;
  };
  lifecycle?: { recentSuppressions: Record<string, unknown>[]; milestoneDeliveryFailures: number };
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
          {diag.alertReliability && (
            <Card title="Alert reliability" tone={diag.alertReliability.killSwitch || diag.alertReliability.quota.discoveryPaused ? "warn" : undefined}>
              <p>
                Subscriber options owner: {diag.alertReliability.ownership.owner.toUpperCase()}
                {diag.alertReliability.ownership.independentOwns ? " · Supervisor Discord: SUPPRESSED" : ""}
                {!diag.alertReliability.ownership.independentOwns ? ` · supervisor blocked: ${diag.alertReliability.ownership.supervisorOptionsBlocked ? "yes" : "no"}` : ""}
              </p>
              <p>Quota mode: {diag.alertReliability.quota.quotaMode} · discovery paused: {diag.alertReliability.quota.discoveryPaused ? "yes" : "no"}</p>
              {diag.alertReliability.quota.operatorWarning && <p>{diag.alertReliability.quota.operatorWarning}</p>}
              <p>Ambiguous opening sends (24h): {diag.alertReliability.ambiguousOpens24h}</p>
              {diag.alertReliability.killSwitch && <StatusBadge tone="bad">OPTIONS_CALLOUTS_KILL engaged</StatusBadge>}
            </Card>
          )}
          {diag.sessionGuard && (
            <Card title="Market session guard" tone={diag.sessionGuard.subscriberDeliveryAllowed ? undefined : "warn"}>
              <p>State: {diag.sessionGuard.state} · session date: {diag.sessionGuard.tradingSessionDate}</p>
              <p>Scan allowed: {diag.sessionGuard.subscriberScanAllowed ? "yes" : "no"} · delivery allowed: {diag.sessionGuard.subscriberDeliveryAllowed ? "yes" : "no"}</p>
              <p>{diag.sessionGuard.reason}</p>
            </Card>
          )}
          {diag.lifecycle?.recentSuppressions && diag.lifecycle.recentSuppressions.length > 0 && (
            <Card title="Recent lifecycle suppressions">
              <ul>{diag.lifecycle.recentSuppressions.slice(0, 8).map((s, i) => (
                <li key={i}>{String((s as { reason?: string }).reason ?? JSON.stringify(s))}</li>
              ))}</ul>
            </Card>
          )}
        </>
      )}
    </PageContainer>
  );
}
