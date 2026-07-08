"use client";

/**
 * AlertsCommandCenter — the beginner-friendly "what do I do right now" view.
 *
 * One column, top to bottom:
 *   1. Hero card — the single best signal right now (big BUY CALL / BUY PUT,
 *      contract, live speed, Watch chart button).
 *   2. Right-now list — every live candidate in ONE ranked list: trades first,
 *      then setups still forming. SKIP rows are hidden unless asked for.
 *
 * Every verdict is recomputed against the live tape on every poll, so a
 * BUY CALL that stalls downgrades to WAIT in front of you.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { scanHeaders } from "@/hooks/useScanner";
import type { LiveTape, LiveTapeRow } from "@/hooks/useLiveTapeMap";
import { liveCtxFor } from "@/hooks/useLiveTapeMap";
import { TickerIcon } from "@/components/ui";
import { TickerWithSparkline } from "@/components/TickerSparkline";
import { useSparklines } from "@/hooks/useSparklines";
import { TradeVerdictHero } from "@/components/TradeVerdictHero";
import { computeTradeVerdict, frozenCalloutVerdict, MIN_SPEED_PCT_PER_MIN, type TradeVerdict } from "@/lib/trade-verdict";
import { calledAgoLabel, calledAgoLong, calledAgoWithEt, sideFromAlert, stillMovingStatus } from "@/lib/signal-live";
import { fmtPct, fmtPrice, fmtTime, pctClass } from "@/lib/format";
import { sessionGroupLabel } from "@/lib/language-modes";
import { useLanguageMode } from "@/hooks/useLanguageMode";
import { groupAlertsBySession } from "@/lib/alert-session-groups";
import { marketSession, tradingDay } from "@/lib/trading-session";
import { formatOptionsContract, formatCalloutHeadline, isFillableOptionsSetup } from "@/lib/format-contract";
import { isWinnerCandidate } from "@/lib/core-vs-winner";
import { CORE_WATCH } from "@/lib/universe";

const CORE_TICKERS = new Set(CORE_WATCH);

interface Entry {
  symbol: string;
  tapeRow: LiveTapeRow | null;
  alert: any | null;
  verdict: TradeVerdict | null;
  /** 0 = TRADE, 1 = WAIT with contract, 2 = moving but no alert yet, 3 = SKIP/slow */
  rank: number;
}

function alertTimeMs(alert: { alert_time?: string | null } | null | undefined): number {
  if (!alert?.alert_time) return 0;
  const t = Date.parse(alert.alert_time);
  return Number.isFinite(t) ? t : 0;
}

/** Newest callout first; fast movers without a callout sort last. */
function sortEntriesByRecency(a: Entry, b: Entry): number {
  const ta = alertTimeMs(a.alert);
  const tb = alertTimeMs(b.alert);
  if (ta && tb && tb !== ta) return tb - ta;
  if (ta && !tb) return -1;
  if (!ta && tb) return 1;
  const sa = Math.abs(a.tapeRow?.shortRate ?? 0);
  const sb = Math.abs(b.tapeRow?.shortRate ?? 0);
  if (sb !== sa) return sb - sa;
  return a.symbol.localeCompare(b.symbol);
}

function fallbackCalloutLabel(e: Entry): { text: string; cls: string } {
  const d = e.tapeRow?.direction;
  if (d === "bullish") return { text: "▲ Up", cls: "stock-dir-bullish" };
  if (d === "bearish") return { text: "▼ Down", cls: "stock-dir-bearish" };
  return { text: "— Flat", cls: "muted" };
}

function speedText(r: LiveTapeRow | null): string {
  if (r?.shortRate == null) return "—";
  return `${r.shortRate > 0 ? "+" : ""}${r.shortRate.toFixed(2)}%/min`;
}

/** Only alerts from the last few minutes attach to Right now — older ones live in History. */
const RIGHT_NOW_WINDOW_MS = 15 * 60_000;
/** Recent calls strip — session memory for "what was called and is it still moving". */
const RECENT_CALLS_WINDOW_MS = 45 * 60_000;

