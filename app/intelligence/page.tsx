"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageContainer, PageHeader, Card, LoadingState, EmptyState, StatusBadge } from "@/components/ui/Shell";
import { SimpleTable } from "@/components/ui/Table";
import { scanHeaders } from "@/hooks/useScanner";

type OppCase = {
  opportunityId: string;
  underlyingSymbol: string;
  setupFamily: string | null;
  deliveryDecision: string;
  acceptanceDecision: string;
  detectedAtMs: number;
};

export default function IntelligencePage() {
  const [cases, setCases] = useState<OppCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/opportunity-cases?limit=40", { headers: scanHeaders() });
      if (!r.ok) throw new Error("Unable to load opportunity cases");
      const j = await r.json();
      setCases((j.cases ?? []).map((c: Record<string, unknown>) => ({
        opportunityId: c.opportunityId,
        underlyingSymbol: c.underlyingSymbol,
        setupFamily: c.setupFamily,
        deliveryDecision: c.deliveryDecision,
        acceptanceDecision: c.acceptanceDecision,
        detectedAtMs: c.detectedAtMs,
      })));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <PageContainer>
      <PageHeader
        title="Intelligence"
        subtitle="Ranked opportunity cases from the deterministic options pipeline. LIVE records only — not simulated performance."
      />
      {loading && <LoadingState label="Loading opportunity cases…" />}
      {error && <EmptyState title="Could not load" reason={error} />}
      {!loading && !error && cases.length === 0 && (
        <EmptyState title="No cases yet" reason="Cases appear when the independent options monitor evaluates candidates." />
      )}
      {!loading && cases.length > 0 && (
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
