"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { LoadingState } from "@/components/ui/Shell";
import { scanHeaders } from "@/hooks/useScanner";
import { overviewAuthFailed } from "@/lib/dashboard/command-center-health";
import {
  aggregatePaperSample,
  formatOppStatus,
  isSmallSample,
  mapOppStatus,
  mapSystemChips,
  oppStatusTone,
  sampleSizeLabel,
  type OppStatus,
} from "@/lib/dashboard/command-center-view";
import { isUiReviewMode } from "@/lib/dashboard/ui-review";
import {
  TermFunnel,
  TermHBar,
  TermPanel,
  TermPulse,
  TermSpark,
  actionTone,
  fmtAge,
  fmtMoney,
  fmtPct,
} from "@/components/terminal/TermViz";

type Snapshot = {
  ok?: boolean;
  faults?: string[];
  generatedAtMs?: number;
  generatedAtIso?: string;
  commitShort?: string | null;
  independent?: Record<string, any> | null;
  pipeline?: Record<string, any> | null;
  readiness?: Record<string, any> | null;
  paper?: Record<string, any> | null;
  content?: Record<string, any> | null;
  ai?: Record<string, any> | null;
  zeroDteResearch?: Record<string, any> | null;
  rankedSetups?: any[] | null;
  indices?: { spy?: any; qqq?: any } | null;
  quantSummary?: Record<string, any> | null;
  providerBudget?: Record<string, any> | null;
  stock?: Record<string, any> | null;
  error?: string;
  status?: number;
};

function toneClass(tone: string): string {
  if (tone === "ok") return "ok";
  if (tone === "warn") return "warn";
  if (tone === "bad") return "bad";
  if (tone === "info") return "info";
  return "muted";
}

function Chip({ label, state, tone }: { label: string; state: string; tone: string }) {
  return (
    <div className={`cc-term-chip ${toneClass(tone)}`}>
      <span className="cc-term-chip-label">{label}</span>
      <span className="cc-term-chip-state">{state}</span>
    </div>
  );
}

function HeroStat({
  label,
  value,
  spark,
  tone,
  href,
  hint,
}: {
  label: string;
  value: string;
  spark?: number[] | null;
  tone?: string;
  href?: string;
  hint?: string;
}) {
  const inner = (
    <>
      <span className="cc-term-kpi-label">{label}</span>
      <span className={`cc-term-kpi-value ${toneClass(tone ?? "muted")}`}>{value}</span>
      {spark && spark.length >= 2 ? <TermSpark values={spark} width={88} height={20} fill /> : null}
      {hint ? <span className="cc-term-kpi-hint">{hint}</span> : null}
    </>
  );
  if (href) {
    return (
      <Link href={href} className={`cc-term-kpi cc-term-kpi-link term-hero-stat ${toneClass(tone ?? "muted")}`}>
        {inner}
      </Link>
    );
  }
  return <div className={`cc-term-kpi term-hero-stat ${toneClass(tone ?? "muted")}`}>{inner}</div>;
}

function IndexIntel({
  symbol,
  data,
  setup,
}: {
  symbol: string;
  data: any;
  setup: any | null;
}) {
  const age = data?.asOfMs != null ? Date.now() - Number(data.asOfMs) : null;
  const fresh = age != null && age < 120_000;
  return (
    <Link href={`/scanner?symbol=${symbol}`} className="term-index-intel clickable">
      <div className="term-index-intel-top">
        <span className="cc-term-gauge-sym">{symbol}</span>
        <TermPulse live={fresh} />
        <span className={`cc-term-pill ${fresh ? "ok" : "warn"}`}>
          {data?.price == null ? "unavailable" : fresh ? "cached" : fmtAge(age)}
        </span>
      </div>
      <div className="term-index-intel-mid">
        <span className={`cc-term-gauge-px ${data?.price != null ? "ok" : "muted"}`}>
          {data?.price != null ? `$${Number(data.price).toFixed(2)}` : "—"}
        </span>
        <TermSpark values={data?.spark} width={110} height={28} fill />
      </div>
      <div className="term-index-intel-grid">
        <span>VWAP <b>{data?.vwapRelation ?? "—"}</b></span>
        <span>Mom <b>{data?.momentum ?? "—"}</b></span>
        <span>Vol <b>{data?.volumeState ?? "—"}</b></span>
        <span>IV <b>{data?.volatilityState ?? "—"}</b></span>
      </div>
      <div className="term-index-intel-setup">
        <span className={`cc-term-pill ${actionTone(setup?.systemAction ?? "WATCH")}`}>
          {setup?.systemAction ?? "—"}
        </span>
        <span className="term-index-setup-txt">
          {setup ? `${setup.side?.toUpperCase()} · ${setup.strategy ?? "setup"}` : "No active setup"}
        </span>
      </div>
      <span className="cc-term-gauge-src">{data?.source ?? "—"}</span>
    </Link>
  );
}