function isFreshAlert(alert: { alert_time?: string | null }, nowMs = Date.now()): boolean {
  if (!alert?.alert_time) return false;
  const t = Date.parse(alert.alert_time);
  return Number.isFinite(t) && nowMs - t <= RIGHT_NOW_WINDOW_MS;
}

/** Default list: TRADE, forming WAIT with alert, or fast mover with no stale alert. */
function isRightNowEntry(e: Entry): boolean {
  if (e.verdict?.action === "TRADE") return true;
  if (e.verdict?.action === "WAIT" && e.alert) return true;
  const fast = Math.abs(e.tapeRow?.shortRate ?? 0) >= MIN_SPEED_PCT_PER_MIN;
  return fast && !e.alert;
}

export function AlertsCommandCenter({
  tape,
  onOpenChart,
  recentAlerts = [],
  totalAlerts = 0,
  accuracySummary,
  onViewHistory,
}: {
  tape: LiveTape;
  onOpenChart?: (symbol: string) => void;
  recentAlerts?: any[];
  totalAlerts?: number;
  accuracySummary?: any;
  onViewHistory?: () => void;
}) {
  const [session, setSession] = useState<ReturnType<typeof marketSession> | null>(null);
  const languageMode = useLanguageMode();
  const isPublic = languageMode === "public";
  const [showAll, setShowAll] = useState(false);
  const [paused, setPaused] = useState(false);
  const pollInFlight = useRef(false);

  useEffect(() => {
    const update = () => setSession(marketSession());
    update();
    const id = setInterval(update, 60_000);
    return () => clearInterval(id);
  }, []);

  const [alerts, setAlerts] = useState<Map<string, any>>(new Map());
  const [stockAlerts, setStockAlerts] = useState<any[]>([]);
  const [recentCalls, setRecentCalls] = useState<any[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [chartTicker, setChartTicker] = useState("");

  const marketClosed = session === "closed";

  const pollAlerts = useCallback(async () => {
    if (pollInFlight.current) return;
    pollInFlight.current = true;
    try {
      const today = tradingDay();
      const res = await fetch(`/api/alerts?date=${today}&limit=100`, { cache: "no-store", headers: scanHeaders() });
      const d = await res.json();
      const nowMs = Date.now();
      const map = new Map<string, any>();
      const stocks: any[] = [];
      const recent: any[] = [];
      const recentCutoff = nowMs - (marketClosed ? 24 * 60 * 60_000 : RECENT_CALLS_WINDOW_MS);
      for (const a of d.alerts ?? []) {
        const t = Date.parse(a.alert_time ?? "");
        if (Number.isFinite(t) && t >= recentCutoff) recent.push(a);
        if (a.asset_class === "stock") {
          if (a.capture_action === "TRADE" || a.capture_action === "WAIT") stocks.push(a);
          if (a.capture_action === "TRADE" && isFreshAlert(a, nowMs)) {
            const prev = map.get(a.ticker);
            if (!prev || a.id > prev.id) map.set(a.ticker, a);
          }
          continue;
        }
        if (!isFreshAlert(a, nowMs)) continue;
        const prev = map.get(a.ticker);
        if (!prev || a.id > prev.id) map.set(a.ticker, a);
      }
      stocks.sort((a, b) => b.id - a.id);
      setStockAlerts(stocks.slice(0, 12));
      recent.sort((a, b) => b.id - a.id);
      const dedupedRecent: any[] = [];
      const seen = new Set<string>();
      for (const a of recent) {
        if (seen.has(a.ticker)) continue;
        seen.add(a.ticker);
        dedupedRecent.push(a);
      }
      setRecentCalls(dedupedRecent.slice(0, 12));
      setAlerts((prev) => {
        if (prev.size === map.size) {
          let same = true;
          for (const [k, v] of map) {
            const p = prev.get(k);
            if (!p || p.id !== v.id) { same = false; break; }
          }
          if (same) return prev;
        }
        return map;
      });
    } catch { /* best effort */ }
    finally { pollInFlight.current = false; }
  }, [marketClosed]);

  useEffect(() => {
    pollAlerts();
    const id = setInterval(pollAlerts, 1000);
    return () => clearInterval(id);
  }, [pollAlerts]);

  const entries = useMemo<Entry[]>(() => {
    const symbols = new Set<string>([...tape.map.keys(), ...alerts.keys()]);
    const out: Entry[] = [];
    for (const symbol of symbols) {
      const tapeRow = tape.map.get(symbol) ?? null;
      const alert = alerts.get(symbol) ?? null;
      const live = liveCtxFor(tape, symbol);
      const verdict = alert ? frozenCalloutVerdict(alert, live) : null;
      const fast = Math.abs(tapeRow?.shortRate ?? 0) >= MIN_SPEED_PCT_PER_MIN;
      let rank: number;
      if (verdict?.action === "TRADE") rank = 0;
      else if (verdict?.action === "WAIT") rank = 1;
      else if (!verdict && fast) rank = 2;
      else rank = 3;
      out.push({ symbol, tapeRow, alert, verdict, rank });
    }
    out.sort(sortEntriesByRecency);
    return out;
  }, [tape, alerts]);

  const sortedVisible = useMemo(() => {
    const list = showAll ? entries.filter((e) => e.rank < 3) : entries.filter(isRightNowEntry);
    return [...list]
      .filter((e) => {
        if (e.alert?.capture_action === "TRADE") return true;
        if (e.alert?.asset_class === "stock") return true;
        if (isFillableOptionsSetup(e.alert ?? {})) return true;
        if (CORE_TICKERS.has(e.symbol)) return true;
        if (e.tapeRow && isWinnerCandidate(e.tapeRow)) return true;
        return false;
      })
      .sort(sortEntriesByRecency)
      .slice(0, 30);
  }, [entries, showAll]);

  const [pausedSnapshot, setPausedSnapshot] = useState<Entry[] | null>(null);
  const displayEntries = paused && pausedSnapshot ? pausedSnapshot : sortedVisible;
  const sparkSymbols = useMemo(() => displayEntries.map((e) => e.symbol), [displayEntries]);
  const sparklines = useSparklines(sparkSymbols);

  const stockMomentum = useMemo(
    () => stockAlerts.filter((a) => a.capture_action === "TRADE").slice(0, 8),
    [stockAlerts],
  );
  const optionsFillable = useMemo(
    () => entries.filter((e) => e.alert && e.alert.asset_class !== "stock" && isFillableOptionsSetup(e.alert)),
    [entries],
  );

  const hero = useMemo(() => {
    const optionTrades = entries.filter((e) => e.verdict?.action === "TRADE" && e.alert && e.alert.asset_class !== "stock");
    const stockTrades = stockAlerts.filter((a) => a.capture_action === "TRADE");
    const fillableExtra = entries.filter(
      (e) => e.alert
        && e.alert.asset_class !== "stock"
        && isFillableOptionsSetup(e.alert)
        && !optionTrades.some((t) => t.symbol === e.symbol),
    );
    const pool = [...optionTrades, ...fillableExtra];
    pool.sort((a, b) => {
      const ac = CORE_TICKERS.has(a.symbol) ? 1 : 0;
      const bc = CORE_TICKERS.has(b.symbol) ? 1 : 0;
      if (ac !== bc) return bc - ac;
      return sortEntriesByRecency(a, b);
    });
    if (selected) {
      const found = pool.find((e) => e.symbol === selected);
      if (found) return found;
    }
    if (pool[0]) return pool[0];
    if (stockTrades[0]) {
      const sym = stockTrades[0].ticker;
      return {
        symbol: sym,
        tapeRow: tape.map.get(sym) ?? null,
        alert: stockTrades[0],
        verdict: { action: "TRADE", headline: stockTrades[0].private_label ?? "BUY shares", reason: stockTrades[0].ai_explanation ?? "" },
        rank: 0,
      } as Entry;
    }
    return null;
  }, [entries, stockAlerts, selected, tape]);

  function pick(symbol: string) {
    setSelected(symbol);
    onOpenChart?.(symbol);
  }

  const heroLive = hero ? liveCtxFor(tape, hero.symbol) : undefined;
  const heroTape = hero?.tapeRow ?? null;
  const tradeCount =
    entries.filter((e) => e.rank === 0 && e.alert?.asset_class !== "stock").length
    + stockMomentum.length;

  const sessionRecap = useMemo(() => {
    const seen = new Set<string>();
    const out: any[] = [];
    for (const a of recentAlerts) {
      if (seen.has(a.ticker)) continue;
      seen.add(a.ticker);
      out.push(a);
      if (out.length >= 20) break;
    }
    out.sort((a, b) => {
      const ta = Date.parse(a.alert_time ?? "");
      const tb = Date.parse(b.alert_time ?? "");
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
    });
    return out;
  }, [recentAlerts]);

  const hitRatePct = accuracySummary?.overallHitRate != null
    ? Math.round(accuracySummary.overallHitRate * 100)
    : null;

  const tapeMovers = useMemo(() => {
    return [...tape.rows]
      .filter((r) => r?.symbol)
      .sort((a, b) => Math.abs(b.shortRate ?? 0) - Math.abs(a.shortRate ?? 0))
      .slice(0, 10);
  }, [tape.rows]);

  return (
    <section className="panel main section-live">
      <div className="section-header">
        <div>
          <h2 className="section-title">Live callouts</h2>
          <p className="section-sub">
            {isPublic ? "Share momentum + 0DTE call/put when spread is tight." : "BUY LONG/SHORT shares · BUY CALL/PUT when fillable (spread ≤ 5%)."}
          </p>
        </div>
        <div className="status-group">
          <span className={`status-dot ${tape.running ? "live" : ""}`} />
          <span className="status-text">
            {tape.running ? (tradeCount ? `${tradeCount} live trade signal${tradeCount === 1 ? "" : "s"}` : "Watching — no trade yet") : "Scanner offline"}
          </span>
        </div>
      </div>

      <div className="acc-list-header" style={{ marginBottom: 10 }}>
        <span className="muted text-sm">Type a ticker to open its chart anytime.</span>
        <div className="btn-row gap-2 alerts-chart-open" style={{ alignItems: "center" }}>
          <input
            className="input-sm"
            style={{ width: 112 }}
            placeholder="e.g. NVDA"
            value={chartTicker}
            onChange={(e) => setChartTicker(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter" && chartTicker.trim()) pick(chartTicker.trim());
            }}
          />
          <button
            type="button"
            className="pill btn btn-primary btn-xs"
            disabled={!chartTicker.trim()}
            onClick={() => chartTicker.trim() && pick(chartTicker.trim())}
          >
            Open chart
          </button>
        </div>
      </div>

      {/* Hero: the one signal to look at — fixed slot height so the page doesn't jump */}
      <div className="acc-hero-slot">
      {hero?.alert ? (
        <div className="acc-hero">
          <div className="acc-hero-main">
            <div className="acc-hero-symbol">
              <TickerIcon symbol={hero.symbol} />
              <div>
                <div className="tname text-lg">{hero.symbol}</div>
                <div className="tsub">
                  {fmtPrice(heroLive?.price ?? hero.alert.price_at_alert)}
                  {calledAgoWithEt(hero.alert.alert_time) ?? "—"}
                </div>
                {heroTape ? (
                  <div className={`signal-momentum signal-momentum-${stillMovingStatus(sideFromAlert(hero.alert), heroTape).tone} text-xs mt-1`}>
                    {stillMovingStatus(sideFromAlert(hero.alert), heroTape).label}
                  </div>
                ) : null}
              </div>
            </div>
            <TradeVerdictHero alert={hero.alert} live={heroLive} />
            {formatOptionsContract(hero.alert) ? (
              <div className="acc-hero-contract num muted text-sm">{formatOptionsContract(hero.alert)}</div>
            ) : null}
          </div>
          <div className="acc-hero-side">
            <div className="acc-stat">
              <span className="label">Speed now</span>
              <span className={`num ${Math.abs(heroTape?.shortRate ?? 0) >= MIN_SPEED_PCT_PER_MIN ? "fw-strong" : "fw-normal"}`}>
                {speedText(heroTape)}
              </span>
            </div>
            <div className="acc-stat">
              <span className="label">Day move</span>
              <span className={`num ${pctClass(heroTape?.movePct ?? hero.alert.percent_move_at_alert)}`}>
                {fmtPct(heroTape?.movePct ?? hero.alert.percent_move_at_alert)}
              </span>
            </div>
            <div className="acc-stat">
              <span className="label">Volume burst</span>
              <span className="num">{heroTape?.surge != null ? `${heroTape.surge.toFixed(1)}x` : "—"}</span>
            </div>
            <div className="acc-stat">
              <span className="label">VWAP</span>
              <span className="num">
                {heroTape?.vwapDistPct != null
                  ? `${heroTape.vwapDistPct > 0 ? "+" : ""}${heroTape.vwapDistPct.toFixed(2)}%`
                  : heroTape?.aboveVwap == null ? "—" : heroTape.aboveVwap ? "Above" : "Below"}
              </span>
            </div>
            <button className="pill btn btn-primary acc-chart-btn" onClick={() => onOpenChart?.(hero.symbol)}>
              Watch chart
            </button>
          </div>
        </div>
      ) : (
        <div className="empty acc-hero-empty">
          <div className="big">
            {marketClosed
              ? "Market closed — no live callouts"
              : tape.running
                ? "No trade signal right now"
                : "Scanner is off"}
          </div>
          {marketClosed ? (
            <>
              {isPublic ? "Live call/put momentum watches only fire 9:30–4 ET." : "Live BUY CALL/PUT only fires 9:30–4 ET."} Your scanner has logged{" "}
              <strong>{totalAlerts || sessionRecap.length || "—"}</strong> callouts — see recap below or open Accuracy.
            </>
          ) : tape.running ? (
            "That's normal — most of the day is waiting. Names appear below as they start moving."
          ) : (
            "Start the app during market hours to see live signals."
          )}
          {onViewHistory && (totalAlerts > 0 || sessionRecap.length > 0) ? (
            <button type="button" className="pill btn btn-primary" style={{ marginTop: 12 }} onClick={onViewHistory}>
              View accuracy history{hitRatePct != null ? ` (${hitRatePct}% EOD hit rate)` : ""} →
            </button>
          ) : null}
        </div>
      )}
      </div>

      {stockMomentum.length > 0 ? (
        <div className="acc-stock-momentum" style={{ marginBottom: 16 }}>
          <div className="acc-list-header">
            <span className="section-title" style={{ fontSize: 14 }}>
              Share momentum ({stockMomentum.length})
            </span>
            <span className="muted text-sm">BUY LONG/SHORT · in/out on shares</span>
          </div>
          <div className="acc-on-track-chips">
            {stockMomentum.map((a) => {
              const liveRow = tape.map.get(a.ticker);
              const headline = formatCalloutHeadline(a);
              return (
                <button
                  key={a.id}
                  type="button"
                  className={`pill btn acc-on-track-chip${hero?.symbol === a.ticker ? " btn-primary" : ""}`}
                  onClick={() => pick(a.ticker)}
                  title={a.ai_explanation ?? headline}
                >
                  <TickerIcon symbol={a.ticker} />
                  <span className="tname">{a.ticker}</span>
                  <span className={`verdict-pill verdict-trade text-xs`}>{headline}</span>
                  <span className="num">{liveRow?.shortRate != null ? `${liveRow.shortRate > 0 ? "+" : ""}${liveRow.shortRate.toFixed(2)}%/m` : calledAgoLabel(a.alert_time)}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {optionsFillable.length > 0 ? (
        <div className="acc-options-fillable" style={{ marginBottom: 16 }}>
          <div className="acc-list-header">
            <span className="section-title" style={{ fontSize: 14 }}>
              0DTE fillable ({optionsFillable.length})
            </span>
            <span className="muted text-sm">Spread ≤ 5% · score ≥ 82</span>
          </div>
          <div className="acc-on-track-chips">
            {optionsFillable.slice(0, 8).map((e) => {
              const headline = formatCalloutHeadline(e.alert);
              const contract = formatOptionsContract(e.alert);
              return (
                <button
                  key={e.symbol}
                  type="button"
                  className={`pill btn acc-on-track-chip${hero?.symbol === e.symbol ? " btn-primary" : ""}`}
                  onClick={() => pick(e.symbol)}
                  title={e.verdict?.reason ?? contract ?? headline}
                >
                  <TickerIcon symbol={e.symbol} />
                  <span className="tname">{e.symbol}</span>
                  <span className={`verdict-pill verdict-${(e.verdict?.action ?? "wait").toLowerCase()} text-xs`}>{headline}</span>
                  <span className="num muted text-xs">{contract?.split("·").slice(-2).join("·").trim() ?? "—"}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {(marketClosed || !displayEntries.length) && sessionRecap.length > 0 ? (
        <div className="acc-session-recap" style={{ marginTop: marketClosed ? 0 : 16, marginBottom: 16 }}>
          <div className="acc-list-header">
            <span className="section-title" style={{ fontSize: 14 }}>
              {marketClosed ? "Last session" : "Recent callouts"} ({sessionRecap.length}{totalAlerts > sessionRecap.length ? ` of ${totalAlerts}` : ""})
            </span>
            {onViewHistory ? (
              <button type="button" className="pill btn btn-xs" onClick={onViewHistory}>
                Full history →
              </button>
            ) : null}
          </div>
          <p className="muted text-sm" style={{ margin: "0 0 10px" }}>
            {marketClosed
              ? "Like Robinhood's activity feed — what the scanner flagged last, with outcome. Live callouts return at 9:30 ET."
              : "Verdict at alert time. Live list above updates every second during market hours."}
          </p>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th>When</th>
                  <th>Callout</th>
                  <th>Day move</th>
                  <th>Peak move</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sessionRecap.map((a) => {
                  const v = computeTradeVerdict(a);
                  const side = String(a.option_side ?? "").toLowerCase().startsWith("p") ? "PUT" : "CALL";
                  const peak = a.latest_max_move ?? a.eod_move;
                  return (
                    <tr key={a.id} className="clickable" onClick={() => pick(a.ticker)}>
                      <td><div className="tkr"><TickerIcon symbol={a.ticker} /><span className="tname">{a.ticker}</span></div></td>
                      <td className="muted text-xs">{fmtTime(a.alert_time)}</td>
                      <td>
                        <span className={`badge ${v.action === "TRADE" ? (side === "PUT" ? "t-put" : "t-call") : ""}`}>
                          {v.headline}
                        </span>
                      </td>
                      <td className={`num ${pctClass(a.percent_move_at_alert)}`}>{fmtPct(a.percent_move_at_alert)}</td>
                      <td className={`num ${pctClass(peak)}`}>{peak != null ? fmtPct(peak) : "—"}</td>
                      <td className="muted text-xs">{a.status ?? "—"}</td>
                      <td onClick={(ev) => ev.stopPropagation()}>
                        <button type="button" className="pill btn btn-primary btn-xs" onClick={() => pick(a.ticker)}>Chart</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {/* Live callouts + movers — charts work any time */}
      <>
      <div className="acc-list-header">
        <span className="muted text-sm">{isPublic ? "Newest first · momentum watches · mini chart = today" : "Newest first · Callout = BUY / WATCH · mini chart = today"}</span>
        <div className="btn-row gap-2 alerts-list-actions">
          <button
            type="button"
            className={`pill btn btn-xs${paused ? " btn-primary" : ""}`}
            onClick={() => {
              setPaused((v) => {
                const next = !v;
                if (next) setPausedSnapshot(sortedVisible);
                else setPausedSnapshot(null);
                return next;
              });
            }}
            title="Freeze list order while you read"
          >
            {paused ? "▶ Resume" : "⏸ Pause"}
          </button>
          <button className={`pill btn btn-xs${showAll ? " btn-primary" : ""}`} onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Hide WAIT setups" : "Show WAIT setups"}
          </button>
        </div>
      </div>

      <div className="table-area">
      {!displayEntries.length ? (
        <div className="empty small table-empty">
          {tapeMovers.length > 0 ? (
            <>
              <div className="big">No callouts right now — tap a mover for chart</div>
              <div className="acc-on-track-chips" style={{ marginTop: 12, justifyContent: "center" }}>
                {tapeMovers.map((r) => (
                  <button key={r.symbol} type="button" className="pill btn acc-on-track-chip" onClick={() => pick(r.symbol)}>
                    <span className="tname">{r.symbol}</span>
                    <span className="num">{r.shortRate != null ? `${r.shortRate > 0 ? "+" : ""}${r.shortRate.toFixed(2)}%/m` : "—"}</span>
                    <span className="muted">Chart →</span>
                  </button>
                ))}
              </div>
            </>
          ) : marketClosed ? (
            "Nothing live while the market is closed — use Last session above or type a ticker."
          ) : tape.running ? (
            "Nothing live right now — type a ticker above or wait for a mover."
          ) : (
            "Scanner offline — type a ticker above to open chart history."
          )}
        </div>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Ticker</th>
                <th>Callout</th>
                <th>Called</th>
                <th>Speed</th>
                <th>Today</th>
                <th>Contract · spread</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {displayEntries.map((e, i) => {
                const v = e.verdict;
                const fallback = fallbackCalloutLabel(e);
                return (
                  <tr
                    key={e.symbol}
                    className={`clickable${hero?.symbol === e.symbol ? " acc-row-selected" : ""}`}
                    onClick={() => pick(e.symbol)}
                    title="Open chart"
                  >
                    <td className="num muted">{i + 1}</td>
                    <td>
                      <TickerWithSparkline
                        symbol={e.symbol}
                        price={e.tapeRow?.price ?? e.alert?.price_at_alert ?? null}
                        closes={sparklines[e.symbol]}
                        direction={e.tapeRow?.direction}
                      />
                    </td>
                    <td>
                      {v ? (
                        <span className={`verdict-pill verdict-${v.action.toLowerCase()}`} title={v.reason}>
                          {e.alert ? formatCalloutHeadline(e.alert) : v.headline}
                        </span>
                      ) : (
                        <span className={`stock-dir ${fallback.cls}`}>{fallback.text}</span>
                      )}
                    </td>
                    <td className="num muted text-xs">
                      {e.alert ? calledAgoLabel(e.alert.alert_time) ?? "—" : "—"}
                    </td>
                    <td className={`num ${Math.abs(e.tapeRow?.shortRate ?? 0) >= MIN_SPEED_PCT_PER_MIN ? "speed-strong" : "speed-normal"}`}>
                      {speedText(e.tapeRow)}
                    </td>
                    <td className={`num ${pctClass(e.tapeRow?.movePct ?? e.alert?.percent_move_at_alert)}`}>
                      {fmtPct(e.tapeRow?.movePct ?? e.alert?.percent_move_at_alert)}
                    </td>
                    <td className="num muted text-sm">{e.alert ? (formatOptionsContract(e.alert) ?? v?.contractLine ?? "—") : "—"}</td>
                    <td onClick={(ev) => ev.stopPropagation()}>
                      <button type="button" className="pill btn btn-primary btn-xs" onClick={() => pick(e.symbol)}>
                        Chart
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      </div>

      {recentCalls.length > 0 ? (
        <div className="acc-recent-calls">
          <div className="label muted acc-recent-label">
            Called recently (last 45 min) — click to check if still moving
          </div>
          {groupAlertsBySession(recentCalls).map(({ key, items }) => (
            <div key={key} className="alert-session-group">
              <div className="alert-session-divider">
                {sessionGroupLabel(key, items[0]?.asset_class ?? "options")}
              </div>
              <div className="acc-on-track-chips">
                {items.map((a) => {
                  const tapeRow = tape.map.get(a.ticker) ?? null;
                  const side = sideFromAlert(a);
                  const momentum = stillMovingStatus(side, tapeRow);
                  const live = liveCtxFor(tape, a.ticker);
                  const nowVerdict = frozenCalloutVerdict(a, live);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      className="pill btn acc-on-track-chip"
                      onClick={() => pick(a.ticker)}
                      title={nowVerdict.reason}
                    >
                      <span className="tname">{a.ticker}</span>
                      <span className="muted">{calledAgoLabel(a.alert_time)}</span>
                      <span className={`signal-momentum signal-momentum-${momentum.tone}`}>{momentum.label}</span>
                      <span className="muted">{nowVerdict.headline}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      </>
    </section>
  );
}
