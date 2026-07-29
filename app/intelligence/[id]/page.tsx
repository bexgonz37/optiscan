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

type ContractCandidate = {
  optionSymbol?: string | null;
  strategyKey?: string | null;
  observedAtMs?: number | null;
  bid?: number | null;
  ask?: number | null;
  spreadPct?: number | null;
  reason?: string | null;
};

type ContractUpdate = {
  previousOptionSymbol?: string | null;
  newOptionSymbol?: string | null;
  changedAtMs?: number | null;
  reason?: string | null;
  originalContractRemainsValid?: boolean | null;
};

function money(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : "Unavailable";
}

function timestamp(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? new Date(n).toLocaleString() : "Unavailable";
}

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

  const opportunity = replay?.opportunityCase as any;
  const candidates = (opportunity?.contractCandidates ?? []) as ContractCandidate[];
  const updates = (opportunity?.contractUpdates ?? []) as ContractUpdate[];

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
          <Card title="Thesis and contract history">
            <dl className="detail-grid">
              <div><dt>Thesis fingerprint</dt><dd>{opportunity?.thesisFingerprint ?? "Unavailable"}</dd></div>
              <div><dt>Session date</dt><dd>{opportunity?.sessionDate ?? "Unavailable"}</dd></div>
              <div><dt>Original contract</dt><dd>{opportunity?.selectedContract?.optionSymbol ?? "Unavailable"}</dd></div>
              <div><dt>Original opening</dt><dd>{timestamp(opportunity?.frozenTrade?.frozenAtMs)}</dd></div>
              <div><dt>Frozen entry</dt><dd>{money(opportunity?.frozenTrade?.entryMid)}</dd></div>
              <div><dt>Targets</dt><dd>{money(opportunity?.frozenTrade?.targetT1)} / {money(opportunity?.frozenTrade?.targetT2)}</dd></div>
              <div><dt>Stop</dt><dd>{money(opportunity?.frozenTrade?.stop)}</dd></div>
              <div><dt>Discord proof</dt><dd>{opportunity?.discord?.messageId ?? "No verified message ID"}</dd></div>
            </dl>

            <h3 style={{ marginTop: "1.25rem" }}>Contract observations</h3>
            {candidates.length ? (
              <div style={{ overflowX: "auto" }}>
                <table>
                  <thead>
                    <tr><th>Observed</th><th>Contract</th><th>Strategy</th><th>Quote</th><th>Spread</th><th>Reason</th></tr>
                  </thead>
                  <tbody>
                    {candidates.map((candidate, index) => (
                      <tr key={`${candidate.optionSymbol ?? "contract"}-${candidate.observedAtMs ?? index}`}>
                        <td>{timestamp(candidate.observedAtMs)}</td>
                        <td>{candidate.optionSymbol ?? "Unavailable"}</td>
                        <td>{candidate.strategyKey ?? "Unavailable"}</td>
                        <td>{money(candidate.bid)} / {money(candidate.ask)}</td>
                        <td>{candidate.spreadPct == null ? "Unavailable" : `${Number(candidate.spreadPct).toFixed(1)}%`}</td>
                        <td>{candidate.reason ?? "Observation attached"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p>No contract observations have been attached.</p>
            )}

            <h3 style={{ marginTop: "1.25rem" }}>Contract replacements</h3>
            {updates.length ? (
              <ul>
                {updates.map((update, index) => (
                  <li key={`${update.newOptionSymbol ?? "replacement"}-${update.changedAtMs ?? index}`}>
                    <strong>{update.previousOptionSymbol ?? "Unavailable"}</strong>
                    {" -> "}
                    <strong>{update.newOptionSymbol ?? "Unavailable"}</strong>
                    {" at "}
                    {timestamp(update.changedAtMs)}
                    {update.reason ? ` (${update.reason})` : ""}
                    {update.originalContractRemainsValid == null
                      ? ""
                      : update.originalContractRemainsValid
                        ? " - original remains valid"
                        : " - original no longer valid"}
                  </li>
                ))}
              </ul>
            ) : (
              <p>No contract replacement has occurred. The original contract remains the tracked opening.</p>
            )}
          </Card>

          <Card title="Audit">
            <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.8rem" }}>{JSON.stringify(replay.auditAnswers, null, 2)}</pre>
          </Card>
        </>
      )}
    </PageContainer>
  );
}