function ProgressBar({
  entry,
  mark,
  t1,
  stop,
}: {
  entry?: number | null;
  mark?: number | null;
  t1?: number | null;
  stop?: number | null;
}) {
  if (entry == null || mark == null || t1 == null || stop == null) {
    return <div className="term-progress-mini empty" />;
  }
  const lo = Math.min(stop, entry, t1);
  const hi = Math.max(stop, entry, t1);
  const span = hi - lo || 1;
  const pct = Math.max(0, Math.min(100, ((mark - lo) / span) * 100));
  const stopPct = ((stop - lo) / span) * 100;
  const t1Pct = ((t1 - lo) / span) * 100;
  return (
    <div className="term-progress-mini" title={`stop ${stop} → entry ${entry} → T1 ${t1}`}>
      <i className="term-progress-fill" style={{ width: `${pct}%` }} />
      <i className="term-progress-mark stop" style={{ left: `${stopPct}%` }} />
      <i className="term-progress-mark t1" style={{ left: `${t1Pct}%` }} />
    </div>
  );
}

export function CommandCenter() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [optionalOpen, setOptionalOpen] = useState(false);
  const [mobileMore, setMobileMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [uiReview, setUiReview] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setUiReview(isUiReviewMode());
    const sync = () => setUiReview(isUiReviewMode());
    window.addEventListener("storage", sync);
    window.addEventListener("optiscan:ui-review-changed", sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("optiscan:ui-review-changed", sync);
    };
  }, []);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/command-center", { cache: "no-store", headers: scanHeaders() });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setLoadError(json?.error ?? `HTTP ${res.status}`);
        setSnap(json ?? { ok: false, status: res.status, error: "unauthorized" });
        return;
      }
      setLoadError(null);
      setSnap(json);
      setTick((t) => t + 1);
    } catch (err: any) {
      setLoadError(String(err?.message ?? err));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, [load]);

  const authFailed = overviewAuthFailed(snap as any) || Boolean(loadError);
  const ind = snap?.independent ?? null;
  const pipe = snap?.pipeline ?? null;
  const paper = snap?.paper ?? null;
  const readiness = snap?.readiness ?? null;
  const content = snap?.content ?? null;
  const ai = snap?.ai ?? null;
  const zeroDte = snap?.zeroDteResearch ?? null;
  const stock = snap?.stock ?? null;
  const ranked = snap?.rankedSetups ?? [];
  const indices = snap?.indices ?? null;
  const quant = snap?.quantSummary ?? null;
  const budget = snap?.providerBudget ?? null;
  const m = readiness?.metrics ?? {};
  const delivery = pipe?.delivery ?? {};
  const candidates = pipe?.candidates ?? {};
  const sample = paper?.sample ?? aggregatePaperSample(paper?.rows ?? []);
  const gradedN = Number(m.gradedSample ?? sample.gradedForRates ?? 0);
  const small = isSmallSample(gradedN, 10);
  const sampleHint = sampleSizeLabel(gradedN);
  const pulse = quant?.pulse ?? null;

  const chips = useMemo(
    () =>
      mapSystemChips({
        authFailed,
        independent: ind,
        graderRunning: paper?.grader?.running,
        graderLastCycleAgeMs: paper?.grader?.lastCycleAgeMs,
        commitShort: snap?.commitShort,
        refreshedIso: snap?.generatedAtIso,
        uiReview,
      }),
    [authFailed, ind, paper, snap?.commitShort, snap?.generatedAtIso, uiReview],
  );

  const openRows = (paper?.rows ?? []).filter((r: any) => r.paperStatus === "ENTERED");
  const selected =
    Number(delivery?.decisions24h?.DELIVER_TO_DISCORD ?? delivery?.metrics?.selectedForDelivery ?? 0) || null;

  const deliveredEquitySpark = (paper?.equityCurve ?? []).map((p: any) => Number(p.equityPct)).filter(Number.isFinite);
  const zeroDteSpark = (zeroDte?.equityCurve ?? []).map((p: any) => Number(p.equity)).filter(Number.isFinite);
  const deliveredEquityLast = deliveredEquitySpark.length
    ? `${deliveredEquitySpark[deliveredEquitySpark.length - 1]!.toFixed(1)}%`
    : "—";
  const zeroEquity = zeroDte?.account?.equityUsd != null
    ? `$${Number(zeroDte.account.equityUsd).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
    : "—";

  const freshnessMs = snap?.generatedAtMs != null ? Date.now() - snap.generatedAtMs : null;

  const setupFor = (sym: string) => ranked.find((r: any) => r.symbol === sym) ?? null;

  const funnelStages = [
    { key: "scanned", label: "Scanned", count: candidates.observed24h ?? ind?.metrics?.symbolsScanned ?? null, href: "/pipeline-health" },
    { key: "observed", label: "Observed", count: candidates.observed24h ?? null, href: "/pipeline-health" },
    { key: "ready", label: "READY", count: candidates.ready24h ?? null, href: "/scanner" },
    { key: "selected", label: "Selected", count: selected, href: "/callouts" },
    { key: "sent", label: "Sent", count: delivery.sent24h ?? paper?.sent24h ?? null, href: "/paper" },
    { key: "linked", label: "Paper", count: paper?.linked24h ?? null, href: "/paper" },
    { key: "graded", label: "Graded", count: m.gradedSample ?? paper?.backlog?.gradedTotal ?? null, href: "/quant" },
  ];

  const refreshLabel = snap?.generatedAtIso
    ? new Date(snap.generatedAtIso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";

  const equityChartData = (paper?.equityCurve ?? []).map((p: any, i: number) => ({
    i: i + 1,
    equity: p.equityPct,
  }));

  if (!snap && !loadError) {
    return (
      <div className="ui-page cc-term cc-term-control">
        <LoadingState rows={5} />
      </div>
    );
  }

  const actionable = ranked.filter((r: any) => r.systemAction === "SEND" || r.systemAction === "WATCH").slice(0, 4);

  return (
    <div className={`ui-page cc-term cc-term-control ${tick ? "term-updated" : ""}`}>
      <div className="cc-term-strip">
        <div className="cc-term-strip-chips">
          {chips.map((c) => (
            <Chip key={c.key} label={c.label} state={c.state} tone={c.tone} />
          ))}
        </div>
        <div className="cc-term-strip-meta">
          <TermPulse live={freshnessMs != null && freshnessMs < 15_000} />
          <span>Commit {snap?.commitShort ?? "—"}</span>
          <span>Age {fmtAge(freshnessMs)}</span>
          <span>Refreshed {refreshLabel}</span>
          <button type="button" className="cc-term-refresh" disabled={refreshing} onClick={() => void load()}>
            {refreshing ? "…" : "Refresh"}
          </button>
        </div>
      </div>

      {loadError ? (
        <div className="cc-term-banner bad">
          Token required — open Settings and set your scan token. ({loadError})
        </div>
      ) : null}

      {/* LIVE ACCOUNT HERO */}
      <TermPanel title="Live accounts" badge={<span className="cc-term-pill ok">10s poll</span>} href="/paper">
        <div className="term-hero-scroll">
          <HeroStat label="Delivered equity" value={deliveredEquityLast} spark={deliveredEquitySpark} tone="ok" href="/quant?lane=delivered" hint="cum. closed %" />
          <HeroStat label="0DTE Research" value={zeroEquity} spark={zeroDteSpark} tone="ok" href="/paper/0dte" hint="simulated $" />
          <HeroStat
            label="Daily P&L"
            value={zeroDte?.account?.dailyPnlUsd != null ? `$${Number(zeroDte.account.dailyPnlUsd).toFixed(0)}` : "—"}
            tone={Number(zeroDte?.account?.dailyPnlUsd) >= 0 ? "ok" : "warn"}
            href="/paper/0dte"
          />
          <HeroStat
            label="Open risk"
            value={zeroDte?.openRiskUsd != null || zeroDte?.account?.openRiskUsd != null
              ? `$${Number(zeroDte?.openRiskUsd ?? zeroDte?.account?.openRiskUsd).toLocaleString()}`
              : "—"}
            tone="warn"
            href="/paper/0dte"
          />
          <HeroStat label="Open positions" value={String(openRows.length + Number(zeroDte?.openCount ?? 0))} href="/paper" tone="ok" />
          <HeroStat label="Alerts today" value={String(delivery.sent24h ?? paper?.sent24h ?? 0)} href="/callouts" />
          <HeroStat label="Data age" value={fmtAge(freshnessMs)} tone={freshnessMs != null && freshnessMs < 30_000 ? "ok" : "warn"} />
        </div>
      </TermPanel>

      {/* ACTIONABLE + INDICES */}
      <div className="cc-term-two-col term-cc-top">
        <TermPanel
          title="Actionable now"
          badge={<span className={`cc-term-pill ${actionable.length ? "ok" : "muted"}`}>{actionable.length}</span>}
          action={<Link href="/callouts" className="cc-term-link">Live Options →</Link>}
        >
          {actionable.length === 0 ? (
            <p className="cc-term-empty">No SEND/WATCH setups in window</p>
          ) : (
            <div className="term-action-list">
              {actionable.map((r: any) => (
                <Link key={`a-${r.rank}`} href={r.href ?? "/callouts"} className="term-action-row clickable">
                  <span className="cc-term-opp-sym">{r.symbol}</span>
                  <span className={`cc-term-pill ${actionTone(r.systemAction)}`}>{r.systemAction}</span>
                  <TermSpark values={r.underlyingSpark} width={56} height={18} />
                  <span className="term-action-score">{r.actionScore ?? "—"}</span>
                  <span className="term-action-reason">{r.reason ?? "—"}</span>
                </Link>
              ))}
            </div>
          )}
        </TermPanel>
        <TermPanel title="SPY / QQQ" action={<Link href="/scanner" className="cc-term-link">Scanner →</Link>}>
          <div className="cc-term-gauges">
            <IndexIntel symbol="SPY" data={indices?.spy} setup={setupFor("SPY")} />
            <IndexIntel symbol="QQQ" data={indices?.qqq} setup={setupFor("QQQ")} />
          </div>
          <p className="cc-term-footnote">Cached paper/alert prints — no per-card Massive fetch</p>
        </TermPanel>
      </div>

      {/* RANKED SETUPS */}
      <TermPanel
        title="Highest-quality setups"
        badge={<span className="cc-term-pill muted">{ranked.length}</span>}
        action={<Link href="/callouts" className="cc-term-link">All →</Link>}
        className="term-desktop-only-table"
      >
        <p className="cc-term-disclaimer">Not buy instructions — SEND / WATCH / BLOCK / RESEARCH only.</p>
        {ranked.length === 0 ? (
          <p className="cc-term-empty">No ranked setups in the last 4h</p>
        ) : (
          <div className="cc-term-setup-scroll">
            <table className="cc-term-setup-table term-setup-dense">
              <thead>
                <tr>
                  <th>#</th><th>Sym</th><th>Und</th><th>Prem</th><th>Side</th><th>Contract</th>
                  <th>Action</th><th>Score</th><th>Signal</th><th>Contract</th><th>Entry</th>
                  <th>Quality</th><th>Fresh</th><th>E / T1 / Stop</th><th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {ranked.map((s: any) => (
                  <tr key={`${s.rank}-${s.alertId ?? s.symbol}`}>
                    <td><Link href={s.href ?? "/callouts"} className="cc-term-link">{s.rank}</Link></td>
                    <td><Link href={s.href ?? "/callouts"} className="cc-term-opp-sym">{s.symbol}</Link></td>
                    <td><TermSpark values={s.underlyingSpark} width={48} height={16} /></td>
                    <td><TermSpark values={s.premiumSpark} width={48} height={16} /></td>
                    <td>{String(s.side ?? "").toUpperCase()}</td>
                    <td className="cc-term-mono">{s.contract ? String(s.contract).slice(0, 18) : "—"}</td>
                    <td><span className={`cc-term-pill ${actionTone(s.systemAction)}`}>{s.systemAction}</span></td>
                    <td className="num">{s.actionScore ?? "—"}</td>
                    <td className="num">{s.signalScore ?? "—"}</td>
                    <td><span className={`cc-term-pill ${s.contractReadiness === "READY" ? "ok" : s.contractReadiness === "THIN" ? "warn" : "bad"}`}>{s.contractReadiness ?? "—"}</span></td>
                    <td><span className={`cc-term-pill ${actionTone(s.entryState === "ACTIONABLE" ? "SEND" : s.entryState === "BLOCK" ? "BLOCK" : "WATCH")}`}>{s.entryState ?? "—"}</span></td>
                    <td>{s.entryQualityState ?? "—"}</td>
                    <td>{s.freshnessLabel}</td>
                    <td className="cc-term-mono">{fmtMoney(s.entryZone)} / {fmtMoney(s.target)} / {fmtMoney(s.stop)}</td>
                    <td className="term-reason-cell">
                      <div>{s.reason ?? "—"}</div>
                      <div className="muted">Risk: {s.mainRisk ?? "—"}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </TermPanel>

      {/* Mobile compact setup cards */}
      <div className="term-mobile-setups">
        <TermPanel title="Setups" action={<Link href="/callouts" className="cc-term-link">All →</Link>}>
          <div className="term-setup-cards">
            {ranked.slice(0, 5).map((s: any) => (
              <Link key={`m-${s.rank}`} href={s.href ?? "/callouts"} className="term-setup-card clickable">
                <div className="term-setup-card-top">
                  <span className="cc-term-opp-sym">{s.symbol}</span>
                  <span className={`cc-term-pill ${actionTone(s.systemAction)}`}>{s.systemAction}</span>
                  <span className="term-action-score">{s.actionScore ?? "—"}</span>
                </div>
                <div className="term-setup-card-sparks">
                  <TermSpark values={s.underlyingSpark} width={64} height={18} fill />
                  <TermSpark values={s.premiumSpark} width={64} height={18} />
                </div>
                <div className="term-setup-card-meta">
                  {String(s.side).toUpperCase()} · {s.freshnessLabel} · {s.contractReadiness}
                </div>
                <div className="term-setup-card-reason">{s.reason}</div>
              </Link>
            ))}
          </div>
        </TermPanel>
      </div>

      {/* POSITIONS + FUNNEL */}
      <div className="cc-term-two-col">
        <TermPanel
          title="Open positions"
          badge={<span className="cc-term-pill muted">{openRows.length}</span>}
          action={<Link href="/paper" className="cc-term-link">Paper →</Link>}
        >
          {openRows.length === 0 ? (
            <p className="cc-term-empty">No open delivered positions</p>
          ) : (
            <div className="cc-term-opp-list">
              {openRows.map((r: any) => {
                const status: OppStatus = mapOppStatus(r);
                const ret = r.latestMarkReturnPct;
                const spark = (r.marks ?? []).map((m: any) => Number(m.return_pct ?? m.returnPct)).filter(Number.isFinite);
                return (
                  <Link
                    key={r.alertId}
                    href={r.opportunityCaseId ? `/intelligence/${r.opportunityCaseId}` : `/paper?tab=delivered&alert=${encodeURIComponent(r.alertId)}`}
                    className="cc-term-opp cc-term-opp-link clickable"
                  >
                    <div className="cc-term-opp-top">
                      <span className="cc-term-opp-sym">{r.symbol}</span>
                      <span className={`cc-term-pill ${toneClass(oppStatusTone(status))}`}>{formatOppStatus(status)}</span>
                      <TermSpark values={spark.length >= 2 ? spark : [0, Number(ret) || 0]} width={52} height={16} />
                    </div>
                    <div className="cc-term-opp-meta">
                      <span>{String(r.side ?? "—").toUpperCase()}</span>
                      <span className="cc-term-mono">{r.optionSymbol ? String(r.optionSymbol).slice(0, 16) : "—"}</span>
                      <span>{fmtAge(r.ageMs)}</span>
                    </div>
                    <div className="cc-term-opp-metrics">
                      <span className={Number(ret) >= 0 ? "ok" : "bad"}>{fmtPct(ret)}</span>
                      <span>MFE {fmtPct(r.mfePct)}</span>
                      <span>MAE {fmtPct(r.maePct)}</span>
                    </div>
                    <ProgressBar entry={r.frozenEntry} mark={r.markPrice} t1={r.frozenT1} stop={r.frozenStop} />
                  </Link>
                );
              })}
            </div>
          )}
        </TermPanel>

        <TermPanel title="Pipeline funnel" action={<Link href="/pipeline-health" className="cc-term-link">Details →</Link>} className="term-hide-mobile-default">
          <TermFunnel stages={funnelStages} />
          {equityChartData.length >= 2 ? (
            <div className="cc-term-chart" style={{ marginTop: 12 }}>
              <span className="cc-term-chart-label">Delivered equity path %</span>
              <ResponsiveContainer width="100%" height={100}>
                <AreaChart data={equityChartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(80,120,100,0.12)" />
                  <XAxis dataKey="i" hide />
                  <YAxis tick={{ fontSize: 9, fill: "#6b7a72" }} width={28} />
                  <Tooltip contentStyle={{ background: "#0a0c0b", border: "1px solid rgba(80,200,120,0.25)", fontSize: 11 }} />
                  <Area type="monotone" dataKey="equity" stroke="#34d399" fill="rgba(52,211,153,0.15)" strokeWidth={1.5} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : null}
        </TermPanel>
      </div>

      {/* 0DTE + QUANT PULSE — always on mobile home */}
      <div className="cc-term-two-col">
        <TermPanel
          title="0DTE Research"
          badge={<span className="cc-term-pill muted">Simulated</span>}
          action={<Link href="/paper/0dte" className="cc-term-link">Open →</Link>}
          href="/paper/0dte"
        >
          <div className="term-hero-scroll">
            <HeroStat label="Equity" value={zeroEquity} spark={zeroDteSpark} tone="ok" href="/paper/0dte" />
            <HeroStat label="Daily P&L" value={zeroDte?.account?.dailyPnlUsd != null ? `$${Number(zeroDte.account.dailyPnlUsd).toFixed(0)}` : "—"} tone={Number(zeroDte?.account?.dailyPnlUsd) >= 0 ? "ok" : "warn"} href="/paper/0dte" />
            <HeroStat label="Open" value={String(zeroDte?.openCount ?? 0)} href="/paper/0dte" />
            <HeroStat label="SPY/QQQ" value={`${zeroDte?.today?.spy ?? 0}/${zeroDte?.today?.qqq ?? 0}`} href="/paper/0dte" />
          </div>
        </TermPanel>

        <TermPanel
          title="Quant pulse"
          badge={<span className="cc-term-pill muted">{pulse?.confidence ?? quant?.delivered?.confidence ?? "—"}</span>}
          action={<Link href="/quant" className="cc-term-link">Lab →</Link>}
          href="/quant"
        >
          <div className="term-hero-scroll">
            <HeroStat label="Expectancy" value={fmtPct(pulse?.expectancy ?? quant?.delivered?.expectancy)} href="/quant" />
            <HeroStat label="PF" value={pulse?.profitFactor != null ? String(Number(pulse.profitFactor).toFixed(2)) : (quant?.delivered?.profitFactor != null ? String(quant.delivered.profitFactor) : "—")} href="/quant" />
            <HeroStat label="Capture" value={pulse?.captureEfficiency != null ? fmtPct(Number(pulse.captureEfficiency) <= 1.5 ? Number(pulse.captureEfficiency) * 100 : pulse.captureEfficiency) : "—"} href="/quant" />
            <HeroStat label="n" value={String(pulse?.sampleSize ?? quant?.delivered?.sampleSize ?? "—")} href="/quant" hint={sampleHint ?? undefined} />
          </div>
          {(pulse?.bestStrategy || pulse?.worstStrategy) ? (
            <TermHBar
              rows={[
                ...(pulse?.bestStrategy ? [{ key: "best", label: `Best ${pulse.bestStrategy}`, value: 1, tone: "ok" }] : []),
                ...(pulse?.worstStrategy ? [{ key: "worst", label: `Worst ${pulse.worstStrategy}`, value: -1, tone: "bad" }] : []),
                ...(pulse?.bestTimeBucket ? [{ key: "tod", label: `Time ${pulse.bestTimeBucket}`, value: 0.5, tone: "info" }] : []),
              ]}
              hrefFor={() => "/quant"}
            />
          ) : (
            <p className="cc-term-footnote">Best/worst strategy needs graded sample</p>
          )}
        </TermPanel>
      </div>

      {/* Mobile: collapse secondary */}
      <button type="button" className="cc-term-collapse term-mobile-more-btn" onClick={() => setMobileMore((v) => !v)}>
        {mobileMore ? "Hide secondary ▾" : "Content · AI · Readiness · Pipeline ▸"}
      </button>

      <div className={`term-secondary ${mobileMore ? "open" : ""}`}>
        <div className="cc-term-two-col">
          <TermPanel title="Content" action={<Link href="/content-drafts" className="cc-term-btn">Drafts</Link>} href="/content-drafts">
            <div className="cc-term-grid-2">
              <HeroStat label="Pending" value={String(content?.pendingEvents ?? 0)} href="/content-drafts" />
              <HeroStat label="Awaiting" value={String(content?.drafts?.pending ?? 0)} tone={Number(content?.drafts?.pending) > 0 ? "warn" : "muted"} href="/content-drafts" />
            </div>
          </TermPanel>
          <TermPanel title="AI advisory" badge={<span className="cc-term-pill muted">Advisory</span>} href="/ai">
            <div className="cc-term-grid-2">
              <HeroStat label="Nightly" value={String(ai?.nightlyStatus ?? "IDLE")} href="/ai" />
              <HeroStat label="Pending" value={String(ai?.pendingApproval ?? 0)} href="/ai" />
            </div>
          </TermPanel>
        </div>
        <TermPanel title="Pipeline" href="/pipeline-health" className="term-show-mobile-funnel">
          <TermFunnel stages={funnelStages} />
        </TermPanel>
        <TermPanel
          title="Paid-beta readiness"
          badge={<span className={`cc-term-pill ${readiness?.ready ? "ok" : "info"}`}>{readiness?.status ?? "—"}</span>}
          href="/pipeline-health#readiness"
        >
          <p className="cc-term-footnote">Graded {fmtAge(null)} · n={gradedN}{small ? " · small sample" : ""}</p>
        </TermPanel>
        <section className="cc-term-panel cc-term-optional">
          <button type="button" className="cc-term-collapse" aria-expanded={optionalOpen} onClick={() => setOptionalOpen((v) => !v)}>
            Optional systems {optionalOpen ? "▾" : "▸"}
          </button>
          {optionalOpen ? (
            <div className="cc-term-panel-body">
              <div className="cc-term-grid-2">
                <HeroStat label="Stock scanner" value={stock?.scannerRunning ? "running" : "stopped"} tone="info" />
                <HeroStat label="Supervisor" value={stock?.supervisorEnabled ? "enabled" : "disabled"} tone="info" />
              </div>
              {budget ? (
                <p className="cc-term-footnote">
                  Massive budget est: und {budget.totals?.estUnderlyingPerMin}/min · chain {budget.totals?.estChainPerMin}/min
                </p>
              ) : null}
              <div className="cc-term-links">
                <Link href="/data" className="cc-term-link">System health</Link>
                <Link href="/shadow-soak" className="cc-term-link">Shadow soak</Link>
                <Link href="/pipeline-health" className="cc-term-link">Deep diagnostics</Link>
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
