"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageContainer, PageHeader, Card, LoadingState, EmptyState, ErrorState, StatusBadge } from "@/components/ui/Shell";
import { SimpleTable } from "@/components/ui/Table";
import { apiFetchJson, describeApiLoadFailure } from "@/lib/client-auth";

type OppCase = {
  opportunityId: string;
  underlyingSymbol: string;
  setupFamily: string | null;
  deliveryDecision: string;
  acceptanceDecision: string;
  detectedAtMs: number;
};

type CasesResponse = {
  cases?: OppCase[];
  count?: number;
};

export default function IntelligencePage() {
  const [cases, setCases] = useState<OppCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorTitle, setErrorTitle] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErrorTitle(null);
    setErrorDetail(null);
    const result = await apiFetchJson<CasesResponse>("/api/opportunity-cases?limit=40");
    if (!result.ok) {
      const { title, detail } = describeApiLoadFailure(result);
      setErrorTitle(title);
      setErrorDetail(detail);
      setCases([]);
    } else {
      const rows = (result.data?.cases ?? []).map((c) => ({
        opportunityId: String(c.opportunityId),
        underlyingSymbol: String(c.underlyingSymbol),
        setupFamily: c.setupFamily ?? null,
        deliveryDecision: String(c.deliveryDecision),
        acceptanceDecision: String(c.acceptanceDecision),
        detectedAtMs: Number(c.detectedAtMs),
      }));
      setCases(rows);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <PageContainer>
      <PageHeader
        title="Intelligence"
        subtitle="Ranked opportunity cases from the deterministic options pipeline. LIVE records only — not simulated performance."
      />
      {loading && <LoadingState label="Loading opportunity cases…" />}
      {!loading && errorTitle && (
        <ErrorState title={errorTitle} detail={errorDetail ?? undefined} onRetry={load} />
      )}
      {!loading && !errorTitle && cases.length === 0 && (
        <EmptyState title="No cases yet" reason="Cases appear when the independent options monitor evaluates candidates." />
      )}
      {!loading && !errorTitle && cases.length > 0 && (
        <Card title="Recent opportunities">
          <SimpleTable
            columns={[
              { key: "symbol", header: "Symbol", render: (r: OppCase) => r.underlyingSymbol },
              { key: "setup", header: "Setup", render: (r: OppCase) => r.setupFamily ?? "—" },
              { key: "accept", header: "Acceptance", render: (r: OppCase) => <StatusBadge tone={r.acceptanceDecision === "accepted" ? "live" : "warn"}>{r.acceptanceDecision}</StatusBadge> },
              { key: "delivery", header: "Delivery", render: (r: OppCase) => r.deliveryDecision },
              { key: "link", header: "", render: (r: OppCase) => <Link href={`/intelligence/${r.opportunityId}`}>Dossier</Link> },
            ]}
            rows={cases}
            rowKey={(r) => r.opportunityId}
            emptyReason="No opportunity cases recorded yet."
          />
        </Card>
      )}
    </PageContainer>
  );
}
