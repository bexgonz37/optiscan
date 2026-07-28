"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { EmptyState, LoadingState, ErrorState } from "@/components/ui/Shell";
import { apiFetch } from "@/lib/client-auth";
import { SwingResearchPanel } from "@/components/SwingResearchPanel";
import { DEMO_CALLOUTS, DEMO_CALLOUTS_NOTE, isSupervisorRoutingNote } from "@/lib/dashboard/demo-callouts";
import { isUiReviewMode } from "@/lib/dashboard/ui-review";
import { TermSpark, actionTone } from "@/components/terminal/TermViz";

/**
 * Live Options — compact ranked scanner. Canonical supervisor callouts.
 * SIGNAL / CONTRACT / ENTRY / FINAL ACTION are separate visual states.
 */

type Callout = {
  key: string;
  status: string;
  ticker: string;
  direction: "bullish" | "bearish";
  strategyAgent: string;
  horizon: string;
  reason: string;
  contract: {
    optionSymbol: string | null;
    strike: number | null;
    expiration: string | null;
    dte: number | null;
    side: string | null;
    bid: number | null;
    ask: number | null;
    mid: number | null;
    spreadPct: number | null;
    delta?: number | null;
    iv?: number | null;
    volume?: number | null;
    openInterest?: number | null;
  } | null;
  underlyingPrice: number | null;
  confidenceTier: "HIGH" | "MEDIUM" | "LOW";
  estimatedEntry: number | null;
  entryStatusLabel: string;
  quoteFreshness: string;
  contractScore: number | null;
  portfolioRank?: number | null;
  evidenceStatus: string;
  sampleSize: number;
  modelState: string;
  probability: number | null;
  actionable: boolean;
  waitFor?: string | null;
  doNotEnter?: string | null;
  currently?: string | null;
  alreadyHappened?: string | null;
  researchOnlyWarning: string | null;
  insufficientEvidenceWarning: string | null;
  primaryBlockingReason: string | null;
  demo?: boolean;
};

type RowView = {
  c: Callout;
  rank: number;
  systemAction: "SEND" | "WATCH" | "RESEARCH" | "BLOCK" | "WAIT";
  signalScore: number | null;
  contractState: "READY" | "THIN" | "UNAVAILABLE";
  entryState: "ACTIONABLE" | "WAIT" | "BLOCK" | "UNKNOWN";
  finalAction: "SEND" | "WATCH" | "RESEARCH" | "BLOCK" | "WAIT";
  actionScore: number | null;
  reason: string;
  risk: string;
  undSpark: number[];
  premSpark: number[];
};

const TABS: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  { key: "0dte", label: "0DTE" },
  { key: "1-5", label: "1–5" },
  { key: "6-10", label: "6–10" },
  { key: "11-35", label: "11–35" },
  { key: "36-90", label: "36–90" },
  { key: "puts", label: "Puts" },
  { key: "rejected", label: "Blocked" },
  { key: "swing", label: "Swing" },
];

const HORIZON_BY_TAB: Record<string, string> = {
  "0dte": "0DTE",
  "1-5": "1–5 DTE",
  "6-10": "6–10 DTE",
  "11-35": "11–35 DTE",
  "36-90": "36–90 DTE",
};

const BLOCKED = new Set(["NO_VALID_CONTRACT", "DATA_STALE", "INVALIDATED", "BLOCKED"]);

function money(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? `$${v.toFixed(2)}` : "—";
}

