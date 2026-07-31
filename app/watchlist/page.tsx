"use client";

import { useCallback, useEffect, useState } from "react";
import {
  PageContainer,
  Card,
  StatusBadge,
  LoadingState,
  ErrorState,
  type BadgeTone,
} from "@/components/ui/Shell";
import { SimpleTable, type Column } from "@/components/ui/Table";
import { scanHeaders } from "@/hooks/useScanner";
import { openLiveChart } from "@/lib/open-chart";
import { createPollGuard, isAbortError } from "@/lib/dashboard/poll-guard";

/** Live tape stays fast; plan data moves only on scheduler windows. */
const TAPE_POLL_MS = 3_000;
const PLAN_POLL_MS = 60_000;

/**
 * Watchlist (Phase 5). The set of symbols the scanner is actively monitoring
 * this session, with their live tape reads. Read-only view over the existing
 * loop state (/api/scanner/live?realtimeOnly=1) — no new provider calls, no
 * behavior change to the scanner.
 */

type Row = {
  symbol: string;
  price?: number | null;
  movePct?: number | null;
  shortRate?: number | null;
  direction?: string | null;
  confidence?: number | null;
  relVol?: number | null;
  aboveVwap?: boolean;
  core?: boolean;
};

type PlanRow = {
  symbol: string;
  bias: "bullish" | "bearish";
  rank: number;
  triggerText?: string | null;
  invalidationText?: string | null;
  thesis?: string | null;
  diagnosticReason?: string | null;
  thesisScore?: number | null;
  openReadinessScore?: number | null;
};

type EvidenceCompleteness = {
  candidatesConsidered?: number;
  vwap?: {
    total?: number; live?: number; priorSession?: number; stale?: number;
    unavailable?: number; usableForWatchlist?: number; usablePct?: number | null;
  };
  marketContext?: { available?: boolean; quality?: string; broadDirection?: string; relativeStrength?: string };
  blockers?: string[];
};

type OvernightPlan = {
  recommendations?: PlanRow[];
  needsMoreData?: PlanRow[];
  omitted?: PlanRow[];
  evidenceCompleteness?: EvidenceCompleteness | null;
};

/** Professional Watchlist row — actual ticker levels, not internal diagnostics. */
type ProTrigger = { price: number; sourceLevelName: string };
type ProRow = {
  symbol: string;
  setupType: string;
  callAbove?: ProTrigger | null;
  putBelow?: ProTrigger | null;
  reason: string;
  sourceLevels?: Array<{ name: string; value: number; origin: string }>;
  freshness: string;
  state: string;
  catalyst?: string | null;
  changedSinceOvernight?: boolean;
  changes?: string[];
  rank: number;
};
type ProPlan = {
  tradingDay?: string;
  phase?: string;
  rows?: ProRow[];
  needsMoreData?: Array<{ symbol: string; missing: string[] }>;
  marketAlignment?: string | null;
};
type ProResponse = {
  enabled?: boolean;
  overnightPlan?: ProPlan | null;
  premarketUpdate?: ProPlan | null;
};

const STATE_LABEL: Record<string, string> = {
  OVERNIGHT_PLAN: "Overnight Plan",
  PREMARKET_UPDATE: "Premarket Update",
  TRIGGERED_TODAY: "Triggered Today",
  INVALIDATED: "Invalidated",
  NEEDS_MORE_DATA: "Needs More Data",
};

function stateTone(state: string): BadgeTone {
  if (state === "TRIGGERED_TODAY") return "live";
  if (state === "INVALIDATED") return "bear";
  if (state === "NEEDS_MORE_DATA") return "warn";
  return "muted";
}

const money = (n: number) => `$${Number(n).toFixed(2)}`;

/** One card per ticker. Levels first, diagnostics last. */
function ProCard({ row }: { row: ProRow }) {
  return (
    <button type="button" className="ui-list-row" onClick={() => openLiveChart(row.symbol)}>
      <strong>#{row.rank} {row.symbol} · {row.setupType}</strong>
      {row.callAbove ? <span>CALLS ABOVE {money(row.callAbove.price)} ({row.callAbove.sourceLevelName})</span> : null}
      {row.putBelow ? <span>PUTS BELOW {money(row.putBelow.price)} ({row.putBelow.sourceLevelName})</span> : null}
      <span>{row.reason}</span>
      {row.catalyst ? <span>Catalyst: {row.catalyst}</span> : null}
      <span>
        <StatusBadge tone={stateTone(row.state)}>{STATE_LABEL[row.state] ?? row.state}</StatusBadge>
        {row.changedSinceOvernight ? " · changed since overnight" : ""}
      </span>
      {row.changedSinceOvernight && row.changes?.length ? <small>{row.changes.join("; ")}</small> : null}
      <small>
        Source levels: {(row.sourceLevels ?? []).map((l) => `${l.name} ${money(l.value)}`).join(" · ") || "—"}
      </small>
      <small>As of: {row.freshness}</small>
    </button>
  );
}

