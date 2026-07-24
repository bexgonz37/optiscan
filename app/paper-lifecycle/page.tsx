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
  DetailsDisclosure,
} from "@/components/ui/Shell";
import { apiFetchJson, describeApiLoadFailure } from "@/lib/client-auth";

type Stage = {
  stage: string;
  label: string;
  status: string;
  atMs: number | null;
  reason: string | null;
  refs: Record<string, string | number | null>;
};

type Report = {
  lane: string;
  identity: Record<string, unknown>;
  currentStage: string;
  blocked: boolean;
  blockingReason: string | null;
  stages: Stage[];
  summary: string;
};

type ListItem = {
  lane: string;
  id: string;
  symbol: string;
  status: string;
  blocked: boolean;
  blockingReason: string | null;
  currentStage: string;
  updatedAtMs: number | null;
};

type DiscordWindow = {
  label: string;
  decisions: number;
  deliverIntent: number;
  researchOnly: number;
  rejected: number;
  deliveredFinal: number;
  avgQuality: number | null;
  avgDeliveredQuality: number | null;
  highQualityDelivered: number;
  midBandResearchOnly: number;
  subscriberAlertCount: number;
  missedFastMoversProxy: number;
  falsePositiveProxy: number;
};

function stageTone(status: string): "bull" | "warn" | "bear" | "muted" {
  if (status === "OK") return "bull";
  if (status === "PENDING") return "warn";
  if (status === "FAILED") return "bear";
  return "muted";
}

export default function PaperLifecyclePage() {
  const [recent, setRecent] = useState<ListItem[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [discord, setDiscord] = useState<{
    before: DiscordWindow;
    after: DiscordWindow;
    deliverBar: number;
    maxPerFlush: number;
    note: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorTitle, setErrorTitle] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    setErrorTitle(null);
    const result = await apiFetchJson<{ recent?: ListItem[] }>("/api/paper/lifecycle");
    if (!result.ok) {
      const { title, detail } = describeApiLoadFailure(result);
      setErrorTitle(title);
      setErrorDetail(detail);
      setRecent([]);
    } else {
      setRecent(result.data?.recent ?? []);
    }
    const dq = await apiFetchJson<{ report?: typeof discord }>("/api/research/discord-quality");
    if (dq.ok && dq.data?.report) setDiscord(dq.data.report as typeof discord);
    setLoading(false);
  }, []);

  const openItem = useCallback(async (item: ListItem) => {
    const [lane, id] = item.id.split(":");
    const q =
      lane === "legacy"
        ? `/api/paper/lifecycle?lane=legacy&tradeId=${id}`
        : `/api/paper/lifecycle?lane=options&optionTradeId=${id}`;
    const result = await apiFetchJson<{ report?: Report }>(q);
    if (result.ok && result.data?.report) setReport(result.data.report);
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  return (
    <PageContainer>
      <PageHeader
        title="Paper Lifecycle"
        subtitle="Candidate → Discord → Entry → Exit → Graded → Broker V2 — with exact blockers"
      />

      {loading && <LoadingState label="Loading lifecycles…" />}
      {!loading && errorTitle && (
        <ErrorState title={errorTitle} detail={errorDetail ?? undefined} onRetry={loadList} />
      )}

      {discord && (
        <Card title="Discord quality — before vs after bar raise">
          <p style={{ fontSize: 13 }}>
            Deliver bar {discord.deliverBar} · max/flush {discord.maxPerFlush}
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 8 }}>
            {([discord.before, discord.after] as DiscordWindow[]).map((w) => (
              <div key={w.label} style={{ borderTop: "1px solid var(--border,#334)", paddingTop: 8 }}>
                <strong>{w.label}</strong>
                <p style={{ fontSize: 13, margin: "4px 0" }}>Decisions: {w.decisions}</p>
                <p style={{ fontSize: 13, margin: "4px 0" }}>
                  Deliver intent: {w.deliverIntent} · Research-only: {w.researchOnly} · Rejected: {w.rejected}
                </p>
                <p style={{ fontSize: 13, margin: "4px 0" }}>
                  Subscriber SENT: {w.subscriberAlertCount} · Final delivered: {w.deliveredFinal}
                </p>
                <p style={{ fontSize: 13, margin: "4px 0" }}>
                  Avg quality: {w.avgQuality ?? "n/a"} · Avg delivered: {w.avgDeliveredQuality ?? "n/a"}
                </p>
                <p style={{ fontSize: 13, margin: "4px 0" }}>
                  HIGH (≥0.75) delivered: {w.highQualityDelivered} · Mid-band research-only:{" "}
                  {w.midBandResearchOnly}
                </p>
                <p style={{ fontSize: 13, margin: "4px 0" }}>
                  Missed fast-mover proxy: {w.missedFastMoversProxy} · False-positive proxy:{" "}
                  {w.falsePositiveProxy}
                </p>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>{discord.note}</p>
        </Card>
      )}

      <Card title="Recent paper lifecycles">
        {!loading && recent.length === 0 && (
          <EmptyState
            title="No paper trades yet"
            reason="When Supervisor or independent options create paper rows, they appear here with full stage status."
          />
        )}
        <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: 13 }}>
          {recent.map((r) => (
            <li
              key={r.id}
              style={{ borderTop: "1px solid var(--border,#334)", padding: "8px 0", cursor: "pointer" }}
              onClick={() => void openItem(r)}
            >
              <StatusBadge tone={r.blocked ? "bear" : "bull"}>
                {r.blocked ? "BLOCKED" : "OK"}
              </StatusBadge>{" "}
              <strong>{r.symbol}</strong> · {r.lane} · {r.status} · stage {r.currentStage}
              {r.blockingReason ? (
                <div style={{ color: "var(--bear)", marginTop: 2 }}>{r.blockingReason}</div>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>

      {report && (
        <Card title={`Lifecycle — ${report.summary}`}>
          <p style={{ fontSize: 13 }}>
            Lane: {report.lane} · Current: {report.currentStage}
            {report.blocked ? ` · Blocked: ${report.blockingReason}` : ""}
          </p>
          <ol style={{ listStyle: "none", padding: 0, margin: "12px 0 0" }}>
            {report.stages.map((s, i) => (
              <li
                key={s.stage}
                style={{
                  borderLeft: "3px solid var(--border,#445)",
                  padding: "8px 12px",
                  marginBottom: 6,
                  opacity: s.status === "N/A" ? 0.7 : 1,
                }}
              >
                <div style={{ fontWeight: 600 }}>
                  {i + 1}. {s.label}{" "}
                  <StatusBadge tone={stageTone(s.status)}>{s.status}</StatusBadge>
                </div>
                {s.reason && (
                  <pre
                    style={{
                      margin: "4px 0 0",
                      whiteSpace: "pre-wrap",
                      fontSize: "0.75rem",
                      color: s.status === "FAILED" ? "var(--bear)" : "var(--muted)",
                      fontFamily: "inherit",
                    }}
                  >
                    {s.reason}
                  </pre>
                )}
                <DetailsDisclosure summary="refs">
                  <pre style={{ fontSize: 11 }}>{JSON.stringify(s.refs, null, 2)}</pre>
                </DetailsDisclosure>
              </li>
            ))}
          </ol>
        </Card>
      )}
    </PageContainer>
  );
}
