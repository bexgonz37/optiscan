"use client";

/**
 * /paper — Paper Trading dashboard (v1.3).
 * Autonomous paper trading: deterministic auto-entry + scanner piggyback exits.
 * This does not depend on the read-only /copilot explanation page.
 */

import { Suspense, useCallback, useEffect, useState } from "react";
import { scanHeaders } from "@/hooks/useScanner";
import { InfoTip } from "@/components/InfoTip";
import { CardTip } from "@/components/CardTip";
import { Panel } from "@/components/ui/Panel";
import { StatTile } from "@/components/ui/StatTile";
import { fmtPrice } from "@/lib/format";

interface Summary {
  openCount: number; closedCount: number; gradedCount: number;
  wins: number; losses: number; winRatePct: number | null;
  avgGainPct: number | null; avgLossPct: number | null;
  profitFactor: number | null; expectancyDollars: number | null;
  totalPnlDollars: number; maxDrawdownDollars: number;
  largestWinDollars: number | null; largestLossDollars: number | null;
  avgHoldMinutes: number | null; avgMfePct: number | null; avgMaePct: number | null;
}

interface BucketRow { bucket: string; count: number; winRatePct: number | null; avgPnlPct: number | null; totalDollars: number }
interface PaperAccount { startingBalance: number; realizedPnl: number; equity: number; buyingPowerNote?: string }

const BUCKET_LABELS: [string, string][] = [
  ["byConfidence", "Confidence at entry"],
  ["byExpirationLength", "Expiration length"],
  ["bySetup", "Setup"],
  ["byExitKind", "Exit kind"],
];

function num(v: number | null | undefined, suffix = "", digits = 1): string {
  if (v == null || Number.isNaN(v)) return "—";
  if (!Number.isFinite(v)) return "∞";
  return `${v.toFixed(digits)}${suffix}`;
}

