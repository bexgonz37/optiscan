"use client";

import { useCallback, useEffect, useState } from "react";
import { PageContainer, PageHeader, Card, LoadingState, EmptyState, ErrorState, StatusBadge } from "@/components/ui/Shell";
import { apiFetchJson, describeApiLoadFailure } from "@/lib/client-auth";

type Aggregate = {
  tradingDays: number;
  totalDecisions: number;
  observedOnly: number;
  wouldSend: number;
  wouldBlock: number;
  actuallyDelivered: number;
  allowedWinRate60m: number | null;
  blockedWinRate60m: number | null;
  allowedExpectancy60m: number | null;
  blockedExpectancy60m: number | null;
  severeLossesPrevented: number;
  largeWinnersBlocked: number;
  missingDataPct: number;
  byVerdict: Record<string, number>;
  bySessionState: Record<string, number>;
  supervisorWouldSend: number;
  independentWouldSend: number;
  instrumentationFallbackInserts: number;
};

type DailyRow = {
  tradingSessionDate: string;
  total: number;
  proposedWouldSend: number;
  proposedWouldBlock: number;
  observedOnly: number;
  actuallyDelivered: number;
};

type ShadowSoakResponse = {
  aggregate?: Aggregate;
  daily?: DailyRow[];
  killSwitch?: boolean;
};

function pct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

export default function ShadowSoakPage() {
  const [data, setData] = useState<ShadowSoakResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadState, setLoadState] = useState<"ok" | "empty" | "error">("ok");
  const [errorTitle, setErrorTitle] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErrorTitle(null);
    setErrorDetail(null);
    const result = await apiFetchJson<ShadowSoakResponse>("/api/research/options/shadow-soak?days=14");
    if (!result.ok) {
      const { title, detail } = describeApiLoadFailure(result);
      setLoadState("error");
      setErrorTitle(title);
      setErrorDetail(detail);
      setData(null);
    } else if (!result.data?.aggregate?.totalDecisions) {
      setLoadState("empty");
      setData(result.data ?? null);
    } else {
      setLoadState("ok");
      setData(result.data ?? null);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const agg = data?.aggregate;

  return (
    <PageContainer>
      <PageHeader
        title="Shadow Soak"
        subtitle="Kill-switch evidence — would-send vs would-block outcomes without Discord openings"
      />
      {loading && <LoadingState label="Loading shadow soak data…" />}
      {!loading && loadState === "error" && (
        <ErrorState title={errorTitle ?? "Failed to load"} detail={errorDetail ?? undefined} onRetry={() => void load()} />
      )}
      {!loading && loadState === "empty" && (
        <EmptyState title="No shadow decisions yet" reason="Run the independent monitor with shadow gates while OPTIONS_CALLOUTS_KILL=1." />
      )}
      {!loading && loadState === "ok" && agg && (
        <div className="space-y-4">
          <Card title="Safety">
            <div className="flex flex-wrap gap-3 text-sm">
              <StatusBadge tone={data?.killSwitch ? "live" : "warn"}>
                Kill switch: {data?.killSwitch ? "ON" : "OFF"}
              </StatusBadge>
              <span>Actually delivered: {agg.actuallyDelivered}</span>
              <span>Observed only: {agg.observedOnly}</span>
              <span>Fallback inserts: {agg.instrumentationFallbackInserts}</span>
            </div>
          </Card>

          <Card title="Funnel (14d)">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div><div className="text-muted">Decisions</div><div className="text-lg font-semibold">{agg.totalDecisions}</div></div>
              <div><div className="text-muted">Would send</div><div className="text-lg font-semibold">{agg.wouldSend}</div></div>
              <div><div className="text-muted">Would block</div><div className="text-lg font-semibold">{agg.wouldBlock}</div></div>
              <div><div className="text-muted">Trading days</div><div className="text-lg font-semibold">{agg.tradingDays}</div></div>
            </div>
          </Card>

          <Card title="Forward outcomes (60m)">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div><div className="text-muted">Allowed win rate</div><div>{pct(agg.allowedWinRate60m != null ? agg.allowedWinRate60m * 100 : null)}</div></div>
              <div><div className="text-muted">Blocked win rate</div><div>{pct(agg.blockedWinRate60m != null ? agg.blockedWinRate60m * 100 : null)}</div></div>
              <div><div className="text-muted">Allowed expectancy</div><div>{pct(agg.allowedExpectancy60m)}</div></div>
              <div><div className="text-muted">Blocked expectancy</div><div>{pct(agg.blockedExpectancy60m)}</div></div>
              <div><div className="text-muted">Severe losses prevented</div><div>{agg.severeLossesPrevented}</div></div>
              <div><div className="text-muted">Large winners blocked</div><div>{agg.largeWinnersBlocked}</div></div>
              <div><div className="text-muted">Missing data</div><div>{agg.missingDataPct}%</div></div>
            </div>
          </Card>

          <Card title="Path comparison">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>Supervisor would-send: {agg.supervisorWouldSend}</div>
              <div>Independent would-send: {agg.independentWouldSend}</div>
            </div>
          </Card>

          <Card title="Daily breakdown">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b border-border">
                    <th className="py-2 pr-4">Session</th>
                    <th className="py-2 pr-4">Total</th>
                    <th className="py-2 pr-4">Would send</th>
                    <th className="py-2 pr-4">Would block</th>
                    <th className="py-2 pr-4">Delivered</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.daily ?? []).map((d) => (
                    <tr key={d.tradingSessionDate} className="border-b border-border/50">
                      <td className="py-2 pr-4">{d.tradingSessionDate}</td>
                      <td className="py-2 pr-4">{d.total}</td>
                      <td className="py-2 pr-4">{d.proposedWouldSend}</td>
                      <td className="py-2 pr-4">{d.proposedWouldBlock}</td>
                      <td className="py-2 pr-4">{d.actuallyDelivered}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </PageContainer>
  );
}
