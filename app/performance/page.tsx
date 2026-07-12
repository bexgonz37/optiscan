"use client";

import { useCallback, useEffect, useState } from "react";
import {
  PageContainer,
  ResponsiveGrid,
  Card,
  KeyValue,
  EmptyState,
  LoadingState,
  ErrorState,
} from "@/components/ui/Shell";
import { SimpleTable, type Column } from "@/components/ui/Table";
import { scanHeaders } from "@/hooks/useScanner";

/**
 * Performance (Phase 5). Consolidated track record: alert stats
 * (/api/alerts/stats) + the paper-trading account (/api/paper/trades). Read-only
 * — reuses existing APIs, adds no provider calls and no new trading behavior.
 */

type Stats = {
  totals?: { total?: number; avg_signal?: number | null; false_positives?: number; completed?: number };
  avgMove?: { avg_max_move?: number | null; avg_eod_move?: number | null };
  byCatalyst?: { type: string | null; alerts: number; avg_max_move: number | null; fp_rate: number | null }[];
  bySource?: { source: string; alerts: number; avg_signal: number | null; avg_max_move: number | null }[];
};

type Paper = {
  account?: { startingBalance?: number; realizedPnl?: number; equity?: number };
  summary?: { trades?: number; wins?: number; losses?: number; winRate?: number; totalPnlDollars?: number };
};

type StatBlock = {
  evidenceState: string;
  evidenceSummary: string;
  gradedSampleSize: number;
  ungradableCount: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRate: number | null;
  winRateInterval: { low: number; high: number } | null;
  expectancyDollars: number | null;
  expectancyR: number | null;
  profitFactor: number | null;
  netPnl: number;
  totalFees: number;
  maxDrawdown: number;
  avgHoldMinutes: number | null;
  dataQualityCoverage: number | null;
  rolling: { window: number; count: number; netPnl: number; winRate: number | null }[];
};
type AuthStats = {
  overall?: { evidenceState: string; gradedSampleSize: number; stats: StatBlock } | null;
  stats?: { groupKind: string; groupKey: string; evidenceState: string; gradedSampleSize: number; stats: StatBlock }[];
  disclaimer?: string;
};

const EVIDENCE_LABEL: Record<string, string> = {
  NOT_TRACKED: "Not tracked yet",
  INSUFFICIENT_HISTORY: "Insufficient history",
  EARLY_EVIDENCE: "Early evidence",
  ESTABLISHED_EVIDENCE: "Established evidence",
};

function num(v: number | null | undefined, digits = 1, suffix = ""): string {
  if (v == null || Number.isNaN(Number(v))) return "—";
  return `${Number(v).toFixed(digits)}${suffix}`;
}

function money(v: number | null | undefined): string {
  if (v == null || Number.isNaN(Number(v))) return "—";
  const n = Number(v);
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
}

