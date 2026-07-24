"use client";

import { useCallback, useEffect, useState } from "react";
import {
  PageContainer,
  PageHeader,
  Card,
  LoadingState,
  EmptyState,
  ErrorState,
  StatusBadge,
} from "@/components/ui/Shell";
import { apiFetchJson, describeApiLoadFailure } from "@/lib/client-auth";

const LABEL = "Brokerage V2 Migration Readiness — No Production Cutover";

type Requirement = {
  id: string;
  description: string;
  passed: boolean;
  actual: unknown;
  required: unknown;
  blocking: boolean;
  detail?: string;
};

type Report = {
  status: string;
  policyVersion: number;
  recommendedNextAction: string;
  passedRequirements: string[];
  failedRequirements: string[];
  missingForNextStatus: string[];
  metrics: Record<string, unknown>;
  requirements: Requirement[];
  flags: { dualWrite: boolean; shadowRead: boolean; v2Reads: boolean };
  routing: { responseSource: string; note: string; runShadowCompare: boolean };
  shadowReadSummary: { events: number; mismatches: number };
  dataQualityWarnings: string[];
  dryRun: { findings: Array<{ code: string; severity: string; message: string }>; dryRun: boolean };
};

export default function BrokerageReadinessPage() {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadState, setLoadState] = useState<"ok" | "empty" | "error">("ok");
  const [errorTitle, setErrorTitle] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErrorTitle(null);
    setErrorDetail(null);
    const result = await apiFetchJson<{ report?: Report }>("/api/research/brokerage-readiness");
    if (!result.ok) {
      const { title, detail } = describeApiLoadFailure(result);
      setReport(null);
      setLoadState("error");
      setErrorTitle(title);
      setErrorDetail(detail);
    } else if (!result.data?.report) {
      setReport(null);
      setLoadState("empty");
    } else {
      setReport(result.data.report);
      setLoadState("ok");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const tone =
    report?.status === "READY_FOR_CONTROLLED_CUTOVER"
      ? "bull"
      : report?.status === "READY_FOR_SHADOW_READS"
        ? "bull"
        : report?.status === "OBSERVING"
          ? "warn"
          : "bear";

  return (
    <PageContainer>
      <PageHeader title="Brokerage Readiness" subtitle={LABEL} />
      <Card title="Surface status">
        <StatusBadge tone="warn">{LABEL}</StatusBadge>
        <p style={{ marginTop: 8, fontSize: 13 }}>
          B6 builds evidence for a future cutover decision. Production V2 reads stay disabled. Legacy remains
          authoritative.
        </p>
      </Card>

      {loading && <LoadingState label="Loading readiness…" />}
      {!loading && loadState === "error" && errorTitle && (
        <ErrorState title={errorTitle} detail={errorDetail ?? undefined} onRetry={load} />
      )}
      {!loading && loadState === "empty" && (
        <EmptyState title="No readiness report" reason="Server returned no report payload." />
      )}

      {!loading && loadState === "ok" && report && (
        <>
          <Card title="Current readiness">
            <StatusBadge tone={tone as "bull" | "warn" | "bear" | "muted"}>{report.status}</StatusBadge>
            <p style={{ marginTop: 8 }}>{report.recommendedNextAction}</p>
            <p style={{ fontSize: 13 }}>
              Flags — dual-write: {report.flags.dualWrite ? "ON" : "OFF"} · shadow-read:{" "}
              {report.flags.shadowRead ? "ON" : "OFF"} · V2 reads: {report.flags.v2Reads ? "ON" : "OFF"} (must stay
              OFF in B6 prod)
            </p>
            <p style={{ fontSize: 13 }}>
              Routing: {report.routing.responseSource} — {report.routing.note}
            </p>
            <p style={{ fontSize: 12 }}>Policy v{report.policyVersion}</p>
          </Card>

          <Card title="Observation & sample">
            <p>Mirrored trades: {String(report.metrics.mirroredTrades)}</p>
            <p>Completed round-trips: {String(report.metrics.completedMirroredRoundTrips)}</p>
            <p>Trading days observed: {String(report.metrics.distinctTradingDaysObserved)}</p>
            <p>
              Continuous healthy parity ms: {String(report.metrics.continuousHealthyParityMs ?? "n/a")}
            </p>
            <p>Mirror coverage %: {String(report.metrics.mirrorCoveragePct ?? "n/a")}</p>
            <p>Unresolved critical failures: {String(report.metrics.unresolvedCriticalFailures)}</p>
            <p>
              Orphans — orders {String(report.metrics.orphanedOrders)} · fills{" "}
              {String(report.metrics.orphanedFills)} · ledger {String(report.metrics.orphanedLedgerEntries)} ·
              snapshots {String(report.metrics.orphanedSnapshots)}
            </p>
            <p>
              Marks — missing {String(report.metrics.missingMarkCount)} · stale{" "}
              {String(report.metrics.staleMarkCount)} · incomplete snapshots{" "}
              {String(report.metrics.incompleteEquitySnapshotCount)}
            </p>
          </Card>

          <Card title="Parity rates">
            <p>Trade parity: {String(report.metrics.tradeParitySuccessRatePct ?? "n/a")}%</p>
            <p>Fill price: {String(report.metrics.fillPriceParityRatePct ?? "n/a")}%</p>
            <p>Realized P&amp;L: {String(report.metrics.realizedPnlParityRatePct ?? "n/a")}%</p>
            <p>Return: {String(report.metrics.returnParityRatePct ?? "n/a")}%</p>
            <p>Lifecycle: {String(report.metrics.lifecycleParityRatePct ?? "n/a")}%</p>
            <p>Audit chain: {String(report.metrics.auditChainCompletenessRatePct ?? "n/a")}%</p>
            <p>Equity reconcile: {String(report.metrics.equityReconciliationRatePct ?? "n/a")}%</p>
          </Card>

          <Card title="Requirements">
            <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: 13 }}>
              {report.requirements.map((r) => (
                <li
                  key={r.id}
                  style={{
                    borderTop: "1px solid var(--border,#334)",
                    padding: "8px 0",
                    opacity: r.passed ? 1 : 1,
                  }}
                >
                  <StatusBadge tone={r.passed ? "bull" : r.blocking ? "bear" : "warn"}>
                    {r.passed ? "PASS" : "FAIL"}
                  </StatusBadge>{" "}
                  <strong>{r.id}</strong> — {r.description}
                  <br />
                  actual={JSON.stringify(r.actual)} required={JSON.stringify(r.required)}
                  {r.detail ? ` · ${r.detail}` : ""}
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Missing for next status">
            {report.missingForNextStatus.length === 0 ? (
              <p>None — at top readiness tier for B6 (still no auto cutover).</p>
            ) : (
              <ul>
                {report.missingForNextStatus.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Shadow-read differences">
            <p>
              Events: {report.shadowReadSummary.events} · mismatches: {report.shadowReadSummary.mismatches}
            </p>
            <p style={{ fontSize: 12 }}>Shadow mode never changes user-visible legacy payloads.</p>
          </Card>

          <Card title="Dry-run reconciliation findings">
            <p style={{ fontSize: 12 }}>Append-only audit · no financial rewrites in B6.</p>
            {report.dryRun.findings.length === 0 ? (
              <p>No findings.</p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, fontSize: 12, maxHeight: 280, overflow: "auto" }}>
                {report.dryRun.findings.slice(0, 50).map((f, i) => (
                  <li key={`${f.code}-${i}`} style={{ borderTop: "1px solid var(--border,#334)", padding: "6px 0" }}>
                    <strong>{f.severity}</strong> {f.code}: {f.message}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Data-quality warnings">
            {report.dataQualityWarnings.length === 0 ? (
              <p>None.</p>
            ) : (
              <ul>
                {report.dataQualityWarnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </PageContainer>
  );
}