function mapRow(c: Callout, rank: number): RowView {
  const bid = c.contract?.bid ?? null;
  const ask = c.contract?.ask ?? null;
  const mid = c.contract?.mid ?? null;
  const spread = c.contract?.spreadPct ?? null;
  const hasQuote = (bid != null && ask != null) || mid != null;
  const stale = c.quoteFreshness !== "fresh" || BLOCKED.has(c.status) || c.status === "DATA_STALE";
  const contractUnavailable = !hasQuote || !c.contract?.optionSymbol || stale;

  let contractState: RowView["contractState"] = "READY";
  if (contractUnavailable) contractState = "UNAVAILABLE";
  else if (spread != null && spread > 12) contractState = "THIN";

  const signalScore =
    c.contractScore != null && Number.isFinite(c.contractScore)
      ? Math.round(Math.max(0, Math.min(100, Number(c.contractScore))))
      : c.confidenceTier === "HIGH" ? 85 : c.confidenceTier === "MEDIUM" ? 65 : 40;

  let entryState: RowView["entryState"] = "UNKNOWN";
  if (c.primaryBlockingReason || BLOCKED.has(c.status)) entryState = "BLOCK";
  else if (c.entryStatusLabel === "ACTIONABLE NOW" && c.actionable) entryState = "ACTIONABLE";
  else if (contractUnavailable || c.estimatedEntry == null) entryState = "WAIT";
  else entryState = "WAIT";

  let systemAction: RowView["systemAction"] = "WATCH";
  if (c.researchOnlyWarning) systemAction = "RESEARCH";
  if (entryState === "BLOCK" || c.primaryBlockingReason) systemAction = "BLOCK";
  else if (entryState === "ACTIONABLE" && contractState === "READY") systemAction = "SEND";
  else if (contractState === "UNAVAILABLE") systemAction = "WAIT";

  // Final action cannot show SEND when contract data missing — even if signal is 99.
  let finalAction: RowView["finalAction"] = systemAction;
  if (contractState === "UNAVAILABLE") finalAction = "WAIT";
  if (entryState === "BLOCK") finalAction = "BLOCK";

  let actionScore: number | null = signalScore;
  if (contractState === "UNAVAILABLE") actionScore = Math.min(signalScore, 25);
  else if (contractState === "THIN") actionScore = Math.min(signalScore, 45);
  if (finalAction === "BLOCK") actionScore = Math.min(actionScore, 15);
  if (finalAction === "WAIT") actionScore = Math.min(actionScore, 55);
  if (finalAction === "SEND") actionScore = Math.max(actionScore, Math.round(signalScore * 0.85));

  const reason = contractUnavailable
    ? "Contract data unavailable"
    : (c.reason?.slice(0, 90) ?? "—");
  const risk = c.primaryBlockingReason
    ? c.primaryBlockingReason.replace(/_/g, " ")
    : (c.doNotEnter?.slice(0, 70) ?? (spread != null && spread > 10 ? `Spread ${spread.toFixed(1)}%` : "Premium decay"));

  const und = c.underlyingPrice;
  const undSpark = und != null ? [und * 0.998, und * 0.999, und, und * 1.001, und].map((x) => +x.toFixed(3)) : [];
  // Only use synthetic und spark in review when demo; otherwise leave empty if no series
  const undSparkOut = c.demo ? undSpark : (und != null ? [und] : []);
  const prem = mid ?? c.estimatedEntry;
  const premSpark = c.demo && prem != null
    ? [prem * 0.92, prem * 0.96, prem, prem * 1.04, prem * 1.02].map((x) => +x.toFixed(3))
    : [];

  return {
    c,
    rank,
    systemAction,
    signalScore,
    contractState,
    entryState,
    finalAction,
    actionScore,
    reason,
    risk,
    undSpark: undSparkOut.length >= 2 ? undSparkOut : [],
    premSpark,
  };
}