export default function PerformancePage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [paper, setPaper] = useState<Paper | null>(null);
  const [authStats, setAuthStats] = useState<AuthStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const h = { cache: "no-store" as const, headers: scanHeaders() };
      const [s, p, a] = await Promise.all([
        fetch("/api/alerts/stats", h).then((r) => r.json()).catch(() => null),
        fetch("/api/paper/trades", h).then((r) => r.json()).catch(() => null),
        fetch("/api/performance/statistics", h).then((r) => r.json()).catch(() => null),
      ]);
      setStats(s ?? {});
      setPaper(p ?? {});
      setAuthStats(a ?? {});
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? "Could not load performance.");
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load]);

  if (error && !stats) {
    return (
      <PageContainer>
        <ErrorState detail={error} onRetry={load} />
      </PageContainer>
    );
  }
  if (!stats || !paper) {
    return (
      <PageContainer>
        <Card title="Loading performance"><LoadingState rows={4} /></Card>
      </PageContainer>
    );
  }

  const totals = stats.totals ?? {};
  const acct = paper.account ?? {};
  const psum = paper.summary ?? {};
  const pnl = acct.realizedPnl ?? psum.totalPnlDollars ?? null;

  const catCols: Column<NonNullable<Stats["byCatalyst"]>[number]>[] = [
    { key: "type", header: "Catalyst", render: (r) => r.type ?? "—" },
    { key: "alerts", header: "Alerts", align: "right", render: (r) => String(r.alerts ?? 0) },
    { key: "move", header: "Avg max move", align: "right", render: (r) => num(r.avg_max_move, 1, "%") },
    { key: "fp", header: "False-pos rate", align: "right", render: (r) => (r.fp_rate == null ? "—" : `${(r.fp_rate * 100).toFixed(0)}%`) },
  ];
  const srcCols: Column<NonNullable<Stats["bySource"]>[number]>[] = [
    { key: "source", header: "Source", render: (r) => r.source ?? "—" },
    { key: "alerts", header: "Alerts", align: "right", render: (r) => String(r.alerts ?? 0) },
    { key: "signal", header: "Avg signal", align: "right", render: (r) => num(r.avg_signal, 0) },
    { key: "move", header: "Avg max move", align: "right", render: (r) => num(r.avg_max_move, 1, "%") },
  ];

  return (
    <PageContainer>
      <ResponsiveGrid min={240}>
        <Card title="Alert track record">
          <KeyValue k="Total alerts" v={totals.total ?? 0} />
          <KeyValue k="Completed" v={totals.completed ?? 0} />
          <KeyValue k="False positives" v={totals.false_positives ?? 0} tone={(totals.false_positives ?? 0) > 0 ? "warn" : undefined} />
          <KeyValue k="Avg signal score" v={num(totals.avg_signal, 0)} />
          <KeyValue k="Avg max move after alert" v={num(stats.avgMove?.avg_max_move, 1, "%")} />
        </Card>

        <Card title="Paper account" meta="Simulated · no real money">
          <KeyValue k="Equity" v={money(acct.equity)} />
          <KeyValue k="Starting balance" v={money(acct.startingBalance)} />
          <KeyValue k="Realized P&L" v={money(pnl)} tone={pnl == null ? undefined : pnl >= 0 ? "bull" : "bear"} />
          <KeyValue k="Trades" v={psum.trades ?? 0} />
          <KeyValue k="Win rate" v={psum.winRate == null ? "—" : `${(psum.winRate * 100).toFixed(0)}%`} />
        </Card>
      </ResponsiveGrid>

      {(() => {
        const overall = authStats?.overall ?? null;
        const ob = overall?.stats;
        const cuts = (authStats?.stats ?? []).filter((g) => g.groupKind === "strategy" || g.groupKind === "session" || g.groupKind === "dte_bucket" || g.groupKind === "tod_bucket");
        const cutCols: Column<NonNullable<AuthStats["stats"]>[number]>[] = [
          { key: "kind", header: "Cut", render: (r) => r.groupKind },
          { key: "key", header: "Group", render: (r) => r.groupKey },
          { key: "n", header: "Graded", align: "right", render: (r) => String(r.gradedSampleSize) },
          { key: "ev", header: "Evidence", render: (r) => EVIDENCE_LABEL[r.evidenceState] ?? r.evidenceState },
          { key: "wr", header: "Win rate", align: "right", render: (r) => (r.stats.winRate == null ? "—" : `${r.stats.winRate}%`) },
          { key: "net", header: "Net P&L", align: "right", render: (r) => money(r.stats.netPnl) },
        ];
        return (
          <>
            <ResponsiveGrid min={240}>
              <Card title="Setup evidence (authoritative)" meta="Fingerprint outcomes · net of fees">
                <KeyValue k="Evidence state" v={EVIDENCE_LABEL[overall?.evidenceState ?? "NOT_TRACKED"] ?? "—"} />
                <KeyValue k="Graded outcomes" v={ob?.gradedSampleSize ?? 0} />
                <KeyValue k="Ungradable" v={ob?.ungradableCount ?? 0} tone={(ob?.ungradableCount ?? 0) > 0 ? "warn" : undefined} />
                <KeyValue k="Data-quality coverage" v={ob?.dataQualityCoverage == null ? "—" : `${Math.round(ob.dataQualityCoverage * 100)}%`} />
                <KeyValue
                  k="Win rate (95% CI)"
                  v={ob?.winRate == null ? "—" : `${ob.winRate}%${ob.winRateInterval ? ` (${Math.round(ob.winRateInterval.low * 100)}–${Math.round(ob.winRateInterval.high * 100)}%)` : ""}`}
                />
              </Card>
              <Card title="Results after costs" meta="Slippage embedded in fills; net = gross − fees">
                <KeyValue k="Net P&L" v={money(ob?.netPnl)} tone={ob?.netPnl == null ? undefined : ob.netPnl >= 0 ? "bull" : "bear"} />
                <KeyValue k="Total fees" v={money(ob?.totalFees)} />
                <KeyValue k="Expectancy / trade" v={money(ob?.expectancyDollars)} />
                <KeyValue k="Expectancy (R)" v={ob?.expectancyR == null ? "—" : num(ob.expectancyR, 2, "R")} />
                <KeyValue k="Profit factor" v={ob?.profitFactor == null ? "—" : num(ob.profitFactor, 2)} />
                <KeyValue k="Max drawdown" v={money(ob?.maxDrawdown)} />
                <KeyValue k="Avg hold" v={ob?.avgHoldMinutes == null ? "—" : `${ob.avgHoldMinutes} min`} />
              </Card>
            </ResponsiveGrid>
            <Card title="Performance by cut" meta={overall?.stats.evidenceState === "NOT_TRACKED" ? "Awaiting graded outcomes" : undefined}>
              <SimpleTable
                columns={cutCols}
                rows={cuts}
                rowKey={(r, i) => `${r.groupKind}-${r.groupKey}-${i}`}
                emptyTitle="Not enough evidence yet"
                emptyReason="Authoritative per-setup statistics appear once paper trades close into graded outcomes. Nothing here is fabricated — past results never guarantee future performance."
              />
            </Card>
          </>
        );
      })()}

      <ResponsiveGrid min={320}>
        <Card title="By catalyst">
          <SimpleTable
            columns={catCols}
            rows={stats.byCatalyst ?? []}
            rowKey={(r, i) => `${r.type ?? "none"}-${i}`}
            emptyTitle="No catalyst data yet"
            emptyReason="Catalyst-level performance appears once alerts have end-of-day checkpoints recorded. Track record is built from live outcomes only."
          />
        </Card>
        <Card title="By source">
          <SimpleTable
            columns={srcCols}
            rows={stats.bySource ?? []}
            rowKey={(r, i) => `${r.source ?? "none"}-${i}`}
            emptyTitle="No source data yet"
            emptyReason="Per-source performance appears after the first alerts are recorded and checkpointed."
          />
        </Card>
      </ResponsiveGrid>

      <Card title="About these numbers">
        <EmptyState
          icon="ℹ"
          title="Live outcomes only"
          reason="There is no five-year historical dataset connected. Every number here is derived from alerts and paper trades observed live in this deployment — nothing is fabricated or backfilled."
        />
      </Card>
    </PageContainer>
  );
}
