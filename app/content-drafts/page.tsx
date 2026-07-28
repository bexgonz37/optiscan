"use client";

import { useCallback, useEffect, useState } from "react";
import { PageContainer, PageHeader, Card, LoadingState, ErrorState, StatusBadge } from "@/components/ui/Shell";
import { apiFetchJson, describeApiLoadFailure } from "@/lib/client-auth";

type Draft = {
  id: string;
  content_event_id: string;
  opportunity_case_id: string | null;
  alert_id: string | null;
  category: string;
  template_family: string;
  draft_text: string;
  char_count: number;
  cta_type: string;
  result_type: string | null;
  status: string;
  discord_delivery_status: string;
  final_copy: string | null;
  symbol?: string;
  event_type?: string;
  trading_session_date?: string | null;
  frozen_entry?: number | null;
  created_at_ms: number;
};

export default function ContentDraftsPage() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [selected, setSelected] = useState<Draft | null>(null);
  const [claim, setClaim] = useState<unknown>(null);
  const [edit, setEdit] = useState("");
  const [symbol, setSymbol] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams();
    if (symbol.trim()) qs.set("symbol", symbol.trim());
    if (category.trim()) qs.set("category", category.trim());
    if (status.trim()) qs.set("status", status.trim());
    qs.set("limit", "80");
    const r = await apiFetchJson<{ ok: boolean; drafts: Draft[] }>(`/api/content-drafts?${qs}`);
    if (!r.ok) {
      const { title, detail } = describeApiLoadFailure(r);
      setError(`${title}: ${detail}`);
      setLoading(false);
      return;
    }
    setDrafts(r.data?.drafts ?? []);
    setLoading(false);
  }, [symbol, category, status]);

  useEffect(() => { void load(); }, [load]);

  async function select(d: Draft) {
    setSelected(d);
    setEdit(d.final_copy || d.draft_text);
    setClaim(null);
    const r = await apiFetchJson<{ ok: boolean; draft: Draft; claim: unknown }>(`/api/content-drafts?id=${encodeURIComponent(d.id)}`);
    if (r.ok && r.data) {
      setSelected(r.data.draft);
      setClaim(r.data.claim);
      setEdit(r.data.draft.final_copy || r.data.draft.draft_text);
    }
  }

  async function act(action: string, extra: Record<string, string> = {}) {
    if (!selected) return;
    setMsg(null);
    const r = await apiFetchJson<{ ok: boolean; draft?: Draft; error?: string }>("/api/content-drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: selected.id, action, editedText: edit, finalCopy: edit, ...extra }),
    });
    if (!r.ok || !r.data?.ok) {
      setMsg(r.data?.error ?? "action failed");
      return;
    }
    setMsg(`OK: ${action}`);
    if (r.data.draft) {
      setSelected(r.data.draft as Draft);
      setEdit((r.data.draft as Draft).final_copy || (r.data.draft as Draft).draft_text);
    }
    await load();
  }

  function copy(text: string) {
    void navigator.clipboard.writeText(text);
    setMsg("Copied to clipboard");
  }

  if (loading && drafts.length === 0) return <LoadingState label="Loading content drafts…" />;
  if (error) return <ErrorState title="Content drafts unavailable" detail={error} onRetry={load} />;

  return (
    <PageContainer>
      <PageHeader
        title="Content Drafts"
        subtitle="Owner-only Twitter/X suggestions — deterministic, never auto-posted. Discord copies route to Recaps."
      />

      <Card title="Filters">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input placeholder="Ticker" value={symbol} onChange={(e) => setSymbol(e.target.value)} style={{ padding: 6 }} />
          <input placeholder="Category" value={category} onChange={(e) => setCategory(e.target.value)} style={{ padding: 6 }} />
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ padding: 6 }}>
            <option value="">All statuses</option>
            <option value="GENERATED">GENERATED</option>
            <option value="APPROVED">APPROVED</option>
            <option value="REJECTED">REJECTED</option>
            <option value="EDITED">EDITED</option>
            <option value="MANUALLY_POSTED">MANUALLY_POSTED</option>
          </select>
          <button type="button" onClick={() => void load()}>Refresh</button>
          {msg && <span style={{ opacity: 0.8 }}>{msg}</span>}
        </div>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
        <Card title={`Drafts (${drafts.length})`}>
          <div style={{ maxHeight: 640, overflow: "auto" }}>
            {drafts.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => void select(d)}
                style={{
                  display: "block", width: "100%", textAlign: "left", padding: 10, marginBottom: 6,
                  background: selected?.id === d.id ? "rgba(80,140,255,0.15)" : "transparent",
                  border: "1px solid rgba(255,255,255,0.08)", cursor: "pointer",
                }}
              >
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <strong>{d.symbol ?? "?"}</strong>
                  <StatusBadge>{d.category}</StatusBadge>
                  <StatusBadge>{d.status}</StatusBadge>
                  <StatusBadge>{d.discord_delivery_status}</StatusBadge>
                </div>
                <div style={{ opacity: 0.75, fontSize: 12, marginTop: 4 }}>
                  {d.event_type ?? ""} · {d.cta_type} · {d.char_count} chars
                </div>
                <div style={{ fontSize: 13, marginTop: 6, whiteSpace: "pre-wrap" }}>
                  {(d.draft_text || "").slice(0, 140)}{(d.draft_text || "").length > 140 ? "…" : ""}
                </div>
              </button>
            ))}
            {drafts.length === 0 && <p style={{ opacity: 0.7 }}>No drafts yet. Enable CONTENT_EVENTS_ENABLED=1 with DISCORD_WEBHOOK_RECAP set.</p>}
          </div>
        </Card>

        <Card title="Detail">
          {!selected && <p style={{ opacity: 0.7 }}>Select a draft</p>}
          {selected && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 13, opacity: 0.85 }}>
                <div>Event: {selected.content_event_id}</div>
                <div>Case: {selected.opportunity_case_id ?? "—"}</div>
                <div>Alert: {selected.alert_id ?? "—"}</div>
                <div>Result type: {selected.result_type ?? "—"}</div>
                <div>Session: {selected.trading_session_date ?? "—"}</div>
                <div>Frozen entry: {selected.frozen_entry ?? "—"}</div>
                <div>Template: {selected.template_family}</div>
              </div>
              <textarea
                value={edit}
                onChange={(e) => setEdit(e.target.value)}
                rows={10}
                style={{ width: "100%", fontFamily: "inherit", padding: 8 }}
              />
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" onClick={() => copy(edit)}>Copy</button>
                <button type="button" onClick={() => void act("approve")}>Approve</button>
                <button type="button" onClick={() => void act("reject")}>Reject</button>
                <button type="button" onClick={() => void act("edit")}>Save edit</button>
                <button type="button" onClick={() => void act("save_final")}>Save final copy</button>
                <button type="button" onClick={() => void act("mark_posted")}>Mark manually posted</button>
                <button type="button" onClick={() => void act("regenerate")}>Regenerate (other template)</button>
              </div>
              {claim != null && (
                <pre style={{ fontSize: 11, maxHeight: 220, overflow: "auto", background: "rgba(0,0,0,0.25)", padding: 8 }}>
                  {JSON.stringify(claim, null, 2)}
                </pre>
              )}
            </div>
          )}
        </Card>
      </div>
    </PageContainer>
  );
}
