"use client";

import { useCallback, useEffect, useState } from "react";
import { PageContainer, PageHeader, Card, LoadingState, EmptyState, ErrorState, StatusBadge } from "@/components/ui/Shell";
import { apiFetchJson, describeApiLoadFailure } from "@/lib/client-auth";

type WindowStats = {
  window: string;
  mirroredTrades: number;
  parityChecks: number;
  paritySuccesses: number;
  parityFailures: number;
  successRatePct: number | null;
  fillPriceDiffs: number;
  realizedPnlDiffs: number;
  returnPctDiffs: number;
  lifecycleMismatches: number;
  missingAuditChain: number;
  avgReconciliationLatencyMs: number | null;
  equityDiffs: number;
  unrealizedPnlDiffs: number;
  missingMarkCounts: number;
  staleMarkCounts: number;
  incompleteSnapshotCounts: number;
};

type Failure = {
  id: string;
  legacyTable: string;
  legacyTradeId: string;
  brokerEntityId: string | null;
  checkKind: string;
  expectedValue: unknown;
  actualValue: unknown;
  timestamp: number;
  evidenceChainId: string | null;
  reconciliationLatencyMs: number | null;
};

type Report = {
  dualWriteEnabled: boolean;
  summary: string;
  windows: { h24: WindowStats; d7: WindowStats; lifetime: WindowStats };
  recentFailures: Failure[];
  equityMarks: {
    incompleteSnapshots: number;
    partialSnapshots: number;
    completeSnapshots: number;
    missingMarkEvents: number;
    staleMarkEvents: number;
    latestEquityByAccount: Array<{
      accountKey: string | null;
      totalEquity: number;
      realizedPnl: number;
      unrealizedPnl: number;
      completeness: string | null;
    }>;
  };
};

function WindowCard({ title, w }: { title: string; w: WindowStats }) {
  return (
    <Card title={title}>
      <p>Mirrored trades: {w.mirroredTrades}</p>
      <p>
        Parity: {w.paritySuccesses}/{w.parityChecks}
        {w.successRatePct != null ? ` (${w.successRatePct}%)` : ""} · failures: {w.parityFailures}
      </p>
      <p>
        Fill Δ: {w.fillPriceDiffs} · P&amp;L Δ: {w.realizedPnlDiffs} · Return% Δ: {w.returnPctDiffs} · Equity Δ:{" "}
        {w.equityDiffs} · Unrealized Δ: {w.unrealizedPnlDiffs}
      </p>
      <p>
        Lifecycle mismatches: {w.lifecycleMismatches} · Missing audit chain: {w.missingAuditChain}
      </p>
      <p>
        Missing marks: {w.missingMarkCounts} · Stale marks: {w.staleMarkCounts} · Incomplete snapshots:{" "}
        {w.incompleteSnapshotCounts}
      </p>
      <p>
        Avg reconciliation latency:{" "}
        {w.avgReconciliationLatencyMs != null ? `${w.avgReconciliationLatencyMs} ms` : "n/a"}
      </p>
    </Card>
  );
}

export default function BrokerageParityPage() {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadState, setLoadState] = useState<"ok" | "empty" | "error">("ok");
  const [errorTitle, setErrorTitle] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErrorTitle(null);
    setErrorDetail(null);
    const result = await apiFetchJson<{ report?: Report }>("/api/research/brokerage-parity");
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

  return (
    <PageContainer>
      <PageHeader
        title="Brokerage Parity"
        subtitle="Developer/research — legacy vs V2 dual-write agreement. No live authority."
      />
      {loading && <LoadingState label="Loading brokerage parity…" />}
      {!loading && loadState === "error" && errorTitle && (
        <ErrorState title={errorTitle} detail={errorDetail ?? undefined} onRetry={load} />
      )}
      {!loading && loadState === "empty" && (
        <EmptyState title="No parity report" reason="The server responded but returned no report payload." />
      )}
      {!loading && loadState === "ok" && report && (
        <>
          <Card title="Status">
            <StatusBadge tone={report.dualWriteEnabled ? (report.windows.lifetime.parityFailures === 0 ? "bull" : "warn") : "muted"}>
              {report.dualWriteEnabled ? "Dual-write ON" : "Dual-write OFF (default)"}
            </StatusBadge>
            <p style={{ marginTop: 8 }}>{report.summary}</p>
          </Card>
          <WindowCard title="Rolling 24 hours" w={report.windows.h24} />
          <WindowCard title="Rolling 7 days" w={report.windows.d7} />
          <WindowCard title="Lifetime" w={report.windows.lifetime} />
          <Card title="Equity & marks (V2 research)">
            <p>
              Snapshots — complete: {report.equityMarks.completeSnapshots} · partial:{" "}
              {report.equityMarks.partialSnapshots} · incomplete: {report.equityMarks.incompleteSnapshots}
            </p>
            <p>
              Mark events — missing: {report.equityMarks.missingMarkEvents} · stale/wide:{" "}
              {report.equityMarks.staleMarkEvents}
            </p>
            {report.equityMarks.latestEquityByAccount.length === 0 ? (
              <p>No V2 equity snapshots yet.</p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0 }}>
                {report.equityMarks.latestEquityByAccount.map((a) => (
                  <li key={a.accountKey ?? a.totalEquity}>
                    {a.accountKey ?? "account"} · equity ${a.totalEquity.toFixed(2)} · realized $
                    {a.realizedPnl.toFixed(2)} · unrealized ${a.unrealizedPnl.toFixed(2)} ·{" "}
                    {a.completeness ?? "n/a"}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Recent parity failures">
            {report.recentFailures.length === 0 ? (
              <p>No failures recorded. Mismatches are never silently ignored when they occur.</p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {report.recentFailures.map((f) => (
                  <li
                    key={f.id}
                    style={{
                      borderTop: "1px solid var(--border, #334)",
                      padding: "10px 0",
                      fontSize: 13,
                    }}
                  >
                    <strong>{f.checkKind}</strong> · {f.legacyTable}:{f.legacyTradeId}
                    {f.brokerEntityId ? ` → V2 ${f.brokerEntityId}` : ""}
                    <br />
                    expected={JSON.stringify(f.expectedValue)} actual={JSON.stringify(f.actualValue)}
                    <br />
                    evidence={f.evidenceChainId ?? "n/a"} · latency=
                    {f.reconciliationLatencyMs != null ? `${f.reconciliationLatencyMs}ms` : "n/a"} ·{" "}
                    {new Date(f.timestamp).toISOString()}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </PageContainer>
  );
}