function matchesTab(c: Callout, tab: string): boolean {
  if (tab === "all") return true;
  if (tab === "puts") return c.direction === "bearish";
  if (tab === "rejected") return BLOCKED.has(c.status) || Boolean(c.primaryBlockingReason);
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
  const [note, setNote] = useState("");
  const [tickers, setTickers] = useState("SPY,QQQ");
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (isUiReviewMode()) {
      setCallouts(DEMO_CALLOUTS as Callout[]);
      setNote(DEMO_CALLOUTS_NOTE);
      setError(null);
      return;
    }
    try {
      const res = await apiFetch(`/api/callouts?tickers=${encodeURIComponent(tickers)}`, { cache: "no-store" });
      if (res.status === 401) {
        setError("This dashboard needs your private OptiScan access token.");
        return;
      }
      const r = await res.json();
      const rows: Callout[] = r?.callouts ?? [];
      setCallouts(rows);
      const rawNote = String(r?.note ?? "");
      setNote(isSupervisorRoutingNote(rawNote) ? "" : rawNote);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? "Could not load callouts.");
    }
  }, [tickers]);

  useEffect(() => {
    if (tab === "swing") return;
    load();
    const id = setInterval(load, 20000);
    return () => clearInterval(id);
  }, [load, tab]);

  const filtered = useMemo(
    () => (callouts ?? []).filter((c) => matchesTab(c, tab)),
    [callouts, tab],
  );

  const rows = useMemo(
    () => filtered.map((c, i) => mapRow(c, i + 1)),
    [filtered],
  );

  const counts = useMemo(() => {
    const c = { SEND: 0, WATCH: 0, RESEARCH: 0, BLOCK: 0, WAIT: 0, fresh: 0, stale: 0 };
    for (const r of rows) {
      c[r.finalAction] += 1;
      if (r.c.quoteFreshness === "fresh") c.fresh += 1;
      else c.stale += 1;
    }
    return c;
  }, [rows]);

  if (tab === "swing") {
    return (
      <div className="ui-page cc-term cc-term-live-options">
        <div className="cc-term-strip cc-term-tabs-strip">
          <div className="cc-term-tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.key} type="button" className={`cc-term-tab${tab === t.key ? " on" : ""}`} onClick={() => setTab(t.key)}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <SwingResearchPanel />
      </div>
    );
  }

  return (
    <div className="ui-page cc-term cc-term-live-options">
      <div className="cc-term-strip">
        <div className="cc-term-strip-chips">
          {(["SEND", "WATCH", "RESEARCH", "BLOCK"] as const).map((k) => (
            <div key={k} className={`cc-term-chip ${actionTone(k)}`}>
              <span className="cc-term-chip-label">{k}</span>
              <span className="cc-term-chip-state">{counts[k]}</span>
            </div>
          ))}
          <div className="cc-term-chip ok">
            <span className="cc-term-chip-label">Fresh</span>
            <span className="cc-term-chip-state">{counts.fresh}</span>
          </div>
          <div className="cc-term-chip warn">
            <span className="cc-term-chip-label">Stale</span>
            <span className="cc-term-chip-state">{counts.stale}</span>
          </div>
        </div>
        <div className="cc-term-strip-meta">
          <label className="cc-term-ticker-input">
            <span>Tickers</span>
            <input value={tickers} onChange={(e) => setTickers(e.target.value)} onBlur={load} />
          </label>
        </div>
      </div>

      <div className="cc-term-strip cc-term-tabs-strip">
        <div className="cc-term-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`cc-term-tab${tab === t.key ? " on" : ""}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <p className="cc-term-disclaimer">
        Research only — SIGNAL ≠ FINAL ACTION. Missing chain/quote forces WAIT/BLOCK.{" "}
        <Link href="/performance" className="cc-term-link">Track record</Link>
      </p>
      {note ? <p className="cc-term-footnote info">{note}</p> : null}

      {error && !callouts ? (
        <ErrorState detail={error} onRetry={load} />
      ) : !callouts ? (
        <LoadingState rows={4} />
      ) : rows.length === 0 ? (
        <EmptyState icon="🔬" title="No callouts" reason="No setups for this tab." />
      ) : (
        <>
          <div className="cc-term-setup-scroll term-live-table-wrap">
            <table className="cc-term-setup-table term-live-scanner">
              <thead>
                <tr>
                  <th>#</th><th>Sym</th><th>Und</th><th>Prem</th><th>Side</th><th>Contract</th><th>DTE</th>
                  <th>Strategy</th><th>Final</th><th>Score</th>
                  <th>Signal</th><th>Contract</th><th>Entry</th>
                  <th>Quality</th><th>E / T1 / Stop</th><th>Sprd</th><th>Fresh</th><th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const c = r.c;
                  const side = (c.contract?.side ?? (c.direction === "bearish" ? "put" : "call")).toUpperCase();
                  const t1 = c.estimatedEntry != null ? c.estimatedEntry * 1.35 : null;
                  const stop = c.estimatedEntry != null ? c.estimatedEntry * 0.72 : null;
                  return (
                    <tr
                      key={c.key}
                      className="term-live-row clickable"
                      onClick={() => setExpanded(expanded === c.key ? null : c.key)}
                    >
                      <td>{r.rank}</td>
                      <td className="cc-term-opp-sym">{c.ticker}{c.demo ? " ·DEMO" : ""}</td>
                      <td><TermSpark values={r.undSpark} width={44} height={14} /></td>
                      <td><TermSpark values={r.premSpark} width={44} height={14} /></td>
                      <td>{side}</td>
                      <td className="cc-term-mono">
                        {c.contract?.optionSymbol
                          ? String(c.contract.optionSymbol).slice(0, 18)
                          : "—"}
                      </td>
                      <td>{c.contract?.dte ?? "—"}</td>
                      <td>{c.strategyAgent}</td>
                      <td><span className={`cc-term-pill ${actionTone(r.finalAction)}`}>{r.finalAction}</span></td>
                      <td className="num">{r.actionScore ?? "—"}</td>
                      <td className="num">{r.signalScore ?? "—"}</td>
                      <td>
                        <span className={`cc-term-pill ${r.contractState === "READY" ? "ok" : r.contractState === "THIN" ? "warn" : "bad"}`}>
                          {r.contractState}
                        </span>
                      </td>
                      <td>
                        <span className={`cc-term-pill ${actionTone(r.entryState === "ACTIONABLE" ? "SEND" : r.entryState === "BLOCK" ? "BLOCK" : "WATCH")}`}>
                          {r.entryState}
                        </span>
                      </td>
                      <td>{c.confidenceTier}</td>
                      <td className="cc-term-mono">{money(c.estimatedEntry)} / {money(t1)} / {money(stop)}</td>
                      <td>{c.contract?.spreadPct != null ? `${Number(c.contract.spreadPct).toFixed(1)}%` : "—"}</td>
                      <td>{c.quoteFreshness}</td>
                      <td className="term-reason-cell">
                        <div>{r.reason}</div>
                        <div className="muted">Risk: {r.risk}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="term-mobile-setups">
            <div className="term-setup-cards">
              {rows.slice(0, 10).map((r) => (
                <button
                  key={`m-${r.c.key}`}
                  type="button"
                  className="term-setup-card clickable"
                  onClick={() => setExpanded(expanded === r.c.key ? null : r.c.key)}
                >
                  <div className="term-setup-card-top">
                    <span className="cc-term-opp-sym">{r.c.ticker}</span>
                    <span className={`cc-term-pill ${actionTone(r.finalAction)}`}>{r.finalAction}</span>
                    <span className="term-action-score">{r.actionScore ?? "—"}</span>
                  </div>
                  <div className="term-setup-card-sparks">
                    <TermSpark values={r.undSpark} width={60} height={16} fill />
                    <TermSpark values={r.premSpark} width={60} height={16} />
                  </div>
                  <div className="term-setup-card-meta">
                    SIGNAL {r.signalScore} · CONTRACT {r.contractState} · ENTRY {r.entryState}
                  </div>
                  <div className="term-setup-card-reason">{r.reason}</div>
                  {expanded === r.c.key ? (
                    <div className="term-drilldown">
                      <p>{r.c.reason}</p>
                      <p className="muted">{r.c.contract?.optionSymbol ?? "no contract"}</p>
                      <p className="muted">Status {r.c.status} · quote {r.c.quoteFreshness}</p>
                      {r.c.primaryBlockingReason ? <p className="bad">Block: {r.c.primaryBlockingReason}</p> : null}
                    </div>
                  ) : null}
                </button>
              ))}
            </div>
          </div>

          {expanded ? (
            <div className="cc-term-panel term-desktop-drill">
              <div className="cc-term-panel-body">
                {(() => {
                  const r = rows.find((x) => x.c.key === expanded);
                  if (!r) return null;
                  const c = r.c;
                  return (
                    <>
                      <strong>{c.ticker}</strong> · Technical drilldown
                      <p>{c.reason}</p>
                      <p className="cc-term-mono muted">{c.contract?.optionSymbol ?? "Contract data unavailable"}</p>
                      <p className="muted">
                        Δ {c.contract?.delta ?? "—"} · IV {c.contract?.iv ?? "—"} · OI {c.contract?.openInterest ?? "—"} · vol {c.contract?.volume ?? "—"}
                      </p>
                      <p className="muted">Evidence {c.evidenceStatus} (n={c.sampleSize}) · model {c.modelState}</p>
                      {c.waitFor ? <p>Wait: {c.waitFor}</p> : null}
                      {c.doNotEnter ? <p>Do not enter: {c.doNotEnter}</p> : null}
                    </>
                  );
                })()}
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

export default function CalloutsPage() {
  return (
    <Suspense fallback={<div className="ui-page cc-term"><LoadingState rows={4} /></div>}>
      <CalloutsInner />
    </Suspense>
  );
}
