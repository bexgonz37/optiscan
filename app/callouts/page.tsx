"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  PageContainer, Card, StatusBadge, EmptyState, LoadingState, ErrorState, KeyValue,
} from "@/components/ui/Shell";
import { apiFetch } from "@/lib/client-auth";
import { SwingResearchPanel } from "@/components/SwingResearchPanel";

/**
 * Callouts (consolidated). ONE owner-facing destination for every opportunity
 * horizon. Read-only: it renders canonical callouts produced by the agent
 * Supervisor (via /api/callouts) — the frontend never recomputes a trading
 * decision. Puts are research-only; nothing here implies a guaranteed outcome.
 *
 * The old Options Callouts (/alerts) and Swing Research (/swing) URLs still work;
 * their live-callout experience is merged here behind simple tabs.
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

// Tab keys are stable (deep-linkable via ?tab=); labels are what the owner reads.
const TABS: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  { key: "0dte", label: "0DTE" },
  { key: "1-5", label: "1–5 DTE" },
  { key: "6-10", label: "6–10 DTE" },
  { key: "11-35", label: "11–35 DTE" },
  { key: "36-90", label: "36–90 DTE" },
  { key: "stocks", label: "Momentum Stocks" },
  { key: "puts", label: "Put Research" },
  { key: "rejected", label: "Rejected / Blocked" },
  { key: "swing", label: "Swing Research" },
];

const HORIZON_BY_TAB: Record<string, string> = {
  "0dte": "0DTE",
  "1-5": "1–5 DTE",
  "6-10": "6–10 DTE",
  "11-35": "11–35 DTE",
  "36-90": "36–90 DTE",
};

const BLOCKED_STATUSES = new Set(["NO_VALID_CONTRACT", "DATA_STALE", "INVALIDATED", "BLOCKED"]);

function tone(status: string): "bull" | "warn" | "bear" | "muted" {
  if (status === "ACTIONABLE_NOW") return "bull";
  if (status === "NEAR_TRIGGER" || status === "DEVELOPING") return "warn";
  if (status === "INVALIDATED" || status === "DATA_STALE") return "bear";
  return "muted";
}

/** "2026-07-14" → "Jul 14". Falls back to the raw string on any parse issue. */
function expiryLabel(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** How many days to expiry, shown as a plain badge (0DTE = expires today). */
function dteLabel(dte: number | null): string {
  if (dte == null) return "";
  if (dte <= 0) return "0DTE · expires today";
  if (dte === 1) return "1DTE · expires tomorrow";
  return `${dte}DTE`;
}

/** Plain-English contract line, e.g. "SPY $755 CALL · exp Jul 14 · 0DTE". */
function contractHeadline(c: Callout): string {
  const side = (c.contract?.side ?? (c.direction === "bearish" ? "put" : "call")).toUpperCase();
  const strike = c.contract?.strike != null ? `$${c.contract.strike}` : "";
  const parts = [`${c.ticker} ${strike} ${side}`.replace(/\s+/g, " ").trim()];
  if (c.contract?.expiration) parts.push(`exp ${expiryLabel(c.contract.expiration)}`);
  const d = dteLabel(c.contract?.dte ?? null);
  if (d) parts.push(d);
  return parts.join(" · ");
}

function isStock(c: Callout): boolean {
  return /momentum|stock/i.test(c.strategyAgent ?? "");
}

function isRejected(c: Callout): boolean {
  return BLOCKED_STATUSES.has(c.status) || Boolean(c.primaryBlockingReason);
}

function matchesTab(c: Callout, tab: string): boolean {
  if (tab === "all") return true;
  if (tab === "puts") return c.direction === "bearish";
  if (tab === "stocks") return isStock(c);
  if (tab === "rejected") return isRejected(c);
  const horizon = HORIZON_BY_TAB[tab];
  if (horizon) return c.horizon === horizon;
  return true;
}

function CalloutsInner() {
  const search = useSearchParams();
  const initialTab = search?.get("tab") ?? "all";
  const [tab, setTab] = useState(TABS.some((t) => t.key === initialTab) ? initialTab : "all");
  const [callouts, setCallouts] = useState<Callout[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string>("");
  const [tickers, setTickers] = useState("SPY,QQQ");

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/callouts?tickers=${encodeURIComponent(tickers)}`, { cache: "no-store" });
      if (res.status === 401) { setError("This dashboard needs your private OptiScan access token."); return; }
      const r = await res.json();
      setCallouts(r?.callouts ?? []);
      setNote(r?.note ?? "");
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? "Could not load callouts.");
    }
  }, [tickers]);

  useEffect(() => {
    if (tab === "swing") return; // swing tab uses its own on-demand scan
    load();
    const id = setInterval(load, 20000);
    return () => clearInterval(id);
  }, [load, tab]);

  const filtered = useMemo(
    () => (callouts ?? []).filter((c) => matchesTab(c, tab)),
    [callouts, tab],
  );

  const tabBar = (
    <div className="callouts-tabs" role="tablist" aria-label="Callout horizons">
      {TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={tab === t.key}
          className={`callouts-tab${tab === t.key ? " on" : ""}`}
          onClick={() => setTab(t.key)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );

  return (
    <PageContainer>
      <div className="axiom-compat-note">
        This is the one place for every horizon. Looking for accuracy or your
        trade journal? They live in <Link href="/performance">Performance</Link>.
      </div>
      {tabBar}

      {tab === "swing" ? (
        <SwingResearchPanel />
      ) : error && !callouts ? (
        <ErrorState detail={error} onRetry={load} />
      ) : !callouts ? (
        <Card title="Loading callouts"><LoadingState rows={4} /></Card>
      ) : (
        <>
          <Card title="Symbols" meta={note}>
            <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13 }}>
              <span style={{ opacity: 0.7 }}>Tickers</span>
              <input value={tickers} onChange={(e) => setTickers(e.target.value)} onBlur={load} style={{ padding: "3px 6px", width: 200 }} />
            </label>
          </Card>

          {filtered.length === 0 ? (
            <Card title="No callouts">
              <EmptyState icon="🔬" title="No callouts match this tab" reason="No agent produced a callout for these tickers/horizon right now. This is expected outside active momentum or when data is stale — nothing is fabricated." />
            </Card>
          ) : (
            filtered.map((c) => (
              <Card key={c.key} title={`${c.ticker} · ${c.horizon} · ${c.direction === "bearish" ? "PUT (research)" : "CALL"}`} meta={c.strategyAgent}>
                <div style={{ marginBottom: 6 }}><StatusBadge tone={tone(c.status)}>{c.status.replace(/_/g, " ")}</StatusBadge></div>
                <p style={{ margin: "6px 0", fontSize: 14 }}>{c.reason}</p>
                {c.contract && (
                  <>
                    <KeyValue k="Contract" v={contractHeadline(c)} />
                    <KeyValue
                      k="Price"
                      v={[
                        c.contract.mid != null ? `mid $${Number(c.contract.mid).toFixed(2)}` : null,
                        c.contract.bid != null && c.contract.ask != null ? `(bid $${Number(c.contract.bid).toFixed(2)} / ask $${Number(c.contract.ask).toFixed(2)})` : null,
                        c.contract.delta != null ? `Δ ${Math.abs(Number(c.contract.delta)).toFixed(2)}` : null,
                        c.contract.spreadPct != null ? `spread ${Number(c.contract.spreadPct).toFixed(2)}%` : null,
                      ].filter(Boolean).join(" · ")}
                    />
                    <div style={{ fontSize: 11, opacity: 0.45, marginTop: 2 }}>{c.contract.optionSymbol ?? ""}</div>
                  </>
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
        </>
      )}
    </PageContainer>
  );
}

export default function CalloutsPage() {
  return (
    <Suspense fallback={<PageContainer><Card title="Loading callouts"><LoadingState rows={4} /></Card></PageContainer>}>
      <CalloutsInner />
    </Suspense>
  );
}
