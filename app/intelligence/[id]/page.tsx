"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { PageContainer, PageHeader, Card, LoadingState, EmptyState } from "@/components/ui/Shell";
import { scanHeaders } from "@/hooks/useScanner";

type Replay = {
  caseFound: boolean;
  explanationText: string | null;
  auditAnswers: Record<string, unknown>;
  opportunityCase?: Record<string, unknown>;
};

export default function OpportunityDossierPage() {
  const params = useParams();
  const id = String(params?.id ?? "");
  const [replay, setReplay] = useState<Replay | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/opportunity-cases/${encodeURIComponent(id)}`, { headers: scanHeaders() });
      if (!r.ok) throw new Error("Case not found");
      const j = await r.json();
      setReplay(j.replay ?? null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  return (
    <PageContainer>
      <PageHeader title="Opportunity Intelligence Dossier" subtitle={id} />
      <p><Link href="/intelligence">← Back to Intelligence</Link></p>
      {loading && <LoadingState label="Replaying decision…" />}
      {error && <EmptyState title="Unavailable" reason={error} />}
      {replay && !replay.caseFound && <EmptyState title="Case not found" reason="No stored record for this opportunity ID." />}
      {replay?.caseFound && (
        <>
          <Card title="Deterministic explanation">
            <pre style={{ whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)", fontSize: "0.85rem" }}>
              {replay.explanationText ?? "No explanation available"}
            </pre>
          </Card>
          <Card title="Strategy agreement">
            <ul>
              {((replay.auditAnswers?.strategiesSupported as string[]) ?? []).map((s) => (
                <li key={s}>Supported: {s}</li>
              ))}
              {((replay.auditAnswers?.strategiesConflicted as string[]) ?? []).map((s) => (
                <li key={s}>Conflicted: {s}</li>
              ))}
            </ul>
          </Card>
          <Card title="Audit">
            <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.8rem" }}>{JSON.stringify(replay.auditAnswers, null, 2)}</pre>
          </Card>
        </>
      )}
    </PageContainer>
  );
}
