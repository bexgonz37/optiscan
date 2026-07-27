"use client";

import { useCallback, useEffect, useState } from "react";
import { PageContainer, PageHeader, Card, LoadingState, EmptyState, ErrorState, StatusBadge, KeyValue } from "@/components/ui/Shell";
import { apiFetch, apiFetchJson, describeApiLoadFailure } from "@/lib/client-auth";

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
  evidenceIntegrity?: {
    paperChain: { paperLinkRate: number | null; unhealthyRows: number; sent24h: number };
    shadowGrader: { pendingOutcomes: number; missingDataPct: number; wouldSend: number; wouldBlock: number };
    quantLanes: { lanesWithEvidence: number; lanesInsufficient: number };
    aiWeekly: { lastStatus: string | null; validationFailed24h: number };
  };
};

type PipelineHealthResponse = {
  diagnostic?: Diagnostic;
};

type ReadinessGate = { id: string; label: string; kind: "safety" | "sample"; passed: boolean; detail: string };
type ReadinessAttestation = { key: string; label: string; attested: boolean; attestedBy: string | null; attestedAtMs: number | null };
type ReadinessReport = {
  status: "NOT_READY" | "SUBSCRIBER_READY";
  ready: boolean;
  blockingGates: string[];
  gates: ReadinessGate[];
  metrics: Record<string, number | boolean | string | null>;
  attestations: ReadinessAttestation[];
  remainingWarnings: string[];
  dashboardUrl: string;
};
type ReadinessState = {
  status: "NOT_READY" | "SUBSCRIBER_READY";
  transitionId: number;
  lastEvaluatedAtMs: number | null;
  lastTransitionAtMs: number | null;
  lastFailingGate: string | null;
  lastNotificationKind: "READY" | "REVOKED" | null;
  lastNotificationStatus: string;
  lastNotificationError: string | null;
  lastNotificationAtMs: number | null;
};
type ReadinessResponse = { ok: boolean; report?: ReadinessReport; state?: ReadinessState | null };

function fmtTime(ms: number | null | undefined): string {
  if (ms == null) return "—";
  try { return new Date(ms).toLocaleString(); } catch { return String(ms); }
}