function dirTone(direction?: string | null): BadgeTone {
  const d = String(direction ?? "").toLowerCase();
  if (d === "bullish") return "bull";
  if (d === "bearish") return "bear";
  return "muted";
}

function fmtPct(v?: number | null): string {
  if (v == null) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

export default function WatchlistPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [running, setRunning] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<OvernightPlan | null>(null);
  const [pro, setPro] = useState<ProResponse | null>(null);

  // Live tape — genuinely fast-moving, and /api/scanner/live answers in ~0.4s.
  const loadTape = useCallback(async (signal: AbortSignal) => {
    try {
      const res = await fetch("/api/scanner/live?realtimeOnly=1", { cache: "no-store", headers: scanHeaders(), signal });
      const body = await res.json();
      const rt = body?.realtime ?? {};
      const tape: Row[] = Array.isArray(rt.tape) ? rt.tape : Array.isArray(rt.movers) ? rt.movers : [];
      setRows(tape);
      setRunning(Boolean(rt.running));
      setError(null);
    } catch (err: any) {
      if (isAbortError(err)) return;
      setError(err?.message ?? "Could not load the watchlist.");
    }
  }, []);

  // Plan data changes only when a scheduler window runs, and /api/now is the
  // slowest endpoint on the page — polling it on the tape cadence is what
  // exhausted the browser connection pool. It belongs on its own slow tick.
  const loadPlans = useCallback(async (signal: AbortSignal) => {
    try {
      const planRes = await fetch("/api/now", { cache: "no-store", headers: scanHeaders(), signal });
      if (planRes.ok) setPlan((await planRes.json())?.overnight ?? null);
    } catch (err) {
      if (!isAbortError(err)) { /* keep the last good plan rather than blanking */ }
    }
    // Professional Watchlist is additive: a failure here must never blank the page.
    try {
      const proRes = await fetch("/api/research/watchlist/professional", { cache: "no-store", headers: scanHeaders(), signal });
      if (proRes.ok) setPro(await proRes.json());
    } catch { /* leave the professional cards absent */ }
  }, []);

  // Manual retry from the error state. Its own signal, so it is independent of
  // the interval guards and cannot be aborted by an unrelated unmount.
  const retryTape = useCallback(() => {
    void loadTape(new AbortController().signal);
  }, [loadTape]);

  useEffect(() => {
    const tapeGuard = createPollGuard();
    const planGuard = createPollGuard();
    void tapeGuard.run(loadTape);
    void planGuard.run(loadPlans);
    const tapeId = setInterval(() => { void tapeGuard.run(loadTape); }, TAPE_POLL_MS);
    const planId = setInterval(() => { void planGuard.run(loadPlans); }, PLAN_POLL_MS);
    return () => {
      clearInterval(tapeId);
      clearInterval(planId);
      tapeGuard.dispose();
      planGuard.dispose();
    };
  }, [loadTape, loadPlans]);

  const columns: Column<Row>[] = [
    { key: "symbol", header: "Symbol", render: (r: Row) => (
      <button type="button" className="ui-btn ui-btn-sm" onClick={() => openLiveChart(r.symbol)} title="Open chart">
        {r.symbol}{r.core ? " ★" : ""}
      </button>
    ) },
    { key: "price", header: "Price", align: "right", render: (r: Row) => (r.price != null ? `$${Number(r.price).toFixed(2)}` : "—") },
    { key: "move", header: "Day move", align: "right", render: (r: Row) => (
      <span style={{ color: (r.movePct ?? 0) > 0 ? "var(--bull)" : (r.movePct ?? 0) < 0 ? "var(--bear)" : undefined }}>{fmtPct(r.movePct)}</span>
    ) },
    { key: "rate", header: "Speed", align: "right", render: (r: Row) => (r.shortRate != null ? `${r.shortRate > 0 ? "+" : ""}${r.shortRate.toFixed(2)}%/m` : "—") },
    { key: "rvol", header: "RVOL", align: "right", render: (r: Row) => (r.relVol != null ? `${r.relVol.toFixed(1)}×` : "—") },
    { key: "vwap", header: "VWAP", render: (r: Row) => (r.aboveVwap == null ? "—" : r.aboveVwap ? "above" : "below") },
    { key: "dir", header: "Bias", render: (r: Row) => <StatusBadge tone={dirTone(r.direction)}>{r.direction ?? "—"}</StatusBadge> },
  ];

  const sorted = (rows ?? []).slice().sort((a, b) => Math.abs(b.movePct ?? 0) - Math.abs(a.movePct ?? 0));
  const planRows = plan?.recommendations ?? [];
  const needsMoreData = plan?.needsMoreData ?? [];
  const omitted = plan?.omitted ?? [];
  const completeness = plan?.evidenceCompleteness ?? null;

  // Prefer the premarket update when one exists: it is the fresher product.
  const proPlan = pro?.premarketUpdate ?? pro?.overnightPlan ?? null;
  const proRows = proPlan?.rows ?? [];
  const proGroups = Array.from(
    proRows.reduce((map, r) => {
      if (!map.has(r.setupType)) map.set(r.setupType, [] as ProRow[]);
      map.get(r.setupType)!.push(r);
      return map;
    }, new Map<string, ProRow[]>()).entries(),
  ).sort((a, b) => a[1][0].rank - b[1][0].rank);

  return (
    <PageContainer>
      {proPlan ? (
        <Card
          title={proPlan.phase === "PREMARKET_UPDATE" ? "Premarket Update" : "Overnight Plan"}
          meta={`${proRows.length} setups · ${proPlan.tradingDay ?? ""}`}
          actions={proPlan.marketAlignment ? <StatusBadge tone="muted">{proPlan.marketAlignment}</StatusBadge> : undefined}
        >
          {proRows.length ? (
            <div className="stack-gap">
              {proGroups.map(([setupType, groupRows]) => (
                <div key={setupType} className="stack-gap">
                  <strong>{setupType}</strong>
                  {groupRows.map((r) => <ProCard key={`${r.symbol}-${r.rank}`} row={r} />)}
                </div>
              ))}
              <small>Verify exact options contracts after the market opens.</small>
            </div>
          ) : (
            <p className="cc-term-empty">No setups met the evidence bar. A premarket update runs before the open.</p>
          )}
        </Card>
      ) : null}
      <Card title="Qualified Plans" meta={`${planRows.length} evidence-backed next-session setups`}>
        {planRows.length ? (
          <div className="stack-gap">
            {planRows.map((item) => (
              <button key={`${item.symbol}-${item.rank}`} type="button" className="ui-list-row" onClick={() => openLiveChart(item.symbol)}>
                <strong>#{item.rank} {item.symbol} {item.bias === "bearish" ? "PUT" : "CALL"}</strong>
                <span>{item.triggerText}</span>
                <span>{item.invalidationText}</span>
                <span>{item.thesis}</span>
                <small>Thesis {item.thesisScore ?? "Unavailable"} · Open readiness {item.openReadinessScore ?? "Unavailable"}</small>
              </button>
            ))}
          </div>
        ) : <p className="cc-term-empty">No qualified next-session plans yet. Premarket revalidation will run before options open.</p>}
      </Card>
      {completeness ? (
        <Card title="Evidence Completeness" meta={`${completeness.candidatesConsidered ?? 0} candidates considered`}>
          <div className="stack-gap">
            <p>
              VWAP evidence: {completeness.vwap?.usableForWatchlist ?? 0} of {completeness.vwap?.total ?? 0} usable
              {completeness.vwap?.usablePct != null ? ` (${completeness.vwap.usablePct}%)` : ""}
              {" — "}live {completeness.vwap?.live ?? 0}, prior session {completeness.vwap?.priorSession ?? 0},
              stale {completeness.vwap?.stale ?? 0}, unavailable {completeness.vwap?.unavailable ?? 0}
            </p>
            <p>
              Market context: {completeness.marketContext?.available ? "usable" : "not usable"}
              {" · quality "}{completeness.marketContext?.quality ?? "UNAVAILABLE"}
              {" · direction "}{completeness.marketContext?.broadDirection ?? "UNAVAILABLE"}
              {" · relative strength "}{completeness.marketContext?.relativeStrength ?? "UNAVAILABLE"}
            </p>
            {(completeness.blockers ?? []).map((b) => <p key={b} className="cc-term-empty">{b}</p>)}
          </div>
        </Card>
      ) : null}
      {needsMoreData.length ? <Card title="Needs More Data" meta={`${needsMoreData.length} omitted from Discord`}>
        <div className="stack-gap">{needsMoreData.map((item) => <p key={item.symbol}><strong>{item.symbol}</strong>: {item.diagnosticReason ?? "Required structure evidence is incomplete."}</p>)}</div>
      </Card> : null}
      {omitted.length ? <Card title="Omitted" meta={`${omitted.length} not publishable`}>
        <div className="stack-gap">{omitted.map((item) => <p key={item.symbol}><strong>{item.symbol}</strong>: {item.diagnosticReason ?? "Not publishable."}</p>)}</div>
      </Card> : null}
      <Card
        title="Monitored symbols"
        meta={rows ? `${rows.length} tracked` : undefined}
        actions={running != null ? <StatusBadge tone={running ? "live" : "warn"}>{running ? "Scanner live" : "Scanner idle"}</StatusBadge> : undefined}
      >
        {error ? (
          <ErrorState detail={error} onRetry={retryTape} />
        ) : rows == null ? (
          <LoadingState label="Loading watchlist…" rows={5} />
        ) : (
          <SimpleTable
            columns={columns}
            rows={sorted}
            rowKey={(r: Row) => r.symbol}
            emptyTitle="No symbols on the tape yet"
            emptyReason={
              running === false
                ? "The scanner loop is idle. It usually starts within ~2 minutes of the server booting; symbols appear here once it begins streaming quotes."
                : "The scanner is running but has not produced a tape read yet. Monitored symbols appear here after the first provider responses."
            }
          />
        )}
      </Card>
    </PageContainer>
  );
}
