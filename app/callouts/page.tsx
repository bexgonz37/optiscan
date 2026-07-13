"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PageContainer, Card, StatusBadge, EmptyState, LoadingState, ErrorState, KeyValue,
} from "@/components/ui/Shell";
import { scanHeaders } from "@/hooks/useScanner";

/**
 * Horizon Callouts (Phase 6). One canonical callout per deduplicated opportunity/
 * horizon from the agent Supervisor. Read-only; puts are research-only; nothing
 * here implies a guaranteed outcome.
 */

type Callout = {
  key: string;
  status: string;
  ticker: string;
  direction: "bullish" | "bearish";
  strategyAgent: string;
  horizon: string;
  reason: string;
  contract: { optionSymbol: string | null; strike: number | null; expiration: string | null; dte: number | null; side: string | null; bid: number | null; ask: number | null; mid: number | null; spreadPct: number | null; delta: number | null } | null;
  quoteFreshness: string;
  contractScore: number | null;
  evidenceStatus: string;
  sampleSize: number;
  modelState: string;
  probability: number | null;
  actionable: boolean;
  researchOnlyWarning: string | null;
  insufficientEvidenceWarning: string | null;
  primaryBlockingReason: string | null;
};

const HORIZONS = ["all", "0DTE", "1–5 DTE", "6–10 DTE", "11–35 DTE", "36–90 DTE"];
const DIRS = ["all", "calls", "put research"];
const STATUSES = ["all", "ACTIONABLE_NOW", "NEAR_TRIGGER", "DEVELOPING", "RESEARCH_ONLY", "NO_VALID_CONTRACT", "DATA_STALE"];

function tone(status: string): "bull" | "warn" | "bear" | "muted" {
  if (status === "ACTIONABLE_NOW") return "bull";
  if (status === "NEAR_TRIGGER" || status === "DEVELOPING") return "warn";
  if (status === "INVALIDATED" || status === "DATA_STALE") return "bear";
  return "muted";
}

export default function CalloutsPage() {
  const [callouts, setCallouts] = useState<Callout[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string>("");
  const [tickers, setTickers] = useState("SPY,QQQ");
  const [fH, setFH] = useState("all");
  const [fD, setFD] = useState("all");
  const [fS, setFS] = useState("all");

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/callouts?tickers=${encodeURIComponent(tickers)}`, { cache: "no-store", headers: scanHeaders() }).then((x) => x.json());
      setCallouts(r?.callouts ?? []);
      setNote(r?.note ?? "");
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? "Could not load callouts.");
    }
  }, [tickers]);

  useEffect(() => { load(); const id = setInterval(load, 20000); return () => clearInterval(id); }, [load]);

  const filtered = useMemo(() => (callouts ?? []).filter((c) => {
    if (fH !== "all" && c.horizon !== fH) return false;
    if (fD === "calls" && c.direction !== "bullish") return false;
    if (fD === "put research" && c.direction !== "bearish") return false;
    if (fS !== "all" && c.status !== fS) return false;
    return true;
  }), [callouts, fH, fD, fS]);

  if (error && !callouts) return <PageContainer><ErrorState detail={error} onRetry={load} /></PageContainer>;
  if (!callouts) return <PageContainer><Card title="Loading callouts"><LoadingState rows={4} /></Card></PageContainer>;

  const sel = (label: string, val: string, set: (v: string) => void, opts: string[]) => (
    <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13, marginRight: 12 }}>
      <span style={{ opacity: 0.7 }}>{label}</span>
      <select value={val} onChange={(e) => set(e.target.value)} style={{ padding: "3px 6px" }}>
        {opts.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );

  return (
    <PageContainer>
      <Card title="Filters" meta={note}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13, marginRight: 12 }}>
            <span style={{ opacity: 0.7 }}>Tickers</span>
            <input value={tickers} onChange={(e) => setTickers(e.target.value)} onBlur={load} style={{ padding: "3px 6px", width: 160 }} />
          </label>
          {sel("Horizon", fH, setFH, HORIZONS)}
          {sel("Direction", fD, setFD, DIRS)}
          {sel("Status", fS, setFS, STATUSES)}
        </div>
      </Card>

      {filtered.length === 0 ? (
        <Card title="No callouts">
          <EmptyState icon="🔬" title="No callouts match" reason="No agent produced a callout for these tickers/filters right now. This is expected outside active momentum or when data is stale — nothing is fabricated." />
        </Card>
      ) : (
        filtered.map((c) => (
          <Card key={c.key} title={`${c.ticker} · ${c.horizon} · ${c.direction === "bearish" ? "PUT (research)" : "CALL"}`} meta={c.strategyAgent}>
            <div style={{ marginBottom: 6 }}><StatusBadge tone={tone(c.status)}>{c.status.replace(/_/g, " ")}</StatusBadge></div>
            <p style={{ margin: "6px 0", fontSize: 14 }}>{c.reason}</p>
            {c.contract && (
              <KeyValue k="Contract" v={`${c.contract.optionSymbol ?? "—"} · Δ${c.contract.delta ?? "—"} · mid ${c.contract.mid ?? "—"} · spread ${c.contract.spreadPct ?? "—"}%`} />
            )}
            <KeyValue k="Quote freshness" v={c.quoteFreshness} tone={c.quoteFreshness === "fresh" ? undefined : "warn"} />
            <KeyValue k="Contract score" v={c.contractScore ?? "—"} />
            <KeyValue k="Evidence" v={`${c.evidenceStatus.replace(/_/g, " ")} (sample ${c.sampleSize})`} />
            <KeyValue k="Model" v={c.probability != null ? `${c.modelState} · p ${(c.probability * 100).toFixed(1)}%` : `${c.modelState.replace(/_/g, " ")} — no probability`} />
            {c.primaryBlockingReason && <KeyValue k="Blocked by" v={c.primaryBlockingReason} tone="warn" />}
            {c.researchOnlyWarning && <p style={{ margin: "6px 0 0", fontSize: 12, opacity: 0.8 }}>🔬 {c.researchOnlyWarning}</p>}
            {c.insufficientEvidenceWarning && <p style={{ margin: "2px 0 0", fontSize: 12, opacity: 0.8 }}>ℹ {c.insufficientEvidenceWarning}</p>}
          </Card>
        ))
      )}
    </PageContainer>
  );
}