function SubscriberReadinessCard() {
  const [data, setData] = useState<ReadinessResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await apiFetchJson<ReadinessResponse>("/api/research/options/subscriber-readiness");
    setData(res.ok ? res.data ?? null : null);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const post = useCallback(async (path: string, body?: unknown): Promise<any> => {
    const res = await apiFetch(path, {
      method: "POST",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json().catch(() => ({}));
  }, []);

  const reEvaluate = useCallback(async () => {
    setBusy(true); setActionMsg(null);
    try {
      const r = await post("/api/research/options/subscriber-readiness/re-evaluate");
      setActionMsg(r?.transitioned ? `Transitioned → ${r?.state?.status}${r?.notificationSent ? " (notification sent)" : ""}` : "Re-evaluated · no state change");
      await load();
    } catch { setActionMsg("Re-evaluate failed"); } finally { setBusy(false); }
  }, [post, load]);

  const sendTest = useCallback(async () => {
    setBusy(true); setActionMsg(null);
    try {
      const r = await post("/api/research/options/subscriber-readiness/test-notification");
      setActionMsg(r?.ok ? "Test notification sent (readiness state unchanged)" : `Test notification: ${r?.error ?? "failed"}`);
    } catch { setActionMsg("Test notification failed"); } finally { setBusy(false); }
  }, [post]);

  const toggleAttest = useCallback(async (key: string, attested: boolean) => {
    setBusy(true); setActionMsg(null);
    try {
      await post("/api/research/options/subscriber-readiness/attest", { key, attested, attestedBy: "owner" });
      await load();
    } catch { setActionMsg("Attestation update failed"); } finally { setBusy(false); }
  }, [post, load]);

  if (loading) return <Card title="Subscriber readiness"><LoadingState label="Loading readiness…" rows={2} /></Card>;
  if (!data?.report) return <Card title="Subscriber readiness"><EmptyState title="No readiness data" reason="The readiness evaluator returned nothing (schema may not be migrated yet)." /></Card>;

  const { report, state } = data;
  const m = report.metrics;
  const ready = report.status === "SUBSCRIBER_READY";
  const notifStatus = state?.lastNotificationStatus ?? "NONE";

  return (
    <Card title="Subscriber readiness" tone={ready ? undefined : "warn"}>
      <StatusBadge tone={ready ? "live" : "warn"}>{report.status}</StatusBadge>
      {state?.lastNotificationKind && (
        <StatusBadge tone={notifStatus === "SENT" ? "live" : notifStatus === "FAILED" ? "bad" : "muted"}>
          Last notice: {state.lastNotificationKind} · {notifStatus}
        </StatusBadge>
      )}
      <KeyValue k="Last evaluated" v={fmtTime(state?.lastEvaluatedAtMs)} />
      <KeyValue k="Last transition" v={fmtTime(state?.lastTransitionAtMs)} />
      {state?.lastFailingGate && <KeyValue k="Last failing gate" v={state.lastFailingGate} tone="warn" />}
      {state?.lastNotificationError && <KeyValue k="Notification error" v={state.lastNotificationError} tone="bear" />}

      <div style={{ marginTop: 8 }}>
        <KeyValue k="Launch sample cutoff" v={m.sampleCutoffIso ? String(m.sampleCutoffIso).slice(0, 19) + "Z" : "—"} />
        {Number(m.deliveredSentHistorical) > 0 && (
          <KeyValue k="Historical (excluded)" v={`${m.deliveredSentHistorical} alerts before cutoff`} tone="muted" />
        )}
        <KeyValue k="Trading days" v={String(m.validTradingDays ?? "—")} />
        <KeyValue k="Delivered / linked" v={`${m.deliveredSent ?? "—"} / ${m.deliveredLinked ?? "—"}`} />
        <KeyValue k="Paper-link rate" v={m.paperLinkRate == null ? "—" : `${Math.round(Number(m.paperLinkRate) * 100)}%`} />
        <KeyValue k="Complete grading" v={m.completeGradingRate == null ? "—" : `${Math.round(Number(m.completeGradingRate) * 100)}% (${m.gradedSample ?? 0})`} />
        <KeyValue k="Median 60m return" v={m.medianReturn60m == null ? "—" : `${m.medianReturn60m}%`} tone={Number(m.medianReturn60m) > 0 ? "bull" : "bear"} />
        <KeyValue k="Expectancy" v={m.expectancy == null ? "—" : `${m.expectancy}%`} tone={Number(m.expectancy) > 0 ? "bull" : "bear"} />
        <KeyValue k="Win rate" v={m.winRate == null ? "—" : `${Math.round(Number(m.winRate) * 100)}%`} />
        <KeyValue k="Profit factor" v={String(m.profitFactor ?? "—")} />
        <KeyValue k="Early/Timely" v={m.earlyTimelyRate == null ? "—" : `${Math.round(Number(m.earlyTimelyRate) * 100)}%`} />
        {m.earlyTimelyRateScored != null && Number(m.entryQualityScored) < Number(m.deliveredSent) && (
          <KeyValue k="Early/Timely (scored only)" v={`${Math.round(Number(m.earlyTimelyRateScored) * 100)}% (${m.entryQualityScored} scored)`} tone="muted" />
        )}
        <KeyValue k="Late/Chased" v={m.lateChasedRate == null ? "—" : `${Math.round(Number(m.lateChasedRate) * 100)}%`} />
        <KeyValue k="Duplicate deliveries (launch sample)" v={String(m.duplicateDeliveredCount ?? 0)} tone={Number(m.duplicateDeliveredCount) > 0 ? "bear" : "muted"} />
        {Number(m.duplicateFingerprintExtrasAllTime) > 0 && (
          <KeyValue k="Duplicate fingerprints (all-time audit)" v={String(m.duplicateFingerprintExtrasAllTime)} tone="muted" />
        )}
        {Number(m.paperUnhealthyHistorical) > 0 && (
          <KeyValue k="Historical paper debt (excluded)" v={String(m.paperUnhealthyHistorical)} tone="muted" />
        )}
        <KeyValue k="Session violations" v={String(m.sessionViolations ?? 0)} tone={Number(m.sessionViolations) > 0 ? "bear" : "muted"} />
        <KeyValue k="Supervisor/legacy sends" v={String(m.supervisorLegacySends ?? 0)} tone={Number(m.supervisorLegacySends) > 0 ? "bear" : "muted"} />
        {Number(m.supervisorLegacySendsHistorical) > 0 && (
          <KeyValue k="Supervisor/legacy (historical)" v={String(m.supervisorLegacySendsHistorical)} tone="muted" />
        )}
        <KeyValue k="Missing-quote" v={`${m.missingQuotePct ?? 0}%`} />
        <KeyValue k="Milestone proof" v={`return ${m.returnMilestonesDelivered ?? 0} · closed ${m.closedUpdatesDelivered ?? 0}`} />
        <KeyValue k="Stripe / role ready" v={`${m.stripeReady ? "yes" : "no"} / ${m.discordRoleReady ? "yes" : "no"}`} />
      </div>

      {report.blockingGates.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <strong>Blocking gates ({report.blockingGates.length}):</strong>
          <ul>
            {report.gates.filter((g) => !g.passed).map((g) => (
              <li key={g.id}>[{g.kind}] {g.label} — {g.detail}</li>
            ))}
          </ul>
        </div>
      )}
      {report.remainingWarnings.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <strong>Warnings:</strong>
          <ul>{report.remainingWarnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}

      <div style={{ marginTop: 8 }}>
        <strong>Owner attestations</strong>
        {report.attestations.map((a) => (
          <label key={a.key} style={{ display: "block", margin: "4px 0" }}>
            <input
              type="checkbox"
              checked={a.attested}
              disabled={busy}
              onChange={(e) => void toggleAttest(a.key, e.target.checked)}
            />{" "}
            {a.label}
            {a.attested && a.attestedAtMs ? <span style={{ opacity: 0.6 }}> — {fmtTime(a.attestedAtMs)}</span> : null}
          </label>
        ))}
      </div>

      <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => void reEvaluate()}>
          Re-evaluate readiness
        </button>
        <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => void sendTest()} title="Sends a labeled TEST message; does not change readiness state">
          Send test notification (no state change)
        </button>
      </div>
      {actionMsg && <p style={{ marginTop: 6, opacity: 0.8 }}>{actionMsg}</p>}
      <p style={{ marginTop: 6, fontSize: "0.8em", opacity: 0.6 }}>
        READY is a signal to perform final human review only. It never enables billing, invites subscribers, changes Discord roles, publishes claims, changes formulas, or deploys code.
      </p>
    </Card>
  );
}

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
          <SubscriberReadinessCard />
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
          {diag.evidenceIntegrity && (
            <Card title="Evidence integrity">
              <p>Paper link rate (24h): {diag.evidenceIntegrity.paperChain.paperLinkRate ?? "n/a"} · unhealthy rows: {diag.evidenceIntegrity.paperChain.unhealthyRows}</p>
              <p>Shadow pending outcomes: {diag.evidenceIntegrity.shadowGrader.pendingOutcomes} · missing data: {diag.evidenceIntegrity.shadowGrader.missingDataPct}%</p>
              <p>Quant lanes with evidence: {diag.evidenceIntegrity.quantLanes.lanesWithEvidence} · insufficient: {diag.evidenceIntegrity.quantLanes.lanesInsufficient}</p>
              <p>AI weekly last status: {diag.evidenceIntegrity.aiWeekly.lastStatus ?? "n/a"} · validation failures (24h): {diag.evidenceIntegrity.aiWeekly.validationFailed24h}</p>
              <p><a href="/api/research/options/paper-chain">Paper chain API</a> · <a href="/api/research/options/quant-lanes">Quant lanes API</a></p>
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
