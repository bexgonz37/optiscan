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

import { useCallback, useEffect, useMemo, useState } from "react";
import { scanHeaders } from "@/hooks/useScanner";
import { useLiveTapeMap, liveCtxFor } from "@/hooks/useLiveTapeMap";
import { AppNav } from "@/components/AppNav";
import { ChartPanel } from "@/components/ChartPanel";
import { AlertsCommandCenter } from "@/components/AlertsCommandCenter";
import { UsageGuide } from "@/components/UsageGuide";
import { computeTradeVerdict, formatSpeedLine } from "@/lib/trade-verdict";
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

type Tab = "now" | "history" | "journal";

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

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const headers = scanHeaders();
      const [aRes, sRes, rRes, jRes] = await Promise.all([
        fetch(`/api/alerts?${query}`, { cache: "no-store", headers }),
        fetch(`/api/alerts/stats`, { cache: "no-store", headers }),
        fetch(`/api/alerts/weekly-report`, { cache: "no-store", headers }),
        fetch(`/api/trade-journal`, { cache: "no-store", headers }),
      ]);
      const a = await aRes.json();
      const s = await sRes.json();
      const r = await rRes.json();
      const j = await jRes.json();
      setAlerts(a.alerts ?? []);
      setStats(s.ok ? s : null);
      setReport(r.ok ? r.report : null);
      setJournal(j.journal ?? []);
      setError(a.ok === false ? a.error : s.ok === false ? s.error : null);
    } catch (err: any) {
      setError(err?.message ?? "Failed to load Alert Lab");
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
  }, [refresh]);

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
        {tabBtn("history", "History")}
        {tabBtn("journal", "Journal")}
      </div>

      {tab === "now" ? (
        <AlertsCommandCenter tape={tape} onOpenChart={openChart} />
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