function dollars(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(0)}`;
}

function timeAgo(ms: number | null | undefined): string {
  if (!ms) return "never";
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

function bucketTotal(rows: BucketRow[] | null | undefined): number {
  return (rows ?? []).reduce((s, r) => s + Number(r.count ?? 0), 0);
}

function sortedBuckets(rows: BucketRow[] | null | undefined): BucketRow[] {
  return [...(rows ?? [])].sort((a, b) => Math.abs(b.totalDollars) - Math.abs(a.totalDollars));
}

const STATE_CLASS: Record<string, string> = {
  ENTERED: "up", TAKE_PROFIT: "up", READY: "muted", WATCHING: "muted",
  STOPPED_OUT: "dn", EXITED: "", CANCELLED: "muted", EXPIRED: "muted",
};

function PaperPageInner() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [recentAlerts, setRecentAlerts] = useState<any[]>([]);
  const [createNote, setCreateNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/paper/trades", { cache: "no-store", headers: scanHeaders() });
      const d = await res.json();
      if (d?.ok) { setData(d); setError(null); } else setError(d?.error ?? "load failed");
    } catch (e: any) {
      setError(e?.message ?? "load failed");
    }
  }, []);

  const loadAlerts = useCallback(async () => {
    try {
      const res = await fetch("/api/alerts?limit=12", { cache: "no-store", headers: scanHeaders() });
      const d = await res.json();
      setRecentAlerts((d?.alerts ?? []).filter((a: any) => a.option_symbol && a.asset_class !== "stock"));
    } catch { /* best effort */ }
  }, []);

  useEffect(() => {
    load();
    loadAlerts();
    const t = setInterval(load, 7_000);
    return () => clearInterval(t);
  }, [load, loadAlerts]);

  const act = useCallback(async (id: number, action: "cancel" | "close") => {
    setBusyId(id);
    try {
      await fetch(`/api/paper/trades/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...scanHeaders() },
        body: JSON.stringify({ action }),
      });
      await load();
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const paperIt = useCallback(async (alertId: number) => {
    setCreateNote(null);
    const res = await fetch("/api/paper/trades", {
      method: "POST",
      headers: { "content-type": "application/json", ...scanHeaders() },
      body: JSON.stringify({ alertId }),
    });
    const d = await res.json();
    setCreateNote(d.ok ? `Paper trade #${d.id} created — entry order active.` : `Blocked by risk engine: ${d.risk?.failures?.join("; ")}`);
    await load();
  }, [load]);

  const s: Summary | null = data?.summary ?? null;
  const optionsPerf: any = data?.optionsPerformance ?? null;
  const engine = data?.engine ?? null;
  const account: PaperAccount | null = data?.account ?? null;
  const trades: any[] = data?.trades ?? [];
  const decisions: any[] = data?.decisions ?? [];
  const events: any[] = data?.events ?? [];
  const daily = data?.daily ?? null;
  const buckets = data?.buckets ?? {};
  const open = trades.filter((t) => ["WATCHING", "READY", "ENTERED"].includes(t.status));
  const closed = trades.filter((t) => !["WATCHING", "READY", "ENTERED"].includes(t.status));
  const filledClosed = closed.filter((t) => t.entryPrice != null && t.exitPrice != null);
  const blockedAttempts = closed.filter((t) => t.status === "CANCELLED" && t.entryPrice == null);
  const risk = engine?.risk ?? {};
  const positionDollars = Number(engine?.experimentalPositionDollars ?? 0);
  const profitGoalDollars = Number(engine?.targetProfitDollars ?? 0);
  const experimentOn = Boolean(engine?.experimentalOversize && positionDollars > 0);

  return (
    <div className="page axiom-utility">
      <main className="main-col axiom-live">
        <CardTip metric="paperTrading" className="utility-hero">
          <section className="panel main utility-intro">
            <h2 className="section-title"><InfoTip metric="paperTrading">Paper trading</InfoTip></h2>
            <p className="muted text-sm">
              Fully autonomous paper trading — deterministic rules only, no AI approval step required. Fresh TRADE callouts auto-enter when
              <code> PAPER_AUTO_ENTRY=1</code>; hot symbols re-price every ~7s via the scanner&apos;s own chain refresh;
              everything else sweeps every {engine?.sweepMs ? Math.round(engine.sweepMs / 1000) : 30}s.
            </p>
            <div className="utility-badges">
              {account ? <span className="pill badge">Paper account {dollars(account.startingBalance)}</span> : null}
              <span className={`pill badge${engine?.running ? " badge-live" : ""}`}>
                {engine?.running ? "Engine live" : "Engine offline"}
              </span>
              <span className={`pill badge${engine?.autoEntryEnabled ? " badge-live" : ""}`}>
                {engine?.autoEntryEnabled ? "Auto-entry ON" : "Auto-entry off"}
              </span>
              <span className="pill badge">Session {engine?.session ?? "—"}</span>
              {engine?.stockPaperScalpsEnabled ? (
                <span className="pill badge badge-live">Stock paper: {(engine?.stockSessions ?? []).join(", ")}</span>
              ) : null}
              {engine?.autoEntryEnabled && !engine?.allowZeroDte ? (
                <span className="pill badge badge-warn">Needs PAPER_ALLOW_ZERO_DTE=1</span>
              ) : null}
              {risk.killSwitch ? <span className="pill badge badge-warn">Kill switch ON</span> : null}
              {experimentOn ? <span className="pill badge badge-warn">Experimental ${positionDollars.toFixed(0)} position ON</span> : null}
            </div>
            {experimentOn ? (
              <div className="alert-error" style={{ marginTop: 12 }}>
                Paper-only experiment mode is sizing entries to trade about at least {dollars(positionDollars)} at a time
                {profitGoalDollars > 0 ? ` with a rough ${dollars(profitGoalDollars)} profit goal.` : "."}
                This can create larger stock share counts or option contract counts and does not guarantee profit.
              </div>
            ) : null}
            {error ? <div className="alert-error">{error} — is the app running with a token set?</div> : null}
            {s ? (
              <p className="muted text-xs" style={{ marginTop: 10 }}>
                Stats count <b>{filledClosed.length}</b> filled-and-closed paper trade{filledClosed.length === 1 ? "" : "s"} only.
                Blocked/refused attempts ({blockedAttempts.length}) are shown in the decision log but do not count toward win rate.
              </p>
            ) : null}
          </section>
        </CardTip>

        <Panel title="Risk rules the agent cannot override" meta="Beginner guardrails · enforced before every entry" tip="paperTrading">
          <div className="paper-buckets">
            <div className="paper-bucket">
              <h4>Risk profile &amp; sizing</h4>
              <p className="muted text-xs">
                Profile <b>{engine?.sizingProfile ?? "standard"}</b> (PAPER_RISK_PROFILE). Sizes from equity × risk% ÷ loss-at-stop, then clamps to every hard cap.
                {engine?.sizing ? (
                  <> Risk/trade {num(engine.sizing.riskPerTradePct, "%")} · max position {num(engine.sizing.maxPositionPct, "%")} · max exposure {num(engine.sizing.maxTotalExposurePct, "%")} · max {engine.sizing.maxContractsPerTrade} contracts/trade · daily-loss stop {num(engine.sizing.maxDailyLossPct, "%")}.</>
                ) : null}
              </p>
            </div>
            <div className="paper-bucket">
              <h4>Position limits</h4>
              <p className="muted text-xs">
                Max risk {dollars(risk.maxRiskPerTrade)} per trade · max {risk.maxOpenTrades ?? "—"} open trades · max {dollars(risk.maxExposurePerTicker)} per ticker.
                {experimentOn ? ` Experimental paper sizing can widen dollar caps per entry to hold about ${dollars(positionDollars)} per trade.` : ""}
              </p>
            </div>
            <div className="paper-bucket">
              <h4>Loss circuit breakers</h4>
              <p className="muted text-xs">
                Daily loss {dollars(risk.maxDailyLoss)} · weekly loss {dollars(risk.maxWeeklyLoss)} · cooldown after a loss {risk.cooldownAfterLossMinutes ?? 30}m.
              </p>
            </div>
            <div className="paper-bucket">
              <h4>Execution discipline</h4>
              <p className="muted text-xs">
                0DTE {risk.allowZeroDte ? "allowed by env" : "blocked by default"} · averaging down {risk.allowAveragingDown ? "allowed by env" : "blocked"} · kill switch {risk.killSwitch ? "ON" : "off"}.
                Stock momentum paper entries run in {(engine?.stockSessions ?? ["premarket", "regular", "afterhours"]).join(", ")}; options entries only manage/fill when regular-hours option quotes exist.
              </p>
            </div>
          </div>
        </Panel>

        {daily ? (
          <Panel title="Today" meta="Paper-trade readiness" live tip="paperTrading">
            <p className="text-sm">{daily.text}</p>
            <div className="paper-buckets">
              <div className="paper-bucket">
                <h4>Setup flow</h4>
                <p className="muted text-xs">
                  Qualified {daily.qualifyingActionableCallouts ?? 0} · candidates {daily.paperCandidatesCreated ?? 0} · READY {daily.readyOrders ?? 0}
                </p>
              </div>
              <div className="paper-bucket">
                <h4>Execution</h4>
                <p className="muted text-xs">
                  Revalidations {daily.revalidationAttempts ?? 0} · fills {daily.fills ?? 0} · rejected {daily.rejected ?? 0} · expired windows {daily.expiredEntryWindows ?? 0}
                </p>
              </div>
            </div>
          </Panel>
        ) : null}

        {s ? (
          <div className="axiom-strip paper-strip">
            {account ? (
              <>
                <StatTile label="Paper equity" value={dollars(account.equity)} hint="starting balance + realized P/L" metric="paperTrading" />
                <StatTile label="Starting cash" value={dollars(account.startingBalance)} hint="simulated account size" metric="paperTrading" />
              </>
            ) : null}
            <StatTile label="Filled win rate" value={num(s.winRatePct, "%")} hint={`${s.wins}W / ${s.losses}L of ${s.gradedCount} filled trades`} metric="winRate" />
            <StatTile label="Profit factor" value={num(s.profitFactor, "", 2)} hint="gross win ÷ gross loss" metric="profitFactor" />
            <StatTile label="Expectancy" value={dollars(s.expectancyDollars)} hint="per graded trade" metric="expectancy" />
            <StatTile label="Total P/L" value={dollars(s.totalPnlDollars)} hint="realized" metric="paperTrading" />
            <StatTile label="Max drawdown" value={dollars(s.maxDrawdownDollars)} hint="worst stretch" metric="maxDrawdown" />
            <StatTile label="Avg gain / loss" value={`${num(s.avgGainPct, "%")} / ${num(s.avgLossPct, "%")}`} hint="winners vs losers" metric="paperTrading" />
            <StatTile label="Largest win / loss" value={`${dollars(s.largestWinDollars)} / ${dollars(s.largestLossDollars)}`} hint="outliers matter" metric="paperTrading" />
            <StatTile label="Avg hold" value={num(s.avgHoldMinutes, "m", 0)} hint="entry → exit" metric="paperTrading" />
          </div>
        ) : null}

        {s ? (
          <Panel title="Analytics dashboard" meta="Realized fills only; no fabricated history" tip="paperTrading">
            <div className="paper-buckets">
              {BUCKET_LABELS.map(([key, title]) => {
                const rows = sortedBuckets(buckets[key] as BucketRow[] | undefined);
                const total = bucketTotal(rows);
                const best = [...rows].sort((a, b) => b.totalDollars - a.totalDollars)[0] ?? null;
                const worst = [...rows].sort((a, b) => a.totalDollars - b.totalDollars)[0] ?? null;
                return (
                  <div key={key} className="paper-bucket">
                    <h4>{title}</h4>
                    {rows.length ? (
                      <>
                        <p className="muted text-xs">
                          {total} graded trade{total === 1 ? "" : "s"} in this cut. Strongest bucket:{" "}
                          <b>{best?.bucket ?? "n/a"}</b> ({dollars(best?.totalDollars)}). Weakest bucket:{" "}
                          <b>{worst?.bucket ?? "n/a"}</b> ({dollars(worst?.totalDollars)}).
                        </p>
                        <table className="mini-table">
                          <thead><tr><th>Bucket</th><th>N</th><th>Win%</th><th>Avg%</th><th>$</th></tr></thead>
                          <tbody>
                            {rows.slice(0, 4).map((b) => (
                              <tr key={b.bucket}>
                                <td>{b.bucket}</td>
                                <td className="num">{b.count}</td>
                                <td className="num">{num(b.winRatePct, "%")}</td>
                                <td className="num">{num(b.avgPnlPct, "%")}</td>
                                <td className={`num ${b.totalDollars >= 0 ? "up" : "dn"}`}>{dollars(b.totalDollars)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </>
                    ) : (
                      <p className="muted text-xs">
                        No filled-and-closed paper trades yet. This cut appears only after real paper outcomes are graded.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="muted text-xs" style={{ marginTop: 10 }}>
              These cuts are for pattern-finding only. They do not place trades, do not change strategy settings, and do not include blocked/refused attempts in win rate.
            </p>
          </Panel>
        ) : null}
        {optionsPerf ? (
          <Panel title="Options performance" meta="Option-contract P&L only — never blended with stock P&L" tip="paperTrading">
            <div className="axiom-strip paper-strip">
              <StatTile label="Open options" value={String(optionsPerf.openCount ?? 0)} hint="live option positions" metric="paperTrading" />
              <StatTile label="Closed options" value={String(optionsPerf.closedCount ?? 0)} hint="terminal option trades" metric="paperTrading" />
              <StatTile label="Contracts traded" value={String(optionsPerf.contractsTraded ?? 0)} hint={`avg ${num(optionsPerf.avgContractsPerTrade, "", 1)}/trade`} metric="paperTrading" />
              <StatTile label="Realized (opt)" value={dollars(optionsPerf.realizedDollars)} hint="option-contract dollars" metric="paperTrading" />
              <StatTile label="Unrealized (opt)" value={dollars(optionsPerf.unrealizedDollars)} hint="open option marks" metric="paperTrading" />
              <StatTile label="Return on premium" value={num(optionsPerf.returnOnPremiumPct, "%")} hint="realized ÷ premium paid" metric="paperTrading" />
              <StatTile label="Win rate" value={num(optionsPerf.winRatePct, "%")} hint="graded option trades" metric="winRate" />
              <StatTile label="Profit factor" value={num(optionsPerf.profitFactor, "", 2)} hint="gross win ÷ loss" metric="profitFactor" />
              <StatTile label="Expectancy" value={dollars(optionsPerf.expectancyDollars)} hint="per option trade" metric="expectancy" />
              <StatTile label="Max drawdown" value={dollars(optionsPerf.maxDrawdownDollars)} hint="option equity curve" metric="maxDrawdown" />
              <StatTile label="Avg winner / loser" value={`${dollars(optionsPerf.avgWinnerDollars)} / ${dollars(optionsPerf.avgLoserDollars)}`} hint="option $" metric="paperTrading" />
              <StatTile label="Avg premium / pos value" value={`${optionsPerf.avgPremiumPaid != null ? fmtPrice(optionsPerf.avgPremiumPaid) : "—"} / ${dollars(optionsPerf.avgPositionValueDollars)}`} hint="per contract / per position" metric="paperTrading" />
              <StatTile label="Slippage / fees" value={`${dollars(optionsPerf.totalSlippageDollars)} / ${dollars(optionsPerf.totalFeesDollars)}`} hint="simulated costs (separate from P&L)" metric="paperTrading" />
            </div>
            <div className="paper-buckets" style={{ marginTop: 12 }}>
              <div className="paper-bucket">
                <h4>CALL vs PUT research</h4>
                <table className="mini-table">
                  <thead><tr><th>Side</th><th>N</th><th>Win%</th><th>$</th><th>RoP%</th></tr></thead>
                  <tbody>
                    {(["call", "put"]).map((side) => {
                      const g = optionsPerf.byType?.[side];
                      return g ? (
                        <tr key={side}>
                          <td>{side.toUpperCase()}</td><td className="num">{g.count}</td>
                          <td className="num">{num(g.winRatePct, "%")}</td>
                          <td className={`num ${g.realizedDollars >= 0 ? "up" : "dn"}`}>{dollars(g.realizedDollars)}</td>
                          <td className="num">{num(g.returnOnPremiumPct, "%")}</td>
                        </tr>
                      ) : null;
                    })}
                  </tbody>
                </table>
              </div>
              <div className="paper-bucket">
                <h4>0DTE vs weekly vs longer</h4>
                <table className="mini-table">
                  <thead><tr><th>Duration</th><th>N</th><th>Win%</th><th>$</th><th>RoP%</th></tr></thead>
                  <tbody>
                    {(["0DTE", "weekly", "longer"]).map((k) => {
                      const g = optionsPerf.byDuration?.[k];
                      return g && g.count ? (
                        <tr key={k}>
                          <td>{k}</td><td className="num">{g.count}</td>
                          <td className="num">{num(g.winRatePct, "%")}</td>
                          <td className={`num ${g.realizedDollars >= 0 ? "up" : "dn"}`}>{dollars(g.realizedDollars)}</td>
                          <td className="num">{num(g.returnOnPremiumPct, "%")}</td>
                        </tr>
                      ) : null;
                    })}
                  </tbody>
                </table>
              </div>
              <div className="paper-bucket">
                <h4>Opportunity vs realized</h4>
                <p className="muted text-xs">
                  Signal HIT &amp; captured: <b>{optionsPerf.opportunity?.hitAndCaptured ?? 0}</b>.
                  Signal correct but exit failed: <b>{optionsPerf.opportunity?.signalHitExitMissed ?? 0}</b>.
                  Signal itself failed: <b>{optionsPerf.opportunity?.signalFailed ?? 0}</b>.
                  <br />(HIT = the contract offered ≥{optionsPerf.opportunity?.thresholdPct ?? 30}% before expiration.)
                </p>
              </div>
              {optionsPerf.byStrategy?.length ? (
                <div className="paper-bucket">
                  <h4>By strategy</h4>
                  <table className="mini-table">
                    <thead><tr><th>Strategy</th><th>N</th><th>Win%</th><th>$</th></tr></thead>
                    <tbody>
                      {optionsPerf.byStrategy.slice(0, 5).map((g: any) => (
                        <tr key={g.strategy}><td>{g.strategy}</td><td className="num">{g.count}</td><td className="num">{num(g.winRatePct, "%")}</td><td className={`num ${g.realizedDollars >= 0 ? "up" : "dn"}`}>{dollars(g.realizedDollars)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              {optionsPerf.byTimeOfDay?.length ? (
                <div className="paper-bucket">
                  <h4>By time of day (entry, ET)</h4>
                  <table className="mini-table">
                    <thead><tr><th>Phase</th><th>N</th><th>Win%</th><th>$</th></tr></thead>
                    <tbody>
                      {optionsPerf.byTimeOfDay.slice(0, 6).map((g: any) => (
                        <tr key={g.phase}><td>{g.phase}</td><td className="num">{g.count}</td><td className="num">{num(g.winRatePct, "%")}</td><td className={`num ${g.realizedDollars >= 0 ? "up" : "dn"}`}>{dollars(g.realizedDollars)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
            <p className="muted text-xs" style={{ marginTop: 10 }}>{optionsPerf.note}</p>
          </Panel>
        ) : null}

        <Panel title="Open trades" meta={`${open.length} active · ~7s marks on hot symbols`} live tip="paperTrading">
          {open.length ? (
            <ul className="ledger axiom-ledger">
              {open.map((t) => (
                <li key={t.id}>
                  <span className="t num">#{t.id}</span>
                  <span className="what">
                    {t.optionSymbol ? (
                      <><b>{t.ticker}</b> ${t.strike} {t.optionType?.toUpperCase()} {t.expiration} × {t.contracts}</>
                    ) : (
                      <><b>{t.ticker}</b> {t.optionType === "put" ? "SHORT" : "LONG"} shares × {t.contracts}</>
                    )}
                    <small>
                      {t.orderState ?? t.status}{t.positionState ? ` · ${t.positionState}` : ""} · entry {t.entryPrice != null ? fmtPrice(t.entryPrice) : `limit ${fmtPrice(t.entryLimit)}`}
                      {t.lastMark != null ? ` · mark ${fmtPrice(t.lastMark)}` : ""}
                      {t.unrealizedPnlDollars != null ? ` · unrealized ${t.unrealizedPnlDollars >= 0 ? "+" : ""}$${Math.abs(t.unrealizedPnlDollars).toFixed(0)} (${t.unrealizedPnlPct > 0 ? "+" : ""}${t.unrealizedPnlPct.toFixed(0)}%)` : ""}
                      {t.status === "ENTERED" && t.mfePct != null ? ` · peak ${t.mfePct.toFixed(0)}% / heat ${t.maePct?.toFixed(0)}%` : ""}
                    </small>
                    {t.entrySnapshot?.delta != null ? (
                      <small className="muted">
                        At entry: Δ {Number(t.entrySnapshot.delta).toFixed(2)}
                        {t.entrySnapshot.iv != null ? ` · IV ${(Number(t.entrySnapshot.iv) * 100).toFixed(0)}%` : ""}
                        {t.entrySnapshot.spreadPct != null ? ` · spread ${Number(t.entrySnapshot.spreadPct).toFixed(1)}%` : ""}
                      </small>
                    ) : null}
                    {t.sizing ? (
                      <small className="muted">
                        Sizing ({t.sizing.profile ?? "manual"}): {t.contracts} contract(s)
                        {t.sizing.bindingConstraint ? ` · binding: ${t.sizing.bindingConstraint}` : ""}
                        {t.sizing.riskBudgetDollars != null ? ` · risk budget $${Number(t.sizing.riskBudgetDollars).toFixed(0)}` : ""}
                        {t.sizing.byRisk != null ? ` · caps[risk ${t.sizing.byRisk}, pos ${t.sizing.byPosition}, exp ${t.sizing.byExposure}, max ${t.sizing.byMaxContracts}]` : ""}
                      </small>
                    ) : null}
                    {t.explanation?.revalidated ? <small className="muted">Revalidation: {t.explanation.revalidated}</small> : null}
                    {t.entryCosts?.slippage != null || t.entryCosts?.fees != null ? (
                      <small className="muted">
                        Fill costs: slippage ${Number(t.entryCosts.slippage ?? 0).toFixed(2)}/unit · fees ${Number(t.entryCosts.fees ?? 0).toFixed(2)}
                        {t.entryCosts.sessionAtEntry ? ` · ${t.entryCosts.sessionAtEntry}` : ""}
                      </small>
                    ) : null}
                    {t.thesis ? <small className="muted">Thesis: {t.thesis.slice(0, 110)}</small> : null}
                  </span>
                  <span className="res">
                    <button className="pill btn btn-xs" disabled={busyId === t.id}
                      onClick={() => act(t.id, t.status === "ENTERED" ? "close" : "cancel")}>
                      {t.status === "ENTERED" ? "Close" : "Cancel"}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ) : <div className="sigwhy muted text-sm">No open paper trades — auto-entry will populate when TRADE callouts fire.</div>}
        </Panel>

        <Panel title="Agent decision log" meta={`${decisions.length} latest · entries, refusals, fills, exits`} tip="paperTrading">
          {decisions.length ? (
            <ul className="ledger axiom-ledger">
              {decisions.slice(0, 16).map((d) => (
                <li key={d.id}>
                  <span className={`t num ${d.allowed ? "up" : "dn"}`}>{d.allowed ? "PASS" : "BLOCK"}</span>
                  <span className="what">
                    <b>{d.ticker ?? "SYSTEM"}</b> {String(d.decision).replaceAll("_", " ")}
                    <small>{d.reason}</small>
                    {d.snapshot?.optionSymbol ? (
                      <small className="muted">
                        Quote: {d.snapshot.optionSymbol} · bid {d.snapshot.bid ?? "—"} · ask {d.snapshot.ask ?? "—"} · spread {d.snapshot.spreadPct ?? "—"}%
                      </small>
                    ) : d.snapshot?.assetClass === "stock" ? (
                      <small className="muted">
                        Stock paper scalp: {d.snapshot.side} × {d.snapshot.shares} @ {d.snapshot.price}
                      </small>
                    ) : d.snapshot?.contracts ? (
                      <small className="muted">
                        Paper option size: {d.snapshot.contracts} contract(s) @ {d.snapshot.entryLimit}
                      </small>
                    ) : d.snapshot?.bindingConstraint ? (
                      <small className="muted">
                        Sizing calc: binding {d.snapshot.bindingConstraint} · risk budget ${Number(d.snapshot.riskBudgetDollars ?? 0).toFixed(0)} · caps[risk {d.snapshot.byRisk}, pos {d.snapshot.byPosition}, exp {d.snapshot.byExposure}]
                      </small>
                    ) : null}
                  </span>
                  <span className="res muted text-xs">{timeAgo(d.createdAtMs)}</span>
                </li>
              ))}
            </ul>
          ) : <div className="sigwhy muted text-sm">No agent decisions logged yet. The first auto-entry, risk refusal, fill, or exit will appear here.</div>}
        </Panel>

        <Panel title="Lifecycle events" meta={`${events.length} latest · immutable, idempotent audit trail`} tip="paperTrading">
          {events.length ? (
            <ul className="ledger axiom-ledger">
              {events.slice(0, 20).map((e) => (
                <li key={e.id}>
                  <span className="t num">#{e.tradeId ?? "—"}</span>
                  <span className="what">
                    <b>{e.ticker ?? "SYSTEM"}</b> {String(e.eventType).replaceAll("_", " ")}
                    {e.fromState || e.toState ? <small className="muted">{e.fromState ?? "—"} → {e.toState ?? "—"}</small> : null}
                    {e.payload?.reason ? <small>{String(e.payload.reason).slice(0, 120)}</small> : null}
                  </span>
                  <span className="res muted text-xs">{timeAgo(e.createdAtMs)}</span>
                </li>
              ))}
            </ul>
          ) : <div className="sigwhy muted text-sm">No lifecycle events yet — candidate/validation/fill/exit events appear here with idempotency keys.</div>}
        </Panel>

        <Panel title="Manual override" meta="Optional — engine runs without this" tip="paperTrading">
          <p className="muted text-xs">Force a paper trade from a recent callout. The risk engine can still refuse.</p>
          {createNote ? <div className="text-sm">{createNote}</div> : null}
          {recentAlerts.length ? (
            <ul className="ledger axiom-ledger">
              {recentAlerts.slice(0, 6).map((a) => (
                <li key={a.id}>
                  <span className="t num">{a.ticker}</span>
                  <span className="what">${a.strike} {String(a.option_side ?? "").toUpperCase()} {a.expiration}
                    <small>setup {Math.round(a.signal_score ?? 0)} · {a.capture_action}</small>
                  </span>
                  <span className="res"><button className="pill btn btn-xs" onClick={() => paperIt(a.id)}>Paper trade it</button></span>
                </li>
              ))}
            </ul>
          ) : <div className="muted text-sm">No recent options callouts with contracts yet today.</div>}
        </Panel>

        <Panel title="Closed trades" meta={`${filledClosed.length} filled · ${blockedAttempts.length} blocked/refused · lessons auto-generated`} tip="paperTrading">
          {closed.length ? (
            <ul className="ledger axiom-ledger">
              {closed.slice(0, 40).map((t) => {
                const stockDir = !t.optionSymbol && t.optionType === "put" ? -1 : 1;
                const multiplier = t.optionSymbol ? 100 : 1;
                const pnl = t.entryPrice != null && t.exitPrice != null
                  ? (t.exitPrice - t.entryPrice) * stockDir * multiplier * (t.contracts ?? 1) : null;
                const pct = t.entryPrice ? ((t.exitPrice - t.entryPrice) * stockDir / t.entryPrice) * 100 : null;
                return (
                  <li key={t.id}>
                    <span className={`t num ${STATE_CLASS[t.status] ?? ""}`}>{t.status}</span>
                    <span className="what">
                      {t.optionSymbol ? (
                        <><b>{t.ticker}</b> ${t.strike} {t.optionType?.toUpperCase()} {t.expiration}</>
                      ) : (
                        <><b>{t.ticker}</b> {t.optionType === "put" ? "SHORT" : "LONG"} shares</>
                      )}
                      <small>{t.closeReason ?? t.exitReason ?? "no exit reason recorded"}</small>
                      {t.explanation?.revalidated && t.entryPrice == null ? <small className="muted">{t.explanation.revalidated}</small> : null}
                      {t.exitCosts?.slippage != null || t.exitCosts?.fees != null ? (
                        <small className="muted">Exit costs: slippage ${Number(t.exitCosts.slippage ?? 0).toFixed(2)}/unit · fees ${Number(t.exitCosts.fees ?? 0).toFixed(2)}</small>
                      ) : null}
                      {t.lessons ? <small className="muted">Lesson: {t.lessons}</small> : null}
                    </span>
                    <span className={`res num ${pnl != null && pnl > 0 ? "pos" : pnl != null ? "neg" : "open"}`}>
                      {pnl != null ? `${pnl > 0 ? "+" : ""}$${Math.abs(pnl).toFixed(0)} (${pct! > 0 ? "+" : ""}${pct!.toFixed(0)}%)` : "—"}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : <div className="sigwhy muted text-sm">Nothing closed yet — exits fire automatically on stops, targets, and thesis breaks.</div>}
        </Panel>

        {data?.buckets ? (
          <Panel title="Bucket detail" meta="Full realized bucket cuts" tip="paperTrading">
            <div className="paper-buckets">
              {BUCKET_LABELS.map(([key, title]) => {
                const rows = data.buckets[key] as BucketRow[] | undefined;
                return (
                <div key={title} className="paper-bucket">
                  <h4>{title}</h4>
                  {rows?.length ? (
                    <table className="mini-table">
                      <thead><tr><th>Bucket</th><th>N</th><th>Win%</th><th>Avg%</th><th>$</th></tr></thead>
                      <tbody>
                        {rows.map((b) => (
                          <tr key={b.bucket}>
                            <td>{b.bucket}</td><td className="num">{b.count}</td>
                            <td className="num">{num(b.winRatePct, "%")}</td>
                            <td className="num">{num(b.avgPnlPct, "%")}</td>
                            <td className={`num ${b.totalDollars >= 0 ? "up" : "dn"}`}>{dollars(b.totalDollars)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : <div className="muted text-xs">no data yet</div>}
                </div>
              );})}
            </div>
          </Panel>
        ) : null}
      </main>
    </div>
  );
}

export default function PaperPage() {
  return (
    <Suspense fallback={null}>
      <PaperPageInner />
    </Suspense>
  );
}
