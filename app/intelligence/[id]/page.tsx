"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { PageContainer, PageHeader, Card, LoadingState, EmptyState, ErrorState } from "@/components/ui/Shell";
import { apiFetchJson, describeApiLoadFailure } from "@/lib/client-auth";

type Replay = {
  caseFound: boolean;
  explanationText: string | null;
  auditAnswers: Record<string, unknown>;
  opportunityCase?: Record<string, unknown>;
};

type CaseResponse = {
  replay?: Replay;
};

export default function OpportunityDossierPage() {
  const params = useParams();
  const id = String(params?.id ?? "");
  const [replay, setReplay] = useState<Replay | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorTitle, setErrorTitle] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setErrorTitle(null);
    setErrorDetail(null);
    const result = await apiFetchJson<CaseResponse>(`/api/opportunity-cases/${encodeURIComponent(id)}`);
    if (!result.ok) {
      const { title, detail } = describeApiLoadFailure(result);
      setReplay(null);
      setErrorTitle(title);
      setErrorDetail(detail);
    } else {
      setReplay(result.data?.replay ?? null);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  return (
    <PageContainer>
      <PageHeader title="Opportunity Intelligence Dossier" subtitle={id} />
      <p><Link href="/intelligence">← Back to Intelligence</Link></p>
      {loading && <LoadingState label="Replaying decision…" />}
      {!loading && errorTitle && (
        <ErrorState title={errorTitle} detail={errorDetail ?? undefined} onRetry={load} />
      )}
      {!loading && !errorTitle && replay && !replay.caseFound && (
        <EmptyState title="Case not found" reason="No stored record for this opportunity ID." />
      )}
      {!loading && !errorTitle && replay?.caseFound && (
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
