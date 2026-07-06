"use client";

/**
 * /alert-lab — Alerts command center.
 *
 * Three tabs, beginner-first:
 *   Right now — one ranked list + hero card with the single best live signal.
 *   History   — KPIs, filters, past alerts (verdict @ alert vs now), weekly report.
 *   Journal   — personal trade log.
 *
 * Market signals and measurements only — nothing here is a recommendation.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { scanHeaders } from "@/hooks/useScanner";
import { useLiveTapeMap, liveCtxFor } from "@/hooks/useLiveTapeMap";
import { AppNav } from "@/components/AppNav";
import { ChartPanel } from "@/components/ChartPanel";
import { AlertsCommandCenter } from "@/components/AlertsCommandCenter";
import { AccuracyCharts } from "@/components/AccuracyCharts";
import { UsageGuide } from "@/components/UsageGuide";
import { computeTradeVerdict, formatSpeedLine } from "@/lib/trade-verdict";
import { calledAgoLabel, sideFromAlert, stillMovingStatus } from "@/lib/signal-live";
import { earlyMoveWin, pickEarlyMove, EARLY_MOVE_WIN_PCT, EARLY_ON_TRACK_MIN_PCT } from "@/lib/early-accuracy";
import { TickerIcon, GradeChip, ScoreBar } from "@/components/ui";
import { changeColor, fmtPct, fmtPrice, fmtTime } from "@/lib/format";

interface AlertRow {
  id: number; ticker: string; source: string; direction: string | null;
  option_symbol: string | null; option_side: string | null; strike: number | null;
  expiration: string | null; dte: number | null; alert_time: string; trading_day: string;
  price_at_alert: number | null; percent_move_at_alert: number | null;
  volume: number | null; relative_volume: number | null;
  catalyst_type: string | null; catalyst_quality: string | null; catalyst_summary: string | null;
  signal_score: number | null; risk_score: number | null; options_liquidity_score: number | null;
  trade_bias?: string | null; option_worth_score?: number | null; worth_verdict?: string | null;
  zero_dte_contract_score?: number | null; move_status?: string | null; risk_flags?: string | null;
  long_call_score?: number | null; long_put_score?: number | null;
  short_rate_at_alert?: number | null; volume_surge_at_alert?: number | null;
  alert_tier?: string | null;
  status: string; is_false_positive: number | null;
  latest_max_move: number | null; eod_move: number | null; trade_taken: number;
}

interface JournalRow {
  id: number; alert_id: number | null; ticker: string; side: string | null;
  entry_price: number | null; exit_price: number | null; quantity: number | null;
  outcome_pct: number | null; notes: string | null; created_at: string;
}

type Tab = "now" | "accuracy" | "history" | "journal";
type AccFilter = "all" | "on_track" | "open" | "discord";

const CATALYSTS = [
  "earnings", "analyst", "fda_biotech", "partnership", "product_launch",
  "legal_regulatory", "macro_sector", "social_momentum", "no_clear_catalyst",
];

const catLabel = (t: string | null) => (t ?? "—").replace(/_/g, " ");

export default function AlertLabPage() {
  const [tab, setTab] = useState<Tab>("now");
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [report, setReport] = useState<any>(null);
  const [accuracy, setAccuracy] = useState<any>(null);
  const [accFilter, setAccFilter] = useState<AccFilter>("all");
  const [journal, setJournal] = useState<JournalRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const tape = useLiveTapeMap(1000);

  // Filters (History tab)
  const [ticker, setTicker] = useState("");
  const [date, setDate] = useState("");
  const [catalyst, setCatalyst] = useState("");
  const [minSignal, setMinSignal] = useState("");
  const [maxRisk, setMaxRisk] = useState("");
  const [fp, setFp] = useState("");
  const [taken, setTaken] = useState("");

  // Journal edit buffers
  const [edits, setEdits] = useState<Record<number, { exitPrice?: string; outcomePct?: string; notes?: string }>>({});

  // Chart panel
  const [chartSymbol, setChartSymbol] = useState<string | null>(null);
  const [chartOpen, setChartOpen] = useState(false);

  const openChart = useCallback((symbol: string) => {
    setChartSymbol(symbol);
    setChartOpen(true);
  }, []);

  const query = useMemo(() => {
    const q = new URLSearchParams();
    if (ticker.trim()) q.set("ticker", ticker.trim().toUpperCase());
    if (date) q.set("date", date);
    if (catalyst) q.set("catalyst", catalyst);
    if (minSignal) q.set("minSignal", minSignal);
    if (maxRisk) q.set("maxRisk", maxRisk);
    if (fp) q.set("falsePositive", fp);
    if (taken) q.set("tradeTaken", taken);
    return q.toString();
  }, [ticker, date, catalyst, minSignal, maxRisk, fp, taken]);

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const headers = scanHeaders();
      const [aRes, sRes, rRes, accRes, jRes] = await Promise.all([
        fetch(`/api/alerts?${query}`, { cache: "no-store", headers }),
        fetch(`/api/alerts/stats`, { cache: "no-store", headers }),
        fetch(`/api/alerts/weekly-report`, { cache: "no-store", headers }),
        fetch(`/api/alerts/signal-accuracy?days=14`, { cache: "no-store", headers }),
        fetch(`/api/trade-journal`, { cache: "no-store", headers }),
      ]);
      const a = await aRes.json();
      const s = await sRes.json();
      const r = await rRes.json();
      const acc = await accRes.json();
      const j = await jRes.json();
      setAlerts(a.alerts ?? []);
      setStats(s.ok ? s : null);
      setReport(r.ok ? r.report : null);
      setAccuracy(acc.ok ? acc : null);
      setJournal(j.journal ?? []);
      setError(a.ok === false ? a.error : s.ok === false ? s.error : null);
    } catch (err: any) {
      setError(err?.message ?? "Failed to load Alert Lab");
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [query]);

  const refreshAccuracy = useCallback(async () => {
    try {
      const acc = await fetch(`/api/alerts/signal-accuracy?days=14`, { cache: "no-store", headers: scanHeaders() }).then((r) => r.json());
      if (acc.ok) setAccuracy(acc);
    } catch { /* best effort */ }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(() => refresh({ silent: true }), 60_000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    if (tab !== "accuracy") return;
    refreshAccuracy();
    const id = setInterval(refreshAccuracy, 1000);
    return () => clearInterval(id);
  }, [tab, refreshAccuracy]);

  async function logTrade(a: AlertRow) {
    await fetch("/api/trade-journal", {
      method: "POST",
      headers: { "content-type": "application/json", ...scanHeaders() },
      body: JSON.stringify({
        alertId: a.id, ticker: a.ticker, side: a.option_side ?? undefined,
        entryPrice: a.price_at_alert ?? undefined, openedAt: new Date().toISOString(),
      }),
    });
    refresh();
  }

  async function saveJournal(j: JournalRow) {
    const e = edits[j.id] ?? {};
    const patch: Record<string, unknown> = {};
    if (e.exitPrice !== undefined && e.exitPrice !== "") patch.exitPrice = Number(e.exitPrice);
    if (e.outcomePct !== undefined && e.outcomePct !== "") patch.outcomePct = Number(e.outcomePct);
    if (e.notes !== undefined) patch.notes = e.notes;
    if (!Object.keys(patch).length) return;
    if (patch.exitPrice != null || patch.outcomePct != null) patch.closedAt = new Date().toISOString();
    await fetch(`/api/trade-journal/${j.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...scanHeaders() },
      body: JSON.stringify(patch),
    });
    setEdits((prev) => ({ ...prev, [j.id]: {} }));
    refresh();
  }

  const totals = stats?.totals;
  const fpRate = totals?.completed ? (totals.false_positives ?? 0) / totals.completed : null;
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = alerts.filter((a) => a.trading_day === today).length;

  const onTrackRows = useMemo(
    () => accuracy?.onTrackNow ?? (accuracy?.recent ?? []).filter((r: any) => r.live_on_track === 1 || r.live_on_track === true),
    [accuracy],
  );

  const filteredAccuracyRows = useMemo(() => {
    const rows = accuracy?.recent ?? [];
    if (accFilter === "on_track") return accuracy?.onTrackNow ?? rows.filter((r: any) => r.live_on_track === 1 || r.live_on_track === true);
    if (accFilter === "open") return rows.filter((r: any) => r.status === "tracking");
    if (accFilter === "discord") return rows.filter((r: any) => r.discord_sent);
    return rows;
  }, [accuracy, accFilter]);

  const accKpi = (id: AccFilter, label: string, val: ReactNode, sub: string) => (
    <button
      type="button"
      className={`kpi kpi-clickable${accFilter === id ? " kpi-active" : ""}`}
      onClick={() => setAccFilter((f) => (f === id ? "all" : id))}
      title={id === "on_track" ? "Click to show only on-track signals" : `Click to filter: ${label}`}
    >
      <div className="label">{label}</div>
      <div className="val num">{val}</div>
      <div className="sub">{sub}{accFilter === id ? " · filtered" : id === "on_track" ? " · click to view" : ""}</div>
    </button>
  );

  const sel = { background: "var(--bg2, #10161d)", color: "var(--txt)", border: "1px solid rgba(120,140,160,.25)", borderRadius: 8, padding: "6px 8px", fontSize: 12 } as const;

  const tabBtn = (id: Tab, label: string) => (
    <button
      type="button"
      className={`pill btn${tab === id ? " btn-primary" : ""}`}
      style={{ fontSize: 13, padding: "7px 16px" }}
      onClick={() => setTab(id)}
    >
      {label}
    </button>
  );

  return (
    <div className="app">
      <AppNav status={[{ label: loading ? "Loading…" : `${alerts.length} alerts` }]} onRefresh={refresh} />

      {error && (
        <div className="kpi" style={{ marginBottom: 16, borderColor: "var(--amber)", background: "rgba(255,176,32,.06)" }}>
          <div className="label" style={{ color: "var(--amber)" }}>Alert Lab unavailable</div>
          <div className="sub">{error} — run <code>npm install</code> (better-sqlite3) and restart.</div>
        </div>
      )}

      <UsageGuide page="alerts" />

      <div className="acc-tabs">
        {tabBtn("now", "Right now")}
        {tabBtn("accuracy", "Accuracy")}
        {tabBtn("history", "History")}
        {tabBtn("journal", "Journal")}
      </div>

      {tab === "now" ? (
        <AlertsCommandCenter tape={tape} onOpenChart={openChart} />
      ) : null}

      {tab === "accuracy" ? (
        <div className="panel main">
          <div className="toolbar">
            <h2>Signal accuracy</h2>
            <div className="right muted" style={{ fontSize: 11 }}>
              Live · updates every second · last {accuracy?.days ?? 14} days
            </div>
          </div>
          {!accuracy ? (
            <div className="empty">Loading accuracy…</div>
          ) : (
            <div style={{ padding: "4px 14px 14px" }}>
              <p className="settings-desc" style={{ marginBottom: 12 }}>
                <strong>Callouts</strong> = every trade-tier BUY CALL/PUT the scanner fired. Live section updates every second;
                final grades lock at market close.
              </p>

              <button
                type="button"
                className={`acc-hero-ratio kpi-clickable${accFilter === "on_track" ? " kpi-active" : ""}`}
                onClick={() => setAccFilter((f) => (f === "on_track" ? "all" : "on_track"))}
                style={{ marginBottom: 14, width: "100%", textAlign: "left" }}
              >
                <div className="label">On track right now</div>
                <div className="acc-hero-ratio-val">
                  <span className="num" style={{ color: (accuracy.todayOnTrack ?? 0) > 0 ? "var(--green)" : undefined }}>
                    {accuracy.liveOnTrackOfToday ?? `${accuracy.todayOnTrack ?? 0} of ${accuracy.todayTotal ?? 0}`}
                  </span>
                  {accuracy.liveOnTrackPct != null ? (
                    <span className="acc-hero-ratio-pct">({Math.round(accuracy.liveOnTrackPct * 100)}% of today&apos;s callouts)</span>
                  ) : null}
                </div>
                <div className="sub">
                  Move within 5 min of call (≥{EARLY_ON_TRACK_MIN_PCT}% favorable) · {accuracy.liveOnTrackOfOpen ?? `${accuracy.todayOnTrack ?? 0} of ${accuracy.todayTracking ?? 0}`} still open
                  {accFilter === "on_track" ? " · filtered" : " · click to view list"}
                </div>
              </button>

              <div className="label muted" style={{ fontSize: 11, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                Live session (updates every second)
              </div>
              <div className="kpis" style={{ marginBottom: 14 }}>
                {accKpi("open", "Callouts today", accuracy.todayTotal ?? accuracy.total, `${accuracy.todayTracking ?? accuracy.tracking} still open`)}
                {accKpi("discord", "Discord sent", accuracy.discordSentCount ?? 0, "extra-clear only · not delayed")}
                <div className="kpi">
                  <div className="label">Completed today</div>
                  <div className="val num">{accuracy.completedToday ?? 0}</div>
                  <div className="sub">final grades at close</div>
                </div>
                <div className="kpi">
                  <div className="label">Avg move @ 5m</div>
                  <div className="val num">
                    {accuracy.avgMove5m != null ? `${accuracy.avgMove5m.toFixed(2)}%` : "—"}
                  </div>
                  <div className="sub">right after the call (today&apos;s graded)</div>
                </div>
              </div>

              {onTrackRows.length > 0 ? (
                <div className="acc-on-track-strip" style={{ marginBottom: 14 }}>
                  <div className="label muted" style={{ fontSize: 11, marginBottom: 8 }}>
                    On track right now — click a ticker to open chart
                  </div>
                  <div className="acc-on-track-chips">
                    {onTrackRows.map((row: any) => {
                      const side = String(row.option_side ?? "").toLowerCase().startsWith("p") ? "PUT" : "CALL";
                      return (
                        <button
                          key={row.id}
                          type="button"
                          className="pill btn acc-on-track-chip"
                          onClick={() => openChart(row.ticker)}
                        >
                          <span className="tname">{row.ticker}</span>
                          <span className="muted">{calledAgoLabel(row.alert_time) ?? fmtTime(row.alert_time)}</span>
                          <span className="muted">BUY {side}</span>
                          <span className="num" style={{ color: "var(--green)" }}>
                            {fmtPct(row.move_5m ?? row.move_1m ?? row.latest_max_move)}
                          </span>
                          <span className="muted" style={{ fontSize: 10 }}>
                            {row.move_5m != null ? "@ 5m" : row.move_1m != null ? "@ 1m" : "peak"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              <AccuracyCharts
                data={{
                  todayOnTrack: accuracy.todayOnTrack,
                  todayTotal: accuracy.todayTotal,
                  liveOnTrackPct: accuracy.liveOnTrackPct,
                  earlyOnTrackMinPct: accuracy.earlyOnTrackMinPct ?? EARLY_ON_TRACK_MIN_PCT,
                  avgMove5m: accuracy.avgMove5m,
                  overallHitRate: accuracy.overallHitRate ?? accuracy.hitRate,
                  dailyTrend: accuracy.dailyTrend,
                  bySide: accuracy.bySide,
                }}
              />

              <div className="label muted" style={{ fontSize: 11, margin: "16px 0 6px", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                Final grades (locks at market close)
              </div>
              <div className="kpis" style={{ marginBottom: 14 }}>
                <div className="kpi">
                  <div className="label">Early hit rate (5m) — all callouts</div>
                  <div className="val num">
                    {accuracy.earlyHitRate != null ? `${Math.round(accuracy.earlyHitRate * 100)}%` : "—"}
                  </div>
                  <div className="sub">
                    {accuracy.earlyGraded
                      ? `${accuracy.earlyWins} right · ${accuracy.earlyLosses} wrong @ 5m (≥${EARLY_MOVE_WIN_PCT}%)`
                      : "grades when 5m checkpoint records"}
                  </div>
                </div>
                <div className="kpi">
                  <div className="label">Early hit rate — TRADE at fire</div>
                  <div className="val num" style={{ color: (accuracy.tradeCaptureEarlyHitRate ?? 0) >= 0.7 ? "var(--green)" : undefined }}>
                    {accuracy.tradeCaptureEarlyHitRate != null
                      ? `${Math.round(accuracy.tradeCaptureEarlyHitRate * 100)}%`
                      : "—"}
                  </div>
                  <div className="sub">
                    {accuracy.tradeCaptureEarlyGraded
                      ? `${accuracy.tradeCaptureEarlyWins} right · ${accuracy.tradeCaptureEarlyLosses} wrong · ${accuracy.tradeCaptureTotal} TRADE at capture`
                      : "BUY gates passed when signal fired"}
                  </div>
                </div>
                <div className="kpi">
                  <div className="label">Stock hit rate (EOD)</div>
                  <div className="val num">
                    {accuracy.hitRate != null ? `${Math.round(accuracy.hitRate * 100)}%` : "—"}
                  </div>
                  <div className="sub">
                    {accuracy.wins + accuracy.losses > 0
                      ? `${accuracy.wins} right · ${accuracy.losses} wrong`
                      : `${accuracy.tracking} still tracking — grades at close`}
                  </div>
                </div>
                <div className="kpi">
                  <div className="label">Option win rate</div>
                  <div className="val num">
                    {accuracy.optionWinRate != null ? `${Math.round(accuracy.optionWinRate * 100)}%` : "—"}
                  </div>
                  <div className="sub">
                    {accuracy.optionWins || accuracy.optionLosses
                      ? `${accuracy.optionWins} up ≥15% · ${accuracy.optionLosses} not`
                      : "contract mid gain ≥15% · grades at close"}
                  </div>
                </div>
                <div className="kpi">
                  <div className="label">Avg option return</div>
                  <div className="val num" style={{ color: changeColor(accuracy.avgOptionReturn) }}>
                    {accuracy.avgOptionReturn != null ? `${accuracy.avgOptionReturn.toFixed(0)}%` : "—"}
                  </div>
                  <div className="sub">entry mid → best mid (final at close)</div>
                </div>
                <div className="kpi">
                  <div className="label">Avg best stock move</div>
                  <div className="val num">
                    {accuracy.avgMaxMove != null ? `${accuracy.avgMaxMove.toFixed(1)}%` : "—"}
                  </div>
                  <div className="sub">favorable direction after signal (EOD)</div>
                </div>
              </div>

              <div className="label muted" style={{ fontSize: 11, margin: "16px 0 6px", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                All callouts
              </div>
              {!filteredAccuracyRows.length ? (
                <div className="empty small">
                  {accFilter === "on_track"
                    ? "No callouts on track yet — need ≥0.5% favorable move within 5 min of call."
                    : accFilter !== "all"
                      ? "No signals match this filter."
                      : "No trade-tier signals recorded yet this period."}
                </div>
              ) : (
                <div className="tablewrap">
                  <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
                    {accFilter === "on_track"
                      ? `Showing ${filteredAccuracyRows.length} on-track signal${filteredAccuracyRows.length === 1 ? "" : "s"}`
                      : accFilter === "open"
                        ? `Showing ${filteredAccuracyRows.length} open signal${filteredAccuracyRows.length === 1 ? "" : "s"}`
                        : accFilter === "discord"
                          ? `Showing ${filteredAccuracyRows.length} Discord-sent signal${filteredAccuracyRows.length === 1 ? "" : "s"}`
                          : `All signals · click a row to open chart`}
                    {accFilter !== "all" ? (
                      <button type="button" className="pill btn" style={{ fontSize: 10, padding: "2px 8px", marginLeft: 8 }} onClick={() => setAccFilter("all")}>
                        Clear filter
                      </button>
                    ) : null}
                  </div>
                  <table>
                    <thead>
                      <tr>
                        <th>Called</th>
                        <th>Ticker</th>
                        <th>Signal</th>
                        <th>Momentum</th>
                        <th>Speed @ fire</th>
                        <th>Move @ 1m</th>
                        <th>Move @ 5m</th>
                        <th>Peak move</th>
                        <th>Option entry → best</th>
                        <th>Option %</th>
                        <th>Stock</th>
                        <th>Option</th>
                        <th>Discord</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredAccuracyRows.map((row: any) => {
                        const side = String(row.option_side ?? "").toLowerCase().startsWith("p") ? "PUT" : "CALL";
                        const done = row.status === "complete";
                        const win = done && row.is_false_positive === 0;
                        const loss = done && row.is_false_positive === 1;
                        const onTrack = row.live_on_track === 1 || row.live_on_track === true;
                        const earlyWin = earlyMoveWin(row.move_5m);
                        const early = pickEarlyMove(row);
                        const liveOptionPct =
                          row.option_return_pct ?? (row.entry_mid && row.best_mid
                            ? +(((row.best_mid - row.entry_mid) / row.entry_mid) * 100).toFixed(1)
                            : null);
                        const optionDone = row.option_outcome_win != null;
                        const tapeRow = tape.map.get(row.ticker);
                        const momentum = stillMovingStatus(side, tapeRow);
                        return (
                          <tr key={row.id} className={`clickable${onTrack ? " acc-row-on-track" : ""}`} onClick={() => openChart(row.ticker)}>
                            <td className="num muted">
                              {calledAgoLabel(row.alert_time) ?? "—"}
                              <br />
                              <span style={{ fontSize: 10 }}>{fmtTime(row.alert_time)}</span>
                            </td>
                            <td>
                              <div className="tkr">
                                <TickerIcon symbol={row.ticker} />
                                <div>
                                  <div className="tname">{row.ticker}</div>
                                  <div className="tsub">{row.strike ? `$${row.strike}${side[0]} · ${row.dte ?? 0}DTE` : "—"}</div>
                                </div>
                              </div>
                            </td>
                            <td>
                              <span className={`verdict-pill verdict-trade`}>BUY {side}</span>
                            </td>
                            <td>
                              {!done ? (
                                <span className={`signal-momentum signal-momentum-${momentum.tone}`}>{momentum.label}</span>
                              ) : (
                                <span className="muted">closed</span>
                              )}
                            </td>
                            <td className="num muted">
                              {row.short_rate_at_alert != null
                                ? `${row.short_rate_at_alert > 0 ? "+" : ""}${row.short_rate_at_alert.toFixed(2)}%/m`
                                : "—"}
                            </td>
                            <td className="num" style={{ color: changeColor(row.move_1m) }}>
                              {row.move_1m != null ? fmtPct(row.move_1m) : <span className="muted">pending</span>}
                            </td>
                            <td className="num" style={{ color: changeColor(row.move_5m) }}>
                              {row.move_5m != null ? fmtPct(row.move_5m) : <span className="muted">pending</span>}
                            </td>
                            <td className="num muted" style={{ fontSize: 11 }}>
                              {fmtPct(row.latest_max_move)}
                            </td>
                            <td className="num muted" style={{ fontSize: 11 }}>
                              {row.entry_mid != null
                                ? `$${row.entry_mid.toFixed(2)} → ${row.best_mid != null ? `$${row.best_mid.toFixed(2)}` : "…"}`
                                : "—"}
                            </td>
                            <td className="num" style={{ color: changeColor(liveOptionPct) }}>
                              {liveOptionPct != null ? `${liveOptionPct > 0 ? "+" : ""}${liveOptionPct.toFixed(0)}%` : "—"}
                            </td>
                            <td>
                              {!done ? (
                                onTrack
                                  ? <span className="tag t-call" title={early ? `@ ${early.checkpoint}` : ""}>ON TRACK</span>
                                  : early?.move != null
                                    ? <span className="tag t-vol">@{early.checkpoint} {fmtPct(early.move)}</span>
                                    : <span className="tag t-vol">WAIT 5m</span>
                              )
                                : earlyWin === true ? <span className="tag t-call">RIGHT @5m</span>
                                : earlyWin === false ? <span className="tag t-put">WRONG @5m</span>
                                : win ? <span className="tag t-call">RIGHT EOD</span>
                                : loss ? <span className="tag t-put">WRONG EOD</span>
                                : <span className="muted">—</span>}
                            </td>
                            <td>
                              {optionDone
                                ? (row.option_outcome_win === 1
                                  ? <span className="tag t-call">WIN</span>
                                  : <span className="tag t-put">LOSS</span>)
                                : liveOptionPct != null
                                  ? <span className="tag t-vol">LIVE</span>
                                  : <span className="muted">—</span>}
                            </td>
                            <td>
                              {row.discord_sent ? (
                                <span className="tag t-call" title="Sent instantly when signal cleared the Discord bar">SENT</span>
                              ) : row.discord_status === "skipped" ? (
                                <span className="tag t-vol" title={row.discord_note ?? "Below Discord bar"}>SKIP</span>
                              ) : row.discord_status === "failed" ? (
                                <span className="tag t-put" title={row.discord_note ?? "Send failed"}>FAIL</span>
                              ) : (
                                <span className="muted" title="Did not clear extra-clear bar">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      ) : null}

      {tab === "history" ? (
        <>
          <div className="kpis" style={{ marginBottom: 14 }}>
            <div className="kpi"><div className="label">Alerts today</div><div className="val num">{todayCount}</div><div className="sub">{totals?.total ?? 0} all-time</div></div>
            <div className="kpi"><div className="label">Avg signal score</div><div className="val num">{totals?.avg_signal != null ? Math.round(totals.avg_signal) : "—"}</div><div className="sub">risk {totals?.avg_risk != null ? Math.round(totals.avg_risk) : "—"} · liq {totals?.avg_liquidity != null ? Math.round(totals.avg_liquidity) : "—"}</div></div>
            <div className="kpi"><div className="label">Avg max move after alert</div><div className="val num">{stats?.avgMove?.avg_max_move != null ? `${stats.avgMove.avg_max_move.toFixed(1)}%` : "—"}</div><div className="sub">best move in your direction</div></div>
            <div className="kpi"><div className="label">False-positive rate</div><div className="val num">{fpRate != null ? `${Math.round(fpRate * 100)}%` : "—"}</div><div className="sub">{totals?.completed ?? 0} finished alerts</div></div>
            <div className="kpi"><div className="label">Best setup type</div><div className="val" style={{ fontSize: 15 }}>{catLabel(stats?.byCatalyst?.[0]?.type ?? null)}</div><div className="sub">{stats?.byCatalyst?.[0]?.avg_max_move != null ? `${stats.byCatalyst[0].avg_max_move.toFixed(1)}% avg max move` : "shows once alerts finish"}</div></div>
          </div>

          <div className="panel main" style={{ marginBottom: 14 }}>
            <div className="toolbar">
              <h2>Alert history</h2>
              <div className="chips">
                <input style={sel} placeholder="Ticker" value={ticker} onChange={(e) => setTicker(e.target.value)} />
                <input style={sel} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                <select style={sel} value={catalyst} onChange={(e) => setCatalyst(e.target.value)}>
                  <option value="">Catalyst: any</option>
                  {CATALYSTS.map((c) => <option key={c} value={c}>{catLabel(c)}</option>)}
                </select>
                <select style={sel} value={minSignal} onChange={(e) => setMinSignal(e.target.value)}>
                  <option value="">Signal: any</option><option value="50">≥ 50</option><option value="65">≥ 65</option><option value="80">≥ 80</option>
                </select>
                <select style={sel} value={maxRisk} onChange={(e) => setMaxRisk(e.target.value)}>
                  <option value="">Risk: any</option><option value="30">≤ 30</option><option value="50">≤ 50</option><option value="70">≤ 70</option>
                </select>
                <select style={sel} value={fp} onChange={(e) => setFp(e.target.value)}>
                  <option value="">FP: any</option><option value="1">False positives</option><option value="0">Valid / pending</option>
                </select>
                <select style={sel} value={taken} onChange={(e) => setTaken(e.target.value)}>
                  <option value="">Journal: any</option><option value="1">Logged</option><option value="0">Not logged</option>
                </select>
              </div>
            </div>

            {!alerts.length ? (
              <div className="empty">
                <div className="big">No alerts yet</div>
                Alerts land here on their own once the scanner catches a strong momentum setup.
              </div>
            ) : (
              <div className="tablewrap">
                <table>
                  <thead>
                    <tr>
                      <th>Time</th><th>Ticker</th><th>@ alert</th><th>Now</th><th>Speed @ alert</th><th>Day move @ alert</th><th>Signal</th><th>Status</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {alerts.map((a) => {
                      const atAlert = computeTradeVerdict(a);
                      const live = liveCtxFor(tape, a.ticker);
                      const now = live ? computeTradeVerdict(a, live) : null;
                      return (
                        <tr
                          key={a.id}
                          className="clickable"
                          onClick={() => openChart(a.ticker)}
                          title="Click row to open chart"
                        >
                          <td className="num muted">{a.trading_day}<br />{fmtTime(a.alert_time)}</td>
                          <td>
                            <div className="tkr">
                              <TickerIcon symbol={a.ticker} />
                              <div>
                                <div className="tname">{a.ticker}</div>
                                <div className="tsub">
                                  {a.option_symbol ? `${a.strike ?? ""}${String(a.option_side ?? "").toUpperCase().slice(0, 1)} · ${a.dte ?? "—"} DTE` : fmtPrice(a.price_at_alert)}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td>
                            <span className={`verdict-pill verdict-${atAlert.action.toLowerCase()}`} title={atAlert.reason}>{atAlert.headline}</span>
                          </td>
                          <td>
                            {now ? (
                              <span className={`verdict-pill verdict-${now.action.toLowerCase()}`} title={now.reason}>{now.headline}</span>
                            ) : (
                              <span className="muted" style={{ fontSize: 11 }}>not live</span>
                            )}
                          </td>
                          <td className="num muted" style={{ fontSize: 11, maxWidth: 120 }}>{formatSpeedLine(a)}</td>
                          <td className="num" style={{ color: changeColor(a.percent_move_at_alert) }}>{fmtPct(a.percent_move_at_alert)}</td>
                          <td><ScoreBar score={a.signal_score ?? 0} /></td>
                          <td>
                            {a.is_false_positive === 1 ? <span className="tag t-put">FALSE +</span>
                              : a.status === "complete" ? <GradeChip grade="GOOD" />
                              : <span className="tag t-vol">TRACKING</span>}
                          </td>
                          <td onClick={(e) => e.stopPropagation()}>
                            <button
                              className="pill btn btn-primary"
                              style={{ fontSize: 11, padding: "4px 10px", marginRight: 4 }}
                              onClick={() => openChart(a.ticker)}
                            >
                              Chart
                            </button>
                            {a.trade_taken ? <span className="tag t-call">LOGGED</span>
                              : <button className="pill btn" style={{ fontSize: 11, padding: "4px 8px" }} onClick={() => logTrade(a)}>Log</button>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="panel main">
            <div className="toolbar"><h2>Weekly report</h2><div className="right muted" style={{ fontSize: 11 }}>{report?.since ? `since ${report.since}` : ""}</div></div>
            {!report ? (
              <div className="empty">No report yet.</div>
            ) : (
              <div style={{ padding: "4px 14px 14px", fontSize: 13, lineHeight: 1.7 }}>
                <div className="statgrid" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 10 }}>
                  <div className="kpi"><div className="label">Alerts</div><div className="val num">{report.totalAlerts}</div></div>
                  <div className="kpi"><div className="label">Avg signal</div><div className="val num">{report.avgSignalScore != null ? Math.round(report.avgSignalScore) : "—"}</div></div>
                  <div className="kpi"><div className="label">Avg max move</div><div className="val num">{report.avgMaxMoveAfterAlert != null ? `${report.avgMaxMoveAfterAlert.toFixed(1)}%` : "—"}</div></div>
                  <div className="kpi"><div className="label">FP rate</div><div className="val num">{report.falsePositiveRate != null ? `${Math.round(report.falsePositiveRate * 100)}%` : "—"}</div></div>
                  <div className="kpi"><div className="label">Best catalyst</div><div className="val" style={{ fontSize: 13 }}>{catLabel(report.bestCatalystType?.type ?? null)}</div></div>
                  <div className="kpi"><div className="label">Journal win rate</div><div className="val num">{report.journalWinRate != null ? `${Math.round(report.journalWinRate * 100)}%` : "—"}</div></div>
                </div>
                <h4 style={{ margin: "10px 0 4px" }}>Biggest measured moves without a journal entry</h4>
                {!report.missedOpportunities?.length ? <div className="muted">None yet — needs completed alerts.</div> :
                  report.missedOpportunities.map((m: any) => (
                    <div key={m.id}>
                      <span className="num">{m.ticker}</span> <span className="muted">{m.trading_day} · {catLabel(m.catalyst_type)}</span>
                      <span className="num" style={{ float: "right", color: "var(--green)" }}>{fmtPct(m.max_move)}</span>
                    </div>
                  ))}
                <h4 style={{ margin: "12px 0 4px" }}>Highest-quality alerts</h4>
                {!report.topQualityAlerts?.length ? <div className="muted">None yet.</div> :
                  report.topQualityAlerts.map((m: any) => (
                    <div key={m.id}>
                      <span className="num">{m.ticker}</span> <span className="muted">{m.trading_day} · signal {Math.round(m.signal_score ?? 0)} · {catLabel(m.catalyst_type)}</span>
                      <span className="num" style={{ float: "right", color: changeColor(m.max_move) }}>{fmtPct(m.max_move)}</span>
                    </div>
                  ))}
                <div className="muted" style={{ marginTop: 10, fontSize: 11 }}>
                  Measurements of scanner output for research — max move is the best favorable print after an alert, not a realized result. Not financial advice.
                </div>
              </div>
            )}
          </div>
        </>
      ) : null}

      {tab === "journal" ? (
        <div className="panel main">
          <div className="toolbar"><h2>Trade journal</h2><div className="right muted" style={{ fontSize: 11 }}>{journal.length} entries</div></div>
          {!journal.length ? (
            <div className="empty">
              <div className="big">No journal entries.</div>
              Click “Log” on an alert (History tab) to start a personal record. This is a private log — not advice.
            </div>
          ) : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr><th>Ticker</th><th>Side</th><th>Entry</th><th>Exit</th><th>Outcome %</th><th>Notes</th><th></th></tr>
                </thead>
                <tbody>
                  {journal.map((j) => (
                    <tr key={j.id}>
                      <td><div className="tkr"><TickerIcon symbol={j.ticker} /><div><div className="tname">{j.ticker}</div><div className="tsub">{fmtTime(j.created_at)}</div></div></div></td>
                      <td>{j.side ? <span className={`badge ${j.side === "put" ? "t-put" : "t-call"}`}>{String(j.side).toUpperCase()}</span> : "—"}</td>
                      <td className="num">{fmtPrice(j.entry_price)}</td>
                      <td>
                        <input style={{ ...sel, width: 70 }} placeholder={j.exit_price != null ? String(j.exit_price) : "—"}
                          value={edits[j.id]?.exitPrice ?? ""}
                          onChange={(e) => setEdits((p) => ({ ...p, [j.id]: { ...p[j.id], exitPrice: e.target.value } }))} />
                      </td>
                      <td>
                        <input style={{ ...sel, width: 70 }} placeholder={j.outcome_pct != null ? `${j.outcome_pct}%` : "—"}
                          value={edits[j.id]?.outcomePct ?? ""}
                          onChange={(e) => setEdits((p) => ({ ...p, [j.id]: { ...p[j.id], outcomePct: e.target.value } }))} />
                      </td>
                      <td>
                        <input style={{ ...sel, width: 140 }} placeholder={j.notes ?? "notes"}
                          value={edits[j.id]?.notes ?? ""}
                          onChange={(e) => setEdits((p) => ({ ...p, [j.id]: { ...p[j.id], notes: e.target.value } }))} />
                      </td>
                      <td><button className="pill btn" style={{ fontSize: 11, padding: "4px 8px" }} onClick={() => saveJournal(j)}>Save</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      <ChartPanel symbol={chartSymbol} open={chartOpen} onClose={() => setChartOpen(false)} />

      <div className="footer">
        Alert Lab · records and measures scanner alerts for research · no order placement, no recommendations · not financial advice
      </div>
    </div>
  );
}
