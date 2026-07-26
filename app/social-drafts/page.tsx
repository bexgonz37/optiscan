"use client";

import { useCallback, useEffect, useState } from "react";
import { PageContainer, PageHeader, Card, LoadingState, ErrorState, StatusBadge } from "@/components/ui/Shell";
import { apiFetchJson, describeApiLoadFailure } from "@/lib/client-auth";

type Draft = {
  id: string;
  symbol: string;
  eventType: string;
  contentStatus: string;
  milestonePercent: number | null;
  draftText: string | null;
  editedText: string | null;
};

export default function SocialDraftsPage() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [selected, setSelected] = useState<Draft | null>(null);
  const [edit, setEdit] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const r = await apiFetchJson<{ ok: boolean; drafts: Draft[] }>("/api/social-drafts");
    if (!r.ok) {
      const { title, detail } = describeApiLoadFailure(r);
      setError(`${title}: ${detail}`);
      setLoading(false);
      return;
    }
    setDrafts(r.data?.drafts ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function act(id: string, action: "approve" | "reject" | "edit") {
    await apiFetchJson(`/api/social-drafts/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, editedText: edit || undefined }),
    });
    await load();
  }

  function copy(text: string) {
    void navigator.clipboard.writeText(text);
  }

  if (loading) return <LoadingState label="Loading social drafts…" />;
  if (error) return <ErrorState title="Social drafts unavailable" detail={error} onRetry={load} />;

  return (
    <PageContainer>
      <PageHeader title="X / Twitter Drafts" subtitle="Verified milestones only — never auto-posted" />
      <Card title="Pending drafts" meta={`${drafts.length} items`}>
        {drafts.length === 0 ? (
          <p className="text-sm opacity-70">No drafts yet. They appear when delivered alerts hit verified milestones.</p>
        ) : (
          <ul className="space-y-3">
            {drafts.map((d) => (
              <li key={d.id} className="rounded border border-white/10 p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <StatusBadge tone="warn">{d.contentStatus}</StatusBadge>
                  <strong>{d.symbol}</strong>
                  {d.milestonePercent != null && <span>+{d.milestonePercent}%</span>}
                </div>
                <pre className="whitespace-pre-wrap text-xs opacity-90">{d.editedText ?? d.draftText ?? "(generate draft)"}</pre>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" className="rounded bg-white/10 px-2 py-1 text-xs" onClick={() => { setSelected(d); setEdit(d.editedText ?? d.draftText ?? ""); }}>
                    Edit
                  </button>
                  <button type="button" className="rounded bg-white/10 px-2 py-1 text-xs" onClick={() => copy(d.editedText ?? d.draftText ?? "")}>
                    Copy
                  </button>
                  <button type="button" className="rounded bg-emerald-900/40 px-2 py-1 text-xs" onClick={() => act(d.id, "approve")}>
                    Approve
                  </button>
                  <button type="button" className="rounded bg-red-900/40 px-2 py-1 text-xs" onClick={() => act(d.id, "reject")}>
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {selected && (
        <Card title={`Edit ${selected.symbol}`}>
          <textarea className="min-h-32 w-full rounded bg-black/40 p-2 text-sm" value={edit} onChange={(e) => setEdit(e.target.value)} />
          <button type="button" className="mt-2 rounded bg-white/10 px-3 py-1 text-sm" onClick={() => act(selected.id, "edit")}>
            Save edit
          </button>
        </Card>
      )}
    </PageContainer>
  );
}
